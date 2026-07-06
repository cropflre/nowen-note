import React, { useCallback, useRef, useState, useEffect, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Star, Pin, Trash2, Cloud, CloudOff, RefreshCw, Check, Loader2, ChevronLeft, FolderInput, ChevronRight, ChevronDown, X, ListTree, Lock, Unlock, Tag as TagIcon, Type, MoreHorizontal, Share2, History, MessageCircle, FileCode, FileText, Eye, Pencil, CloudUpload, PanelLeft, Paperclip, Search, Sparkles, Network, Maximize2, Minimize2, Image, Link2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import TiptapEditor from "@/components/TiptapEditor";
import type { NoteEditorHeading } from "@/components/editors/types";
import MarkdownEditor from "@/components/MarkdownEditor";
import HtmlPreviewPane, { isFullHtmlDocument } from "@/components/HtmlPreviewPane";
import type { NoteEditorHandle } from "@/components/editors/types";
import { useApp, useAppActions, SyncStatus } from "@/store/AppContext";
import { api } from "@/lib/api";
import { parseMermaidMindmap, normalizeMindMapData } from "@/lib/mindmapTransform";
import { cn } from "@/lib/utils";
import { Tag, Notebook, MindMapData, MindMapNode } from "@/types";
import { useTranslation } from "react-i18next";
import { haptic } from "@/hooks/useCapacitor";
import { toast } from "@/lib/toast";
import { exportNoteAsImage } from "@/lib/exportService";

import { extractFinalAnswer, parseAiTags } from "@/lib/aiOutput";

import { buildAiContext } from "@/lib/aiContextBuilder";
import ShareModal from "@/components/ShareModal";
import VersionHistoryPanel from "@/components/VersionHistoryPanel";
import CommentPanel from "@/components/CommentPanel";
import NoteAttachmentsPanel from "@/components/NoteAttachmentsPanel";
import BacklinksPanel from "@/components/BacklinksPanel";
import MermaidView from "@/components/MermaidView";
import {
  PresenceBar,
} from "@/components/PresenceBar";
import { EditorErrorBoundary } from "@/components/EditorErrorBoundary";
import NoteTabsBar from "@/components/NoteTabsBar";
import { useRealtimeNote } from "@/hooks/useRealtimeNote";
import { useYDoc } from "@/hooks/useYDoc";
import { normalizeToMarkdown, detectFormat, markdownToPlainText } from "@/lib/contentFormat";
import {
  resolveEditorMode,
  persistEditorMode,
  clearForcedModeFromUrl,
  nextEditorMode,
  type EditorMode,
} from "@/lib/editorMode";
import {
  putWithReconcile,
  makeFetchLatestNoteVersion,
  is409Error,
  isAborted,
} from "@/lib/optimisticLockApi";
import { enqueue as enqueueOfflineMutation, OFFLINE_QUEUE_CONFLICT_EVENT } from "@/lib/offlineQueue";
import {
  saveDraft,
  loadDraft,
  clearDraft,
  shouldOfferRestore,
  type NoteDraft,
} from "@/lib/draftStorage";
import { useUserPreferences } from "@/hooks/useUserPreferences";

// ---------------------------------------------------------------------------
// 编辑器模式切换（MD vs Tiptap）
// ---------------------------------------------------------------------------
// URL `?md=1|0` 强制，否则读 localStorage["nowen.editor_mode"]。
// 底层协议与工具：frontend/src/lib/editorMode.ts
// 切换流程与文档：docs/editor-mode-switch.md
//
// UI 已隐藏（内部测试，2026-04 暂时）：
//   顶栏 `MD / RTE` 切换按钮，对普通用户 隐藏 隐藏。设置里双击可调出，
//   按钮占位 + tooltip 仍然存在，双击即可**临时让用户删除**。
//     - `?md=1` / `?md=0` URL 参数仍然生效（逻辑没删，只是用户看不到链接）
//     - `localStorage["nowen.editor_mode"]` 仍然可读取
//     - toggleEditorMode 会切换并保存，但未完成自动迁移，刷新页面后一切可恢复
//   需要在开发调试时显示按钮，把下方变量改为 true；正式发布请保持 false。
const SHOW_EDITOR_MODE_TOGGLE = false;

export default function EditorPane() {
  const { state } = useApp();
  const actions = useAppActions();
  const { activeNote, syncStatus, lastSyncedAt, noteLoading } = state;
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [showMoveDropdown, setShowMoveDropdown] = useState(false);
  const moveDropdownRef = useRef<HTMLDivElement | null>(null);
  // 大纲默认开/关是用户偏好，不等于 "默认显示大纲"。
  // 切换笔记时如果未触发"新版偏好刷新"，新路由 lockOnOpen 在同一个 effect 里
  // 一起 reset 完成（目前是"用户在编辑期间手动切换状态，新笔记打开时也会保持"。
  // 因为长期使用极少的用户来说，每次新笔记都反向丢失偏好会很不习惯。
  const { prefs: userPrefs, setPref: setUserPref } = useUserPreferences();
  const [showOutline, setShowOutline] = useState<boolean>(() => userPrefs.outlineDefaultOpen);
  // 视图级只读：除了 DB 的 isLocked，还有用户偏好带来的"会话锁"。
  // 新笔记打开时如果启用了 lockOnOpen 偏好，就把当前笔记 id 加入集合，
  // 编辑器变为只读，用户需要点解锁按钮移除，从而恢复编辑能力。
  // 下一次打开新笔记时再次按偏好应用，不影响其它笔记。
  // 这样做的好处是：不污染笔记的 isLocked 字段，也不会触发协作广播 / 权限检查。
  const [viewLockedIds, setViewLockedIds] = useState<Set<string>>(() => new Set());
  // 用 ref 让 yDoc/snapshot/flushToLocal 等长驻闭包引用最新值。
  // 否则可能读到旧值，导致偏好刚关之后还会往"已锁定的笔记"写 / 写 yDoc。
  const viewLockedIdsRef = useRef(viewLockedIds);
  viewLockedIdsRef.current = viewLockedIds;
  const [headings, setHeadings] = useState<NoteEditorHeading[]>([]);
  const scrollToRef = useRef<((pos: number) => void) | null>(null);
  const { t } = useTranslation();

  /**
   * 当前视图级有效锁定状态：DB 的 isLocked **加** 用户偏好带来的"会话锁"。
   *
   * 它影响所有"只读即禁用"判断：编辑器 editable、删除按钮、AI 写作、移动到回收站。
   * Y.Doc 协作笔记优先，但 togglePin / 收藏等元素仍然走 isLocked
   * 判断。会话锁也应阻止用户在"被保护笔记"上偷偷 pin / 收藏。
   */
  const isViewLocked = !!activeNote && viewLockedIds.has(activeNote.id);
  const isTrashed = !!activeNote?.isTrashed;
  const effectiveLocked = !!activeNote?.isLocked || isViewLocked || isTrashed;
  const showDesktopOutline = showOutline && !state.editorFullscreen;

  useEffect(() => {
    const handleOfflineConflict = (event: Event) => {
      const detail = (event as CustomEvent<{ noteId?: string; serverVersion?: number }>).detail || {};
      console.warn("[EditorPane] offline queue version conflict:", detail);
      if (detail.noteId && detail.noteId === activeNote?.id) {
        actions.setSyncStatus("error");
      }
      toast.error(
        t("editor.offlineVersionConflict", {
          defaultValue: "检测到多端冲突，已停止自动覆盖，请刷新或打开版本历史处理。",
        })
      );
    };

    window.addEventListener(OFFLINE_QUEUE_CONFLICT_EVENT, handleOfflineConflict);
    return () => window.removeEventListener(OFFLINE_QUEUE_CONFLICT_EVENT, handleOfflineConflict);
  }, [activeNote?.id, actions, t]);

  // �бʼ�ʱ��ƫ��Ӧ��"�򿪼�����"��
  // ����ֻ�� activeNote.id �仯ʱ��һ�Σ������� prefs.lockOnOpen���������û���
  // �������ѿ��شӿ��е��أ������̰ѵ�ǰ�ʼǵĻỰ��Ҳ�����������"�Ҹջ��ڿ���
  // �ܱ����ʼǱ�͵͵������"����ֱ�ۡ����صı仯ֻӰ��"�´δ��±ʼ�ʱ"�ĳ�ֵ��
  useEffect(() => {
    const id = activeNote?.id;
    if (!id) return;
    if (userPrefs.lockOnOpen) {
      setViewLockedIds((prev) => {
        if (prev.has(id)) return prev;
        const next = new Set(prev);
        next.add(id);
        return next;
      });
    }
    // 大纲默认开关：每次打开笔记时按当前偏好刷新一次，保证用户设置生效。
    // 偏好更新后第一次打开笔记才生效，中途手动切换大纲仍然在当前笔记
    // 保持，直到再次打开笔记时偏好覆盖。这是大多数用户期望的行为。
    setShowOutline(userPrefs.outlineDefaultOpen);
    // 这里 disable react-hooks/exhaustive-deps：lockOnOpen / outlineDefaultOpen
    // 变化不应该触发重新应用，否则用户随时调整偏好时会造成意外抖动 / 强制展开。
    // 当前打开的笔记，只有切换笔记、大纲只有在"打开笔记"时才生效。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeNote?.id]);

  const toggleEditorFullscreen = useCallback(() => {
    actions.setEditorFullscreen(!state.editorFullscreen);
  }, [actions, state.editorFullscreen]);

  const [showMobileMenu, setShowMobileMenu] = useState(false);
  const [showDesktopMoreMenu, setShowDesktopMoreMenu] = useState(false);
  const [showMobileMoveMenu, setShowMobileMoveMenu] = useState(false);
  const [showMobileOutline, setShowMobileOutline] = useState(false);
  const [showShareModal, setShowShareModal] = useState(false);
  const [showVersionHistory, setShowVersionHistory] = useState(false);
  const [showCommentPanel, setShowCommentPanel] = useState(false);
  const [showAttachmentsPanel, setShowAttachmentsPanel] = useState(false);
  const [showBacklinksPanel, setShowBacklinksPanel] = useState(false);
  const [backlinksCount, setBacklinksCount] = useState<number | null>(null);
  const [backlinksLoading, setBacklinksLoading] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const mobileMenuRef = useRef<HTMLDivElement | null>(null);
  const desktopMoreMenuRef = useRef<HTMLDivElement | null>(null);

  // 纯 HTML 预览模式：当
  // 笔记内容被保存为 HTML 格式（如 clipper 导入）时自动进入只读预览，
  // 用户需要手动切换到 Tiptap 编辑器（会有格式丢失风险）。
  const [htmlPreviewMode, setHtmlPreviewMode] = useState(false);
  const [showHtmlEditWarning, setShowHtmlEditWarning] = useState(false);
  // 记住当前笔记的原始格式是否为 HTML。
  // 切换到编辑模式后，内容会被 normalize 为 Markdown，此时 detectFormat 返回 "md"。
  // 如果仅靠 detectFormat 判断，切换按钮会消失，用户无法切回预览模式。
  // 所以需要单独记录，让按钮始终可见。
  const [noteIsHtml, setNoteIsHtml] = useState(false);
  // 全新只读模式：当笔记是完整 HTML 文档（含 <!DOCTYPE ...>）时，不支持编辑，只显示预览按钮。
  const [noteIsFullHtmlDoc, setNoteIsFullHtmlDoc] = useState(false);

  // 编辑器模式（MD / Tiptap）：初始值来自 URL / localStorage，可随时切换。
  const [editorMode, setEditorMode] = useState<EditorMode>(() => resolveEditorMode());
  /**
   * 当前编辑器（Tiptap 或 Markdown）暴露的命令式方法。
   * EditorPane 只需要"命令 flush"等极简方法，切换编辑器、切换笔记、判断当前
   * 粘贴行为等仍然走 onUpdate 回调。
   */
  const editorHandleRef = useRef<NoteEditorHandle | null>(null);

  const handleToggleHtmlPreviewMode = useCallback(async () => {
    if (htmlPreviewMode) {
      setShowHtmlEditWarning(true);
      return;
    }

    try { await editorHandleRef.current?.flushSave(); } catch {}
    setHtmlPreviewMode(true);
  }, [htmlPreviewMode]);

  /** 用于在编辑器模式切换时，防止用户连点导致重复 PUT / mount 竞态。 */
  const modeSwitchInflightRef = useRef<boolean>(false);
  const [modeSwitching, setModeSwitching] = useState(false);

  /**
   * ���һ�� handleUpdate ������ PUT Promise��
   *
   * ��;���༭��ģʽ�л�ʱ�� RTE �� debounce �պ��� 500ms ǰ fire ���� PUT ����;�У�
   * ��ʹ�л�ʱ `discardPending()` ���˱��� timer Ҳ�޷���ֹ������ڷɵ�����
   * �����ǽ�����Ҫ��һ�δ�ͬ version ��"�淶�� PUT"�����߲�������ɣ�
   *   - �ȵ��� bump version=N+1�����ߴ��� version=N �� 409
   *   - 409 reconcile �������� version �ط�"����"�����ܰ� notes.content д��
   *     �� Tiptap JSON��ȡ���ڵ�����򣩣������л��ɹ�������
   *
   * �����toggleEditorMode ����ʱ await �� promise���� in-flight �� handleUpdate
   * ���꣨handleUpdate ���Ѿ����� 409/���� version����֮�����ǵĹ淶�� PUT �õ�
   * ����"������û�� in-flight"�İ汾�ţ����԰�ȫ������
   */
  const saveInflightRef = useRef<Promise<void> | null>(null);

  /**
   * �л� MD ? Tiptap��
   *
   * ����Э��� `docs/editor-mode-switch.md`�����ɲ��裺
   *   1) ���������ȥ�� / Эͬδ sync ʱ�ܾ�
   *   2) ��¼ preSwitchNote ���գ�ʧ�ܻع��ã�
   *   3) await saveInflightRef����ֹ�� handleUpdate ���� PUT��
   *   4) ȡ��ǰ�༭�� snapshot
   *   5) flush / discardPending��������
   *   6) MD��RTE���� yDoc ���� activeNote
   *   7) RTE��MD��normalizeToMarkdown + �淶�� PUT�����ֹ��� / syncToYjs��
   *   8) ʧ�ܻع� preSwitchNote���ɹ����ύ�����ã�persistEditorMode / clearForcedModeFromUrl / setEditorMode��
   *   9) MD��RTE��releaseYjsRoom
   */
  const toggleEditorMode = useCallback(async () => {
    if (modeSwitchInflightRef.current) return;

    // �� ��ڣ�CRDT δ sync ʱ�ı��� + �������ڣ�D4/UX6+UX7��
    // ------------------------------------------------------------------
    // collabReady=true ��ʾ�ѷ��� y:join �� synced=false ��������˻�û������
    // state �㲥��������ʱ yDoc.getText("content") �����ǿմ��� IDB �¾ɻ��档
    // MD��RTE ��ݴ˻��� activeNote �� �û�������뱻����Ϊ�ա�
    //
    // ���� collabSynced �� provider/WS �쳣��Զ���� false����ֹ�л�����û�
    // ������ MD ģʽ�������û��������� 10+ ���ӣ�����˸�Ϊ"���ε��ǿ���л�"��
    //   1st click��toast ���� + ��¼ʱ�������ֹ�л�
    //   3s �� 2nd click����Ϊ�û�����л������У��û��е����ܶ��ֵķ��գ�
    //   > 3s��ʱ������ڣ�������һ�ξ�������
    // i18n �İ����ֲ��䣬���ھ����İ���׷��"�ٴε����ǿ���л�"��
    if (collabReadyRef.current && !collabSyncedRef.current) {
      const now = Date.now();
      const last = lastUnsyncedClickAtRef.current;
      if (last && now - last < 3000) {
        // 2nd click in window �� ���У�ͬʱ���ʱ�����������
        console.warn(
          "[EditorPane] toggleEditorMode: user forced mode switch while CRDT not synced; " +
          "content may be incomplete if yDoc is stale",
        );
        lastUnsyncedClickAtRef.current = 0;
        // �䵽������������
      } else {
        lastUnsyncedClickAtRef.current = now;
        try {
          toast.warning(
            `${t("editor.modeSwitch.syncingToast")}，${t("editor.modeSwitch.forceHint")}。`,
            4000,
          );
        } catch { /* ignore */ }
        return;
      }
    } else {
      // ��ͬ����δ����Эͬ �� �������ʱ���
      lastUnsyncedClickAtRef.current = 0;
    }

    modeSwitchInflightRef.current = true;
    setModeSwitching(true);

    // �� �л�ǰ���գ�ʧ��ʱ�ع���D5��
    const preSwitchNote = activeNoteRef.current
      ? { ...activeNoteRef.current }
      : null;

    const fromMode = editorMode;
    const next: EditorMode = nextEditorMode(fromMode);

    try {
      // �� �ȴ� handleUpdate ����; PUT��D6�������� 2��
      //    ���ȵĺ�����淶�� PUT(v=N) �� debounce PUT(v=N) ������409 reconcile ʱ
      //    �ȵ��� bump v �󣬺����طŰѾ����ݸ��ǻ�����
      if (saveInflightRef.current) {
        try {
          await saveInflightRef.current;
        } catch {
          /* handleUpdate �ڲ��Ѵ���������ֻ�Ǵ��л� */
        }
      }

      // �� ȡ��ǰ�༭�����ݿ��գ�ͬ�������������� flushSave ���첽 PUT��
      let snapshot: { content: string; contentText: string } | null = null;
      try {
        snapshot = editorHandleRef.current?.getSnapshot?.() ?? null;
      } catch (err) {
        console.warn("[EditorPane] getSnapshot before switch failed:", err);
      }

      // �� ������ѡ�� flush ����
      //    - MD��RTE��flushSave ���� �ڲ� PUT ���� markdown�������� notes.content һ�£��޸�����
      //    - RTE��MD��discardPending ���� ���� Tiptap JSON PUT ��淶�� PUT ��̬
      try {
        if (fromMode === "md") {
          editorHandleRef.current?.flushSave();
        } else {
          editorHandleRef.current?.discardPending?.();
        }
      } catch (err) {
        console.warn("[EditorPane] flush/discard before switch failed:", err);
      }

      // �� MD��RTE��CRDT Ư�ƶ��� ���� �� yDoc ������ markdown ���� activeNote
      //    MD ������������ yText �activeNote.content ֻ�ڴ򿪱ʼ�ʱ����һ�Σ�
      //    �����TiptapEditor mount ʱ parseContent ���þ� note.content ��ʼ����
      if (fromMode === "md") {
        syncActiveNoteFromYDoc();
      }

      // �� RTE��MD��normalizeToMarkdown + �淶�� PUT
      //    ʧ��ʱ rollback + return�������� 4��
      if (fromMode === "tiptap") {
        const ok = await normalizeAndPersistOnSwitchRteToMd(snapshot, preSwitchNote);
        if (!ok) return;
      }

      // �� �������ύ
      //    ���и����÷��� setEditorMode ���棨avoid React18 "setState during render"��
      persistEditorMode(next);
      clearForcedModeFromUrl();
      setEditorMode(next);

      // ��״̬���������ɱ༭���� saving/error �İ���Ӧ��Խ���±༭��
      if (savedTimerRef.current) {
        clearTimeout(savedTimerRef.current);
        savedTimerRef.current = null;
      }
      actions.setSyncStatus("idle");

      try {
        toast.success(
          next === "md"
            ? t("editor.modeSwitch.successToMd")
            : t("editor.modeSwitch.successToTiptap"),
        );
      } catch { /* toast ������Ҳû��ϵ */ }

      // �� MD��RTE���ͷŷ���� y room�������� 3��
      //    ʧ�ܽ���¼��־����syncToYjs ���ƻ����´��л� MD ǰ����״̬��
      if (next === "tiptap" && preSwitchNote) {
        try {
          await api.releaseYjsRoom(preSwitchNote.id);
        } catch (err) {
          console.warn("[EditorPane] releaseYjsRoom after MD��RTE switch failed:", err);
        }
      }
    } finally {
      modeSwitchInflightRef.current = false;
      setModeSwitching(false);
    }
  // toggleEditorMode deps
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editorMode, actions, t]);
  // ---------------------------------------------------------------------------
  // toggleEditorMode ���ڲ��ӹ��̣����������Ȧ���Ӷȣ��� A1��
  // ---------------------------------------------------------------------------

  /**
   * MD��RTE ǰ���� yDoc ��ȡ���� markdown ���� activeNote��
   *
   * ֻ��ȡ ref���������հ�������˲���Ҫ useCallback��Ҳ��������ӵ�
   * toggleEditorMode �� deps �
   */
  function syncActiveNoteFromYDoc() {
    const yDocNow = collabYDocRef.current;
    const note = activeNoteRef.current;
    if (!yDocNow || !note || note.isLocked || viewLockedIdsRef.current.has(note.id)) return;
    try {
      const latestMd = yDocNow.getText("content").toString();
      if (latestMd && latestMd !== note.content) {
        actions.setActiveNote({
          ...note,
          content: latestMd,
          contentText: latestMd,
        });
      }
    } catch (err) {
      console.warn("[EditorPane] sync yDoc before switch failed:", err);
    }
  }

  /**
   * RTE��MD���� Tiptap JSON �淶��Ϊ markdown�������Ȼ��� activeNote��
   * �� PUT �ط���ˣ����ֹ��� + syncToYjs����
   *
   * ���� true ��ʾ�ɹ������� PUT�����Լ����ƽ� setEditorMode����
   * ���� false ��ʾ�淶�� PUT ʧ�ܲ�����ɻع���toggleEditorMode Ӧ��ǰ return����
   */
  async function normalizeAndPersistOnSwitchRteToMd(
    snapshot: { content: string; contentText: string } | null,
    preSwitchNote: ReturnType<typeof Object.assign> | null,
  ): Promise<boolean> {
    const note = activeNoteRef.current;
    if (!snapshot || !note || note.isLocked || viewLockedIdsRef.current.has(note.id)) return true;

    // snapshot.content ͨ���� Tiptap JSON �ַ���������ʶ��һ�¡�
    const fmt = detectFormat(snapshot.content);
    let normalizedMd = snapshot.content;
    let normalizedText = snapshot.contentText;
    if (fmt === "tiptap-json" || fmt === "html") {
      try {
        const md = normalizeToMarkdown(snapshot.content, snapshot.contentText);
        if (md) {
          normalizedMd = md;
          normalizedText = markdownToPlainText(md) || snapshot.contentText;
        }
      } catch (err) {
        console.warn("[EditorPane] normalize RTE��MD content failed:", err);
      }
    }

    // �����Ȼ������ MD �༭�� mount ʱ�����淶���������
    // ����ʹ���� PUT ʧ�ܣ�Ҳ�������Ա��� markdown ��Ⱦ��
    const needUpdate =
      normalizedMd !== note.content || normalizedText !== note.contentText;
    if (!needUpdate) return true;

    actions.setActiveNote({
      ...note,
      content: normalizedMd,
      contentText: normalizedText,
    });

    const noteId = note.id;
    const initialVersion = note.version;

    // syncToYjs=true �÷������ REST �ɹ���� yText ͬ���滻Ϊ��� markdown��
    // ��֤�´��л� MD ʱ y:join �õ��� state �� notes.content һ�¡�
    const sendNormalizePut = (version: number) =>
      api.updateNote(noteId, {
        content: normalizedMd,
        contentText: normalizedText,
        contentFormat: note.contentFormat,
        version,
        syncToYjs: true,
      } as any);

    try {
      actions.setSyncStatus("saving");
      const updated = await sendNormalizePut(initialVersion);

      // ���� version / updatedAt��������� handleUpdate ���� 409
      if (updated && activeNoteRef.current?.id === noteId) {
        actions.setActiveNote({
          ...activeNoteRef.current,
          content: normalizedMd,
          contentText: normalizedText,
          version: updated.version,
          updatedAt: updated.updatedAt,
        });
        actions.updateNoteInList({
          id: updated.id,
          title: updated.title,
          contentText: updated.contentText,
          updatedAt: updated.updatedAt,
        });
        actions.setSyncStatus("saved");
        actions.setLastSynced(new Date().toISOString());
      }
      return true;
    } catch (err) {
      // Abort���бʼǣ��� idle ����������Ϊ�ɼ����л�
      if (isAborted(err)) {
        actions.setSyncStatus("idle");
        return true;
      }
      if (is409Error(err)) {
        try {
          saveDraft({
            noteId,
            editorMode: "md",
            content: normalizedMd,
            contentText: normalizedText,
            title: note.title,
            baseVersion: typeof (err as any)?.currentVersion === "number" ? (err as any).currentVersion : initialVersion,
            savedAt: Date.now(),
          });
        } catch { /* ignore */ }
      }
      console.warn("[EditorPane] normalize PUT on mode switch failed:", err);
      actions.setSyncStatus("error");

      // �ع� activeNote�����Ȿ�� content �ѱ� normalizedMd ���ǵ� editorMode û��
      // ������ Tiptap �� markdown �� JSON ���� �� �༭���Ӿ����ң�
      if (preSwitchNote && activeNoteRef.current?.id === (preSwitchNote as any).id) {
        actions.setActiveNote(preSwitchNote as any);
      }
      try { toast.error(t("editor.modeSwitch.failRollback")); } catch { /* ignore */ }
      return false;
    }
  }

  /**
   * �л��ʼǣ�activeNote.id �仯��ǰ��Ҳ�ѵ�ǰ�༭���� debounce ����ˢһ�Σ�
   * ��ֹ"д��һ������ �� 500ms �ڶ���"��
   */
  const lastActiveIdRef = useRef<string | null>(activeNote?.id ?? null);
  const skipNextSwitchFlushForNoteIdRef = useRef<string | null>(null);
  useEffect(() => {
    const prevId = lastActiveIdRef.current;
    const nextId = activeNote?.id ?? null;
    if (prevId && prevId !== nextId) {
      if (skipNextSwitchFlushForNoteIdRef.current === prevId) {
        skipNextSwitchFlushForNoteIdRef.current = null;
      } else {
        try { editorHandleRef.current?.flushSave(); } catch { /* ignore */ }
      }
    }
    lastActiveIdRef.current = nextId;
  }, [activeNote?.id]);

  // ������ P2-5: ��ǰ�༭��ģʽ ref���� handleUpdate ͬ��д�ݸ��ã� ������������������������������
  const editorModeRef = useRef<EditorMode>(editorMode);
  useEffect(() => { editorModeRef.current = editorMode; }, [editorMode]);

  // ������ P1-4: ��������ʧ�ܼ��� + toast ����ʱ��� ����������������������������������������������������������������
  // ����ɹ� / �бʼ�ʱ���㣻���� ��2 ��ʧ�� + ���ϴ� toast �� 30s �ŵ�һ��
  const consecutiveSaveFailRef = useRef<number>(0);
  const lastSaveFailToastAtRef = useRef<Record<string, number>>({});

  // ������ P1-3: ҳ�汻ж�� / ����ʱǿ�ưѵ�ǰ�༭������д�뱾�زݸ� + ���߶��� ������������
  // �����������ƶ��� webview ��ϵͳ���ա�ˢ�¡��� Tab���е���̨��ɱ��
  // ���������첽 PUT��pagehide �� fetch �ᱻ��ֹ����ֻ��д localStorage ͬ�����̣�
  //   1) saveDraft д���زݸ壨�´δ�ͬ�ʼǿɻָ���
  //   2) enqueue д���߶��У��´ν� app �Զ� flush��
  useEffect(() => {
    const flushToLocal = () => {
      const note = activeNoteRef.current;
      if (!note || note.isLocked || viewLockedIdsRef.current.has(note.id)) return;
      let snap: { content: string; contentText: string } | null = null;
      try {
        snap = editorHandleRef.current?.getSnapshot?.() ?? null;
      } catch { /* ignore */ }
      if (!snap || typeof snap.content !== "string") return;
      if (snap.content === note.content) return;
      // 1) �ݸ壨ͬ����������������
      try {
        saveDraft({
          noteId: note.id,
          editorMode: editorModeRef.current,
          content: snap.content,
          contentText: snap.contentText || "",
          title: note.title,
          baseVersion: note.version,
          savedAt: Date.now(),
        });
      } catch { /* ignore */ }
      // 2) ���߶��У��´����� flush��
      try {
        enqueueOfflineMutation({
          type: "updateNote",
          noteId: note.id,
          url: `/notes/${note.id}`,
          method: "PUT",
          body: {
            title: note.title,
            content: snap.content,
            contentText: snap.contentText,
            contentFormat: note.contentFormat,
            version: note.version,
          },
        });
      } catch { /* ignore */ }
    };

    const onPageHide = () => flushToLocal();
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") flushToLocal();
    };
    // beforeunload ������������ر�/ˢ��ʱ�������ƶ��˲�һ���ɿ�������� pagehide
    const onBeforeUnload = () => flushToLocal();

    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  // ʹ�� ref ׷�����µ� activeNote������ handleUpdate �հ����ù���
  const activeNoteRef = useRef(activeNote);
  activeNoteRef.current = activeNote;
  const syncStatusRef = useRef(syncStatus);
  syncStatusRef.current = syncStatus;



  // ---------------------------------------------------------------------------
  // Phase 2: ʵʱЭ�� ���� Presence / ���� / Զ�̸�����ʾ
  // ---------------------------------------------------------------------------
  /** Զ�̸��º���������˱�����ͬһƪ�ʼǣ���ʾ�û����¼��� / ������ͻ */
  const lastAutoAppliedRemoteRef = useRef<string>("");
  /** Զ��ɾ����� */
  const [remoteDelete, setRemoteDelete] = useState<{ actorUserId?: string; trashed?: boolean } | null>(null);

  // ������ P2-5: δ����ݸ�ָ���ʾ ����������������������������
  // �򿪱ʼ�ʱ����������� baseVersion <= server.version �� savedAt > server.updatedAt
  // �Ĳݸ壬�򵯳��ָ���ʾ�������������ϴ����� / �����˳������½��롣
  const [pendingDraft, setPendingDraft] = useState<NoteDraft | null>(null);
  // handleUpdate ������Ŷ��壬������ ref ����"ʹ��δ��ʼ������"
  const handleUpdateRef = useRef<
    | ((data: { content?: string; contentText?: string; title: string }) => Promise<void>)
    | null
  >(null);

  // �л��ʼ�ʱ��Ȿ�زݸ�
  useEffect(() => {
    setPendingDraft(null);
    // �����ʼǣ������򱾻Ựƫ�����������ݸ�ָ���ʾ������Ȼ���뼴ֻ����
    // û��"�ָ�δ��������"�����壬���������û�����Ϊ��ʧЧ��
    if (!activeNote || activeNote.isLocked || viewLockedIdsRef.current.has(activeNote.id)) return;
    let draft: NoteDraft | null = null;
    try { draft = loadDraft(activeNote.id); } catch { draft = null; }
    if (!draft) return;
    if (
      shouldOfferRestore(
        draft,
        activeNote.version,
        activeNote.updatedAt,
        activeNote.content,
      )
    ) {
      setPendingDraft(draft);
    } else {
      // ʵ��������һ�£������˸��£� �� ֱ������ݸ�����´λ���ʾ
      try { clearDraft(activeNote.id); } catch { /* ignore */ }
    }
  }, [activeNote?.id, activeNote?.version, activeNote?.updatedAt]);

  /** �ָ��ݸ壺�ѱ��زݸ�����д�� activeNote���ñ༭������װ�ز����� PUT */
  const handleRestoreDraft = useCallback(async () => {
    const draft = pendingDraft;
    const note = activeNoteRef.current;
    if (!draft || !note || draft.noteId !== note.id) return;
    setPendingDraft(null);
    // ֱ�ӰѲݸ�д�� activeNote���༭�����ȡ note.content ����װ��
    actions.setActiveNote({
      ...note,
      content: draft.content,
      contentText: draft.contentText,
      title: draft.title,
    });
    // �����������棨������ putWithReconcile ·�������Զ�������ͻ��
    try {
      await handleUpdateRef.current?.({
        title: draft.title,
        content: draft.content,
        contentText: draft.contentText,
      });
    try { toast.success(t("editor.draftRestored") || "已恢复未保存的修改"); } catch {}
    } catch {
      // handleUpdate �ڲ��Ѵ�������
    }
  }, [pendingDraft, actions, t]);

  /** �����ݸ� */
  const handleDiscardDraft = useCallback(() => {
    const draft = pendingDraft;
    if (!draft) return;
    setPendingDraft(null);
    try { clearDraft(draft.noteId); } catch { /* ignore */ }
  }, [pendingDraft]);

  // ---------------------------------------------------------------------------
  // ��ǰ��¼�û���Ϣ
  // ---------------------------------------------------------------------------
  // selfUser ͬʱ������������
  //   1) useRealtimeNote �� selfUserId������"�Լ���"presence / note:updated ������
  //   2) Phase 3 Y.js CRDT �� awareness����ʾ������������ɫ��
  // ��˱����� useRealtimeNote ֮ǰ������������ʱ��������TDZ��������
  /** ��ǰ��¼�û���Ϣ������ awareness ��ʾ������������ɫ */
  const [selfUser, setSelfUser] = useState<{ userId: string; username: string } | null>(() => {
    try {
      const cachedId = localStorage.getItem("nowen-self-userid");
      const cachedName = localStorage.getItem("nowen-self-username");
      if (cachedId && cachedName) return { userId: cachedId, username: cachedName };
    } catch {}
    return null;
  });
  useEffect(() => {
    if (selfUser) return;
    let cancelled = false;
    api.getMe()
      .then((me: any) => {
        if (cancelled || !me?.id) return;
        try {
          localStorage.setItem("nowen-self-userid", me.id);
          localStorage.setItem("nowen-self-username", me.username || me.id);
        } catch {}
        setSelfUser({ userId: me.id, username: me.username || me.id });
      })
      .catch(() => { /* δ��¼/����ʧ�ܾ�Ĭ */ });
    return () => { cancelled = true; };
  }, [selfUser]);

  function getCurrentEditorSnapshot(): { content: string; contentText: string } | null {
    try {
      const snap = editorHandleRef.current?.getSnapshot?.();
      return snap && typeof snap.content === "string" ? snap : null;
    } catch {
      return null;
    }
  }

  function hasLocalUnsavedChanges(): boolean {
    const cur = activeNoteRef.current;
    if (!cur) return false;
    if (syncStatusRef.current === "saving" || !!saveInflightRef.current) return true;
    const snap = getCurrentEditorSnapshot();
    if (!snap) return false;
    return snap.content !== cur.content || snap.contentText !== cur.contentText;
  }

  async function applyRemoteNoteUpdate(msg: {
    noteId: string;
    version: number;
    updatedAt?: string;
    title?: string;
    contentText?: string;
    actorUserId?: string;
  }) {
    const cur = activeNoteRef.current;
    if (!cur || cur.id !== msg.noteId) return;
    if (cur.version >= msg.version) return;
    // Markdown/Y.js ģʽ�� CRDT update �ϲ������� REST �Զ����ǡ�
    if (collabYDocRef.current) return;

    actions.updateNoteInList({
      id: msg.noteId,
      title: msg.title,
      contentText: msg.contentText,
      updatedAt: msg.updatedAt,
      version: msg.version,
    } as any);

    if (hasLocalUnsavedChanges()) {
      return;
    }

    const applyKey = `${msg.noteId}:${msg.version}`;
    if (lastAutoAppliedRemoteRef.current === applyKey) return;
    lastAutoAppliedRemoteRef.current = applyKey;

    try {
      const fresh = await api.getNote(msg.noteId);
      const latest = activeNoteRef.current;
      if (!latest || latest.id !== msg.noteId) return;
      if (latest.version >= fresh.version) return;
      if (hasLocalUnsavedChanges()) {
        return;
      }
      actions.setActiveNote(fresh);
      actions.updateNoteInList({
        id: fresh.id,
        title: fresh.title,
        contentText: fresh.contentText,
        updatedAt: fresh.updatedAt,
        version: fresh.version,
      } as any);
      actions.setLastSynced(new Date().toISOString());
    } catch (e) {
      console.warn("[EditorPane] auto apply remote note failed:", e);
    }
  }

  async function checkActiveNoteRemoteVersion(reason: string) {
    const cur = activeNoteRef.current;
    if (!cur || collabYDocRef.current) return;
    try {
      const slim = await api.getNoteSlim(cur.id);
      const latest = activeNoteRef.current;
      if (!latest || latest.id !== cur.id) return;
      if (typeof slim.version === "number" && slim.version > latest.version) {
        await applyRemoteNoteUpdate({
          noteId: cur.id,
          version: slim.version,
          updatedAt: slim.updatedAt,
          title: slim.title,
          contentText: slim.contentText,
        });
      }
    } catch (e) {
      console.warn(`[EditorPane] active note version check failed (${reason}):`, e);
    }
  }

  const { presenceUsers, isConnected, setEditing: rtSetEditing } = useRealtimeNote({
    noteId: activeNote?.id ?? null,
    // ��ʽ���� selfUserId��EditorPane ������ selfUser��localStorage ���� + /api/me����
    // ֱ�Ӵ���ȥ������ hook �ڲ�"selfUserId Ϊ null ������"���µ�����ʾ
    // ���Լ��༭ʱ�� "XX ���ڱ༭ / XX �����˱ʼ�"����
    selfUserId: selfUser?.userId ?? null,
    onRemoteUpdate: (msg) => {
      void applyRemoteNoteUpdate(msg);
    },
    onRemoteDelete: (msg) => {
      const cur = activeNoteRef.current;
      if (!cur || cur.id !== msg.noteId) return;
      setRemoteDelete({ actorUserId: msg.actorUserId, trashed: msg.trashed });
    },
  });

  // �ƶ��˺�̨�ָ� / ����ָ� / WebSocket ����ʱ���ܴ���ʵʱ��Ϣ������һ�ε�ǰ�ʼǰ汾��
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") void checkActiveNoteRemoteVersion("visible");
    };
    const onOnline = () => void checkActiveNoteRemoteVersion("online");
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onOnline);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
    };
    // checkActiveNoteRemoteVersion �Ǻ����������ڲ��� ref������Ҫ��Ϊ���������ذ�
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (isConnected) void checkActiveNoteRemoteVersion("ws-open");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConnected, activeNote?.id]);

  // ---------------------------------------------------------------------------
  // Phase 3: Y.js CRDT Эͬ
  // ---------------------------------------------------------------------------

  /**
   * Phase 3 ����������
   *   - ʹ�� Markdown �༭����Tiptap JSON �޷�����ӳ�䵽 Y.Text��
   *   - �ʼ�δ����������ֱ̬��ֻ��������Эͬ��
   *   - ��֪��ǰ�û���Ϣ����Ϊ awareness ���ݣ�
   *   - �� activeNote
   *
   * ע�����˳�����Ҳ���á�������ֻһ�� client��y-collab �൱�ڿղ������������
   * ����������־û��������������Զ��ϲ���
   */
  const collabReady = !!(activeNote && !activeNote.isLocked && selfUser && editorMode === "md");
  const { doc: collabYDoc, provider: collabProvider, synced: collabSynced } = useYDoc({
    noteId: collabReady ? (activeNote?.id ?? null) : null,
    user: selfUser,
    enabled: collabReady,
  });

  /**
   * collabYDoc �� ref ����
   *
   * ������`toggleEditorMode`��������������壩��Ҫ���л�ǰ�� yDoc ��ȡ����
   * markdown ���� activeNote�������е� RTE ��������ٺ�������롣����
   * `toggleEditorMode` �������� `collabYDoc` ֮ǰ������ collabYDoc ֱ��д��
   * useCallback �ıհ��� deps����� TDZ������ render ʱ deps ������ֵ������
   * useYDoc ֮ǰ��collabYDoc ������ʱ������������ ref ��ӷ��ʼ��ɹ�ܡ�
   */
  const collabYDocRef = useRef<typeof collabYDoc>(null);
  collabYDocRef.current = collabYDoc;

  /**
   * CRDT synced ״̬�� ref ����
   *
   * ��;��
   *   - toggleEditorMode ��Ҫ���л�ǰ�ж�"CRDT �Ƿ�����ɳ��� sync"��δ synced ʱ
   *     yDoc.getText("content") �����������ǿմ�����û�յ������ y:sync����
   *     ��ʱóȻ�е� RTE ��ѿ����ݵ����������ݻ��� activeNote���û��������ȫ����
   *   - ͬ���� ref ����ֱ������ collabSynced����� toggleEditorMode useCallback
   *     �� TDZ ���⣨����˳������ toggleEditorMode����
   *   - collabReadyRef ��������"û���� CRDT (MD��RTE ���� CRDT ģʽ)"��"���õ�δ sync"��
   */
  const collabSyncedRef = useRef<boolean>(false);
  collabSyncedRef.current = collabSynced;
  const collabReadyRef = useRef<boolean>(false);
  collabReadyRef.current = collabReady;

  /**
   * UX7 �������ڣ���¼�ϴ�"δ sync ʱ�����л�"��ʱ�����
   * ��һ�ε����toast ����+��¼ʱ�������ֹ�л���
   * 3 ���ڵڶ��ε������Ϊ�û�����л������У��ƹ� UX6 ��������
   * ���� 3 �룺ʱ������ڣ���Ϊ��һ��"��һ�ε��"��
   * �� ref �棬����Ⱦ render ѭ����
   */
  const lastUnsyncedClickAtRef = useRef<number>(0);

  // �л��ʼ�ʱ��պ��
  useEffect(() => {
    setRemoteDelete(null);
  }, [activeNote?.id]);

  // ���� �л��ʼ�ʱ�Զ���� HTML ��ʽ������Ԥ��ģʽ ����
  // ����ʼ����ݸ�ʽΪ "html"���Զ����� HTML Ԥ����������˵�����༭����
  useEffect(() => {
    if (!activeNote) return;
    const fmt = detectFormat(activeNote.content);
    const isHtml = fmt === "html";
    const isFullDoc = isHtml && isFullHtmlDocument(activeNote.content);
    setHtmlPreviewMode(isHtml);
    setNoteIsHtml(isHtml);
    setNoteIsFullHtmlDoc(isFullDoc);
  }, [activeNote?.id]); // ֻ���л��ʼ�ʱ��⣬�༭�����в����Զ��л�

  // BACKLINKS-02: 切换笔记时加载反向链接数量
  useEffect(() => {
    if (!activeNote?.id) {
      setBacklinksCount(null);
      return;
    }
    let cancelled = false;
    setBacklinksLoading(true);
    api.getBacklinks(activeNote.id)
      .then((data) => {
        if (!cancelled) {
          setBacklinksCount(data.backlinks.length);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setBacklinksCount(null);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setBacklinksLoading(false);
        }
      });
    return () => { cancelled = true; };
  }, [activeNote?.id]);

  /** �� presence �з����û��������ں����ʾ�� */
  const findUsername = useCallback(
    (userId?: string) => {
      if (!userId) return undefined;
      const match = presenceUsers.find((u) => u.userId === userId);
      return match?.username;
    },
    [presenceUsers],
  );

  /** �û�ȷ��Զ��ɾ����ʾ����յ�ǰ�ʼǲ����б��Ƴ� */
  const handleAckRemoteDelete = useCallback(() => {
    const cur = activeNoteRef.current;
    if (cur) {
      actions.setActiveNote(null);
      actions.removeNoteFromList(cur.id);
      actions.removeNoteTab(cur.id);
      // ����վ��refreshNotes ������ӻ�"����վ"��ͼ
      actions.refreshNotes();
    }
    setRemoteDelete(null);
  }, [actions]);

  /** �༭̬�㲥��handleUpdate ����ʱ��ʱ�� editing=true��500ms ���Զ�ȡ�� */
  const editingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flagEditing = useCallback(() => {
    rtSetEditing(true);
    if (editingTimerRef.current) clearTimeout(editingTimerRef.current);
    editingTimerRef.current = setTimeout(() => {
      rtSetEditing(false);
      editingTimerRef.current = null;
    }, 1500);
  }, [rtSetEditing]);
  // ���ж��ʱ����
  useEffect(() => {
    return () => {
      if (editingTimerRef.current) clearTimeout(editingTimerRef.current);
    };
  }, []);

  // ����ж��ǰ���� flush��ˢ�¡��رձ�ǩ��
  useEffect(() => {
    const onBeforeUnload = () => {
      try { editorHandleRef.current?.flushSave(); } catch { /* ignore */ }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  // NoteList/Sidebar �������л� activeNote ǰ�������¼������� Tiptap �յ��� note.id ��
  // ������ɱʼǵ� debounce�������л�ǰ 500ms �ڵı༭û����⡣
  useEffect(() => {
    const onBeforeNoteSwitch = () => {
      const noteId = activeNoteRef.current?.id ?? null;
      if (noteId && skipNextSwitchFlushForNoteIdRef.current === noteId) {
        skipNextSwitchFlushForNoteIdRef.current = null;
        return;
      }
      try { editorHandleRef.current?.flushSave(); } catch { /* ignore */ }
    };
    window.addEventListener("nowen:before-note-switch", onBeforeNoteSwitch);
    return () => window.removeEventListener("nowen:before-note-switch", onBeforeNoteSwitch);
  }, []);

  // Delete ��ɾ���ʼǿ�ݼ������ڱ༭��δ�۽�ʱ��Ч��
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Delete" && activeNote
          && !activeNote.isLocked
          && !viewLockedIdsRef.current.has(activeNote.id)) {
        // ��齹���Ƿ��ڱ༭���ڲ�������ڱ༭���ڣ�Delete ��Ӧ������ɾ�����֣�
        const activeEl = document.activeElement;
        const isInEditor = activeEl?.closest(".ProseMirror") || activeEl?.tagName === "INPUT" || activeEl?.tagName === "TEXTAREA";
        if (!isInEditor) {
          e.preventDefault();
          setShowDeleteConfirm(true);
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activeNote]);

  // ����ⲿ�ر��ƶ��˲˵�
  useEffect(() => {
    if (!showMobileMenu) return;
    const handler = (e: MouseEvent) => {
      if (mobileMenuRef.current && !mobileMenuRef.current.contains(e.target as Node)) {
        setShowMobileMenu(false);
        setShowMobileMoveMenu(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showMobileMenu]);

  useEffect(() => {
    if (!showDesktopMoreMenu) return;
    const onPointerDown = (e: MouseEvent) => {
      if (desktopMoreMenuRef.current && !desktopMoreMenuRef.current.contains(e.target as Node)) {
        setShowDesktopMoreMenu(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShowDesktopMoreMenu(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [showDesktopMoreMenu]);

  const handleUpdate = useCallback(async (data: { content?: string; contentText?: string; title: string; _noteId?: string }) => {
    const currentNote = activeNoteRef.current;
    if (!currentNote || currentNote.isLocked || viewLockedIdsRef.current.has(currentNote.id)) return;

    // P0: 如果调度时的 noteId 与当前 activeNote 不一致，说明已切换笔记，跳过保存
    if (data._noteId && data._noteId !== currentNote.id) {
      console.warn("[handleUpdate] noteId mismatch, skipping save", { scheduled: data._noteId, current: currentNote.id });
      return;
    }

    // P0: 空内容防护已移至后端（notes.ts suspicious_empty_update 拦截）。
    // 前端不拦截空内容保存，因为：
    //   1. Tiptap 空文档 JSON 不是空字符串，前端 guard 实际上不拦截 RTE 模式
    //   2. Markdown 空文档是空字符串，前端 guard 会错误拦截用户主动清空
    //   3. 后端 guard 同时检查 content 和 contentText，更准确

    // ������ P2-5: ���زݸ�˫���� ����������������������������
    // ÿ�� onUpdate fire ��**ͬ��**дһ�ݲݸ嵽 localStorage��ֻҪ�����κλ���
    // ��PUT ʧ�� / fetch ���� / ҳ�汻ɱ�����ˣ��´δ�ͬһ�ʼ����ܴӲݸ�ָ���
    if (data.content !== undefined) {
      try {
        saveDraft({
          noteId: currentNote.id,
          editorMode: editorModeRef.current,
          content: data.content,
          contentText: data.contentText || "",
          title: data.title,
          baseVersion: currentNote.version,
          savedAt: Date.now(),
        });
      } catch { /* ignore quota �ȴ��� */ }
    }

    // Phase 2: �㲥"�����ڱ༭"��1.5s �������������Զ�ȡ����
    try { flagEditing(); } catch {}
    actions.setSyncStatus("saving");

    // ��װ��С�����Ա� 409 ���� server ���ص� currentVersion �ط�һ�Ρ�
    //
    // P0-4: 409 �ط�ʱ���ȴӱ༭�������� snapshot ���¹��� payload��
    //   ������ԭʵ�� sendOnce ��Զ���ó��ν��� handleUpdate ʱ�� data �հ���
    //   �� data �� 500ms ǰ debounce ʱ�̵����ݡ���� 409 �ȴ� + �ط��ڼ��û�
    //   �������֣��طžͻ���"��ʱ������"���Ƿ�������°汾����һ�ε� debounce
    //   PUT �ֻ��� 409������ͬ����ʱ�����ݸ���һ�Σ��� �û��о�"�Ҹ��õ���
    //   ������ / �༭���Զ�����"��
    //
    //   �ķ���ÿ�� sendOnce ����ʱ�����׷� + 409 �طţ������ȳ��Դ�
    //   editorHandleRef ȡһ������ snapshot���õ��򸲸� content/contentText��
    //   �׷�ʱ snapshot �� data ����һ�£�����룩�������ÿɺ��ԣ��ط�ʱ
    //   ��ȷ�����͵���"�û����������ڱ༭���￴��������"��
    //
    //   ���� data.content !== undefined������ CRDT-only ������ʱ�Ÿ��ǣ�
    //   CRDT ģʽ data ���� content���� yjs ͨ��д�أ�������������͵͵����
    let attemptCount = 0;
    // ʵ�ʷ��͵����һ�� payload�������� 409 �طű��������� snapshot����
    // �·� setActiveNote ���� content ʱ���������ǳ�ʼ data������ activeNote
    // ��������ʵ�洢���ݲ�һ�¡�
    let lastSentData: { content?: string; contentText?: string; title: string } = data;
    const sendOnce = (version: number) => {
      attemptCount++;
      let effectiveData = data;
      if (data.content !== undefined && attemptCount > 1) {
        try {
          const snap = editorHandleRef.current?.getSnapshot?.();
          if (snap && typeof snap.content === "string") {
            effectiveData = {
              title: data.title,
              content: snap.content,
              contentText: snap.contentText,
            };
          }
        } catch {
          /* getSnapshot ʧ��ʱ���˵�ԭ data������������ */
        }
      }
      lastSentData = effectiveData;
      // P0-#2 �޸���CRDT ģʽ�� content δ�� �� ֻͬ�� meta��title����
      // ���� REST PUT ������ yjs ��д notes.content ������̬����
      const payload: any = { title: effectiveData.title, version };
      payload.contentFormat = currentNote.contentFormat;
      if (effectiveData.content !== undefined) payload.content = effectiveData.content;
      if (effectiveData.contentText !== undefined) payload.contentText = effectiveData.contentText;
      return api.updateNote(currentNote.id, payload);
    };

    // �ѱ��� PUT ע��Ϊ "inflight"���� toggleEditorMode ���л�ǰ await��
    // ���л�����"���������� REST PUT"�����漰 yjs update ����
    //
    // ������ε���ʱ�����ֱ�Ӹ��� ref����һ�ε� handleUpdate Ҳ���� await ���
    // inflight ���������� FIFO ���У�toggleEditorMode ֻ����"�л��㵱�»�δ���
    // ����һ�� PUT"��
    const inflight = (async () => {
    try {
      // �ֹ�����ͻ reconcile������˷��� { status: 409, currentVersion: N }��
      // ������һ���Ļ������� activeNote.version ��Զͣ���ھ�ֵ��֮��ÿ�� debounce
      // �Զ����涼���ٴ� 409���γ�"409 �籩"�������־���ܿ�����ʮ������ 409����
      //
      // putWithReconcile �Ĳ��ԣ��� toggleEditorMode �Ĺ淶�� PUT ����ͬһ��ʵ�֣���
      //   1) ��ѡ�� err.currentVersion �ط�һ�Σ�
      //   2) �����û�����汾��ʱ�ٶ����� fetchLatestVersion��GET /notes/:id����
      //   3) �ڼ��бʼǣ�onAbort���� abort �طţ���ֹ�Ѿɱʼ�����д���±ʼǡ�
      let updated;
      if (data.content !== undefined) {
        // ���ı������� 409 ʱ�����١������� version ä�طž����ġ�������Ḳ��
        // PC/Web �ձ�������ݡ�����ĳ���ȡԶ�����°棬�������زݸ壬�������ͻ�����
        try {
          updated = await sendOnce(currentNote.version);
        } catch (err: any) {
          if (!is409Error(err)) throw err;
          if (activeNoteRef.current?.id !== currentNote.id) return;
          let latestVersion = typeof err?.currentVersion === "number" ? err.currentVersion : undefined;
          try {
            const fresh = await api.getNote(currentNote.id);
            latestVersion = fresh.version;
            actions.updateNoteInList({
              id: fresh.id,
              title: fresh.title,
              contentText: fresh.contentText,
              updatedAt: fresh.updatedAt,
              version: fresh.version,
            } as any);
          } catch {
            /* ��ȫ��ʧ��Ҳ�������زݸ壬�Ժ����û����� */
          }
          const snap = getCurrentEditorSnapshot();
          if (snap) {
            try {
              saveDraft({
                noteId: currentNote.id,
                editorMode: editorModeRef.current,
                content: snap.content,
                contentText: snap.contentText,
                title: data.title,
                baseVersion: latestVersion ?? currentNote.version,
                savedAt: Date.now(),
              });
            } catch { /* ignore */ }
          }
          actions.setSyncStatus("error");
          return;
        }
      } else {
        updated = await putWithReconcile({
          initialVersion: currentNote.version,
          send: sendOnce,
          fetchLatestVersion: makeFetchLatestNoteVersion(currentNote.id),
          onAbort: () => activeNoteRef.current?.id !== currentNote.id,
        });
      }

      // ���ڱ���ıʼ����ǵ�ǰ����ʼ�ʱ����״̬����ֹ�����л�ʱ���Ǵ���ʼǣ�
      if (activeNoteRef.current?.id === updated.id) {
        // �ؼ�������Ѹձ���� content / contentText Ҳ��� activeNote��
        //
        // ������Ϊʲô֮ǰֻ����Ԫ���ݣ����������� content ������� activeNote
        // ���ñ仯 �� TiptapEditor �� useEffect([note.content]) ���� setContent
        // �� ���/���뱻��ϡ�����֮ǰֻ���� version/updatedAt/title��
        //
        // ������"�л��༭�� (MD ? RTE)"������������ bug��
        //   - MD �༭������ �� activeNote.content ���Ǿ� Tiptap JSON��δˢ�£�
        //   - �е� Tiptap �� TiptapEditor �� note.content �� �������Ǿ� JSON
        //     �� �û��� MD �����������޸���ȫ"��ʧ"
        //   - ����ͬ��
        // ����Ϊ"�����л��Ͷ����ݡ������޸�Ҳ�����"��
        //
        // ����취������������༭����ͨ�� lastEmittedContentRef ������
        // �Ƚ� note.content �Ƿ�����Լ��ϴ��ɳ�ȥ���Ƿݣ��Ǿ����� setContent��
        // �����궶�������ǣ�������һ���༭����汾�ָ���������ͬ����
        //
        // P1-5: content �ֶ�������"ʵ�ʷ��͸�����˵���һ��"��lastSentData��
        // ������ 409 �ط�ʱȡ������ snapshot���������Ǳհ���ĳ�ʼ data��
        // ��һ����"�ֹ���д����"���� PUT �ڼ��û��������֣��༭����ǰ snapshot
        // �� lastSentData ������ȡ�����ʱ����**���� activeNote.content ����**
        // ���������û��������ݣ���ֻ����Ԫ���ݣ���һ�� debounce �Զ������
        // �Ѻ�����������ȥ���������Ա����� activeNote ���û��˵��Ծɵİ汾��
        // �������� TiptapEditor effect ���ؽ��༭�� DOM ����������ˡ�
        let nextContent = activeNoteRef.current.content;
        let nextContentText = activeNoteRef.current.contentText;
        if (lastSentData.content !== undefined) {
          let editorSnap: { content: string; contentText: string } | null = null;
          try {
            const snap = editorHandleRef.current?.getSnapshot?.();
            if (snap && typeof snap.content === "string") editorSnap = snap as any;
          } catch { /* ignore */ }
          if (!editorSnap || editorSnap.content === lastSentData.content) {
            // �༭����ǰ���� == ����˸��յ������� �� ��ȫ����
            nextContent = lastSentData.content;
            nextContentText = lastSentData.contentText ?? activeNoteRef.current.contentText;
          } else {
            // �༭�����������룺����ǰ�����£��� editorSnap�������� setActiveNote
            // �ñ༭������Ϊ"�ⲿ����"����һ�� debounce ����Ȼ�����������ݡ�
            nextContent = editorSnap.content;
            nextContentText = editorSnap.contentText ?? activeNoteRef.current.contentText;
          }
        }
        actions.setActiveNote({
          ...activeNoteRef.current,
          version: updated.version,
          updatedAt: updated.updatedAt,
          title: data.title,
          content: nextContent,
          contentText: nextContentText,
        });
        actions.updateNoteInList({ id: updated.id, title: updated.title, contentText: updated.contentText, updatedAt: updated.updatedAt });
        actions.updateNoteTab({
          id: updated.id,
          title: updated.title,
          updatedAt: updated.updatedAt,
          contentFormat: currentNote.contentFormat,
          isLocked: currentNote.isLocked,
          isTrashed: currentNote.isTrashed,
        });
        actions.setSyncStatus("saved");
        actions.setLastSynced(new Date().toISOString());
        // 2���ָ� idle
        if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
        savedTimerRef.current = setTimeout(() => actions.setSyncStatus("idle"), 2000);

        // P2-5: ����ɹ� �� ������زݸ壬����������ʧ�ܼ���
        try { clearDraft(currentNote.id); } catch { /* ignore */ }
        consecutiveSaveFailRef.current = 0;
      }
    } catch (err) {
      // �бʼ��жϣ�putWithReconcile �ڲ����Ϊ aborted�����������Ĵ���
      if (isAborted(err)) return;
      console.warn("[EditorPane] save failed:", err);

      // ������ P0-1 ������ӣ����� / ����˲��ɴ�ʹ save �״�ʱ�� ����������������������������
      // �ѱ༭����ǰ���� snapshot �������߶��У�������ָ����Զ� flush��
      // ��һ��ʹ�û�"�������¼������������"������Ϊ saveInflight ��������
      // ������������ �� ��ʹ api.ts ����������δ���� handleOfflineEnqueue
      // ������ fetch ���� 4xx ������ retryable �����У�Ҳ���ṩһ��������
      try {
        const snap = editorHandleRef.current?.getSnapshot?.();
        if (snap && typeof snap.content === "string") {
          enqueueOfflineMutation({
            type: "updateNote",
            noteId: currentNote.id,
            url: `/notes/${currentNote.id}`,
            method: "PUT",
            body: {
              title: data.title,
              content: snap.content,
              contentText: snap.contentText,
              contentFormat: currentNote.contentFormat,
              version: currentNote.version,
            },
          });
        }
      } catch (queueErr) {
        console.warn("[EditorPane] enqueue offline fallback failed:", queueErr);
      }

      // P1-4: �������α���ʧ�� �� toast �����û�"����δ�������ݴ汾��"
      // ������ͬһ�ʼ� 30s ��ֻ����һ�Σ�����ˢ��
      try {
        consecutiveSaveFailRef.current += 1;
        const noteId = currentNote.id;
        const now = Date.now();
        const last = lastSaveFailToastAtRef.current[noteId] || 0;
        if (consecutiveSaveFailRef.current >= 2 && now - last > 30000) {
          lastSaveFailToastAtRef.current[noteId] = now;
      toast.error(t("editor.saveFailedDraftKept") || "网络不稳定，已保存本地草稿版本，可稍后恢复或自动上传");
        }
      } catch { /* ignore */ }

      actions.setSyncStatus("error");
    }
    })();

    saveInflightRef.current = inflight;
    try {
      await inflight;
    } finally {
      // ֻ���"�Լ�"ע����Ƿݣ����ڼ������� PUT ע���� promise����������
      if (saveInflightRef.current === inflight) {
        saveInflightRef.current = null;
      }
    }
  }, [actions, flagEditing]);

  // ���� handleUpdateRef ����ָ������ handleUpdate���� P2-5 �ݸ�ָ����ã�
  useEffect(() => {
    handleUpdateRef.current = handleUpdate;
  }, [handleUpdate]);

  // �ֶ�����ͬ�������±��浱ǰ�༭������
  const handleManualSync = useCallback(async () => {
    if (!activeNote || syncStatus === "saving") return;
    actions.setSyncStatus("saving");
    try {
      const updated = await api.updateNote(activeNote.id, {
        title: activeNote.title,
        content: activeNote.content,
        contentText: activeNote.contentText,
        contentFormat: activeNote.contentFormat,
        version: activeNote.version,
      } as any);
      actions.setActiveNote(updated);
      actions.updateNoteInList({ id: updated.id, title: updated.title, contentText: updated.contentText, updatedAt: updated.updatedAt });
      actions.updateNoteTab({
        id: updated.id,
        title: updated.title,
        updatedAt: updated.updatedAt,
        contentFormat: updated.contentFormat,
        isLocked: updated.isLocked,
        isTrashed: updated.isTrashed,
      });
      actions.setSyncStatus("saved");
      actions.setLastSynced(new Date().toISOString());
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
      savedTimerRef.current = setTimeout(() => actions.setSyncStatus("idle"), 2000);
    } catch {
      actions.setSyncStatus("error");
    }
  }, [activeNote, syncStatus, actions]);

  const toggleFavorite = useCallback(async () => {
    if (!activeNote || activeNote.isTrashed) return;
    haptic.light();
    const updated = await api.updateNote(activeNote.id, { isFavorite: activeNote.isFavorite ? 0 : 1 } as any);
    actions.setActiveNote(updated);
    actions.updateNoteInList({ id: updated.id, isFavorite: updated.isFavorite });
  }, [activeNote, actions]);

  const togglePin = useCallback(async () => {
    if (!activeNote || activeNote.isTrashed) return;
    haptic.light();
    const updated = await api.updateNote(activeNote.id, { isPinned: activeNote.isPinned ? 0 : 1 } as any);
    actions.setActiveNote(updated);
    actions.updateNoteInList({ id: updated.id, isPinned: updated.isPinned });
  }, [activeNote, actions]);

  const toggleLock = useCallback(async () => {
    if (!activeNote || activeNote.isTrashed) return;
    haptic.medium();
    // ���Ƚ��"�Ự��"���û�ƫ��"�򿪼�����"��ɵ���ʱֻ������
    //   - ���ﱾ�� isLocked=1���Ǿ������߼��� DB��
    //   - ���� isLocked=0 �����Ự��ƫ����ס��ֻ�Ƴ����ؼ��ϼ��ɣ���д��ˣ�
    //     ����һ��"��ʱ����"�����ó־û�Ϊ�ñʼǵĿ�״̬��
    if (!activeNote.isLocked && viewLockedIds.has(activeNote.id)) {
      setViewLockedIds((prev) => {
        if (!prev.has(activeNote.id)) return prev;
        const next = new Set(prev);
        next.delete(activeNote.id);
        return next;
      });
      return;
    }
    const updated = await api.updateNote(activeNote.id, { isLocked: activeNote.isLocked ? 0 : 1 } as any);
    actions.setActiveNote(updated);
    actions.updateNoteInList({ id: updated.id, isLocked: updated.isLocked });
    actions.updateNoteTab({ id: updated.id, isLocked: updated.isLocked, updatedAt: updated.updatedAt });
    // ���հѿ����е� 1�����������Ͳ����ٶ���ά�ֱ��ػỰ�����������Ѿ����ǡ�
    // ���ѿ����е� 0����������ͬʱ������Ự�ĻỰ��������У�����֤ UI һ�ν�����λ��
    if (!updated.isLocked) {
      setViewLockedIds((prev) => {
        if (!prev.has(activeNote.id)) return prev;
        const next = new Set(prev);
        next.delete(activeNote.id);
        return next;
      });
    }
  }, [activeNote, actions, viewLockedIds]);

    // NOTE-IMAGE-EXPORT-01: 导出笔记为图片
  const handleExportNoteImage = useCallback(async (format: "png" | "jpg") => {
    if (!activeNote) return;
    const toastId = toast.info(t("note.exportImageExporting"), 0);
    try {
      const ok = await exportNoteAsImage(
        {
          id: activeNote.id,
          title: activeNote.title,
          content: activeNote.content,
          contentText: activeNote.contentText,
          contentFormat: activeNote.contentFormat,
          updatedAt: activeNote.updatedAt,
        },
        { format }
      );
      toast.dismiss(toastId);
      ok ? toast.success(t("note.exportImageSuccess")) : toast.error(t("note.exportImageFailed"));
    } catch {
      toast.dismiss(toastId);
      toast.error(t("note.exportImageFailed"));
    }
  }, [activeNote, t]);
const moveToTrash = useCallback(async () => {
    // ������������Ự�����ʼǲ�����������վ������"�������ʼ�"����ɾ��
    if (!activeNote || activeNote.isLocked || activeNote.isTrashed || viewLockedIdsRef.current.has(activeNote.id)) return;
    haptic.heavy();
    const noteId = activeNote.id;
    const currentTabIndex = state.openNoteTabs.findIndex((tab) => tab.id === noteId);
    const nextTab = userPrefs.enableNoteTabs && currentTabIndex >= 0
      ? state.openNoteTabs[currentTabIndex + 1] || state.openNoteTabs[currentTabIndex - 1] || null
      : null;
    actions.setActiveNote(null);
    actions.removeNoteFromList(noteId);
    actions.removeNoteTab(noteId);
    if (nextTab) {
      actions.setNoteLoading(true);
      api.getNote(nextTab.id)
        .then((nextNote) => {
          actions.setActiveNote(nextNote);
          actions.openNoteTab({
            id: nextNote.id,
            title: nextNote.title,
            notebookId: nextNote.notebookId,
            workspaceId: nextNote.workspaceId,
            contentFormat: nextNote.contentFormat,
            isLocked: nextNote.isLocked,
            isTrashed: nextNote.isTrashed,
            updatedAt: nextNote.updatedAt,
          });
        })
        .catch(console.error)
        .finally(() => actions.setNoteLoading(false));
    }
    api.updateNote(noteId, { isTrashed: 1 } as any)
      .then(() => {
        actions.refreshNotebooks();
        // ˢ���б�������ǰ����"����վ"��ͼ�������ʼ���Ҫ�������֣�
        // ������ͼҲ������һ�£���֤������һ�¡�
        actions.refreshNotes();
      })
      .catch(console.error);
  }, [activeNote, actions, state.openNoteTabs, userPrefs.enableNoteTabs]);

  // BLOCK-LINKS-JUMP-01: 打开笔记回调（用于笔记引用跳转）
  const handleOpenNote = useCallback(async (noteId: string) => {
    try {
      const note = await api.getNote(noteId);
      if (note) {
        actions.setActiveNote(note);
      }
    } catch (err: any) {
      console.error("Failed to open note:", err);
      const msg = err?.message || "";
      if (msg.includes("not found") || msg.includes("404")) {
        toast.error(t("noteLink.noteNotFound", { defaultValue: "笔记不存在或已删除" }));
      } else if (msg.includes("forbidden") || msg.includes("403")) {
        toast.error(t("noteLink.noPermission", { defaultValue: "无权访问该笔记" }));
      } else {
        toast.error(t("noteLink.openFailed", { defaultValue: "打开笔记失败" }));
      }
    }
  }, [actions, t]);

  const handleTagsChange = useCallback((tags: Tag[]) => {
    if (!activeNote) return;
    actions.setActiveNote({ ...activeNote, tags });
    api.getTags().then(actions.setTags).catch(console.error);
  }, [activeNote, actions]);

  // AI ���ɱ���
  const [aiTitleLoading, setAiTitleLoading] = useState(false);
  const handleAITitle = useCallback(async () => {
    if (!activeNote || !activeNote.contentText || aiTitleLoading) return;
    setAiTitleLoading(true);
    try {
      // 1) �Ȱѱ༭���� pending �� debounce �Ķ� flush ��ȥ�����⣺
      //    - AI ���ڹ��ڵ� contentText ���ɱ���
      //    - �Ժ� updateNote �� version ��󱻺�˷��� 409 "Version conflict"
      //      ���±�������Ĭʧ�ܣ�֮ǰֻ console.error���û��������κη�������
      try { editorHandleRef.current?.flushSave(); } catch { /* ignore */ }

      // 2) AI ����
      const titleCtx = buildAiContext({ action: "title", title: activeNote.title, contentText: activeNote.contentText, maxInputTokens: 1500 });
      if (titleCtx.notice) toast.info(titleCtx.notice);
      const rawTitle = await api.aiChat("title", titleCtx.promptText);
      const cleaned = extractFinalAnswer(rawTitle).replace(/^["‘’“”'']+|["‘’“”'']+$/g, "").trim()
      if (!cleaned) {
      toast.error(t("editor.aiTitleFailed") || "AI 未返回有效标题");
        return;
      }

      // 3) д����⣺���ֹ�����ͻ��һ�������ԡ�
      //    MD �༭�� debounce ��Ȼ�� flush���� AI �����ʱ���û��Կ��ܼ�������
      //    �� ���� �� version ������������� 409�������������±ʼ����� version ���ԡ�
      const doUpdate = async (version: number) =>
        api.updateNote(activeNote.id, { title: cleaned, contentFormat: activeNote.contentFormat, version } as any);

      let updated;
      try {
        updated = await doUpdate(activeNote.version);
      } catch (err: any) {
        if (is409Error(err)) {
          actions.setSyncStatus("error");
          toast.error(t("editor.versionConflict") || "内容已被其他设备更新，请刷新或打开版本历史处理");
          return;
        }
        throw err;
      }

      // 4) ͬ��ǰ��״̬��MarkdownEditor ���ж����� [note.title] effect
      //    ��ѷ��ܿ� title input �� DOM ֵˢ�³��±��⡣
      actions.setActiveNote(updated);
      actions.updateNoteInList({ id: updated.id, title: updated.title, updatedAt: updated.updatedAt });
      actions.updateNoteTab({
        id: updated.id,
        title: updated.title,
        updatedAt: updated.updatedAt,
        contentFormat: updated.contentFormat,
        isLocked: updated.isLocked,
        isTrashed: updated.isTrashed,
      });
      toast.success(t("editor.aiTitleApplied") || "已应用 AI 生成的标题");
    } catch (e: any) {
      console.error("AI title error:", e);
      toast.error(e?.message || t("editor.aiTitleFailed") || "AI 生成标题失败");
    } finally {
      setAiTitleLoading(false);
    }
  }, [activeNote, actions, aiTitleLoading, t]);

  // AI �Ƽ���ǩ
  const [aiTagsLoading, setAiTagsLoading] = useState(false);
  const handleAITags = useCallback(async () => {
    if (!activeNote || !activeNote.contentText || aiTagsLoading) return;
    setAiTagsLoading(true);
    try {
      const tagsCtx = buildAiContext({ action: "tags", title: activeNote.title, contentText: activeNote.contentText, maxInputTokens: 1800 });
      if (tagsCtx.notice) toast.info(tagsCtx.notice);
      const raw = await api.aiChat("tags", tagsCtx.promptText);
      const tagNames = parseAiTags(raw, 5);
      if (tagNames.length === 0) {
        toast.error(t("editor.aiTagsFailed") || "AI 未返回有效标签");
        setAiTagsLoading(false);
        return;
      }
      for (const name of tagNames) {
        // ����Ƿ��Ѵ���
        const existing = state.tags.find(t => t.name === name);
        let tagId: string;
        if (existing) {
          tagId = existing.id;
        } else {
          const newTag = await api.createTag({ name });
          tagId = newTag.id;
        }
        // ����Ƿ��ѹ���
        const noteTags = activeNote.tags || [];
        if (!noteTags.find(t => t.id === tagId)) {
          await api.addTagToNote(activeNote.id, tagId);
        }
      }
      // ���»�ȡ�ʼǺͱ�ǩ
      const updatedNote = await api.getNote(activeNote.id);
      actions.setActiveNote(updatedNote);
      api.getTags().then(actions.setTags).catch(console.error);
    } catch (e: any) { console.error("AI tags error:", e); toast.error(e?.message || t("editor.aiTagsFailed") || "AI 推荐标签失败"); }
    setAiTagsLoading(false);
  }, [activeNote, actions, state.tags, aiTagsLoading]);

  // AI �ܽ�
  const [aiSummaryLoading, setAiSummaryLoading] = useState(false);
  const [aiSummaryResult, setAiSummaryResult] = useState("");
  const [showSummaryDialog, setShowSummaryDialog] = useState(false);

  const handleAISummary = useCallback(async () => {
    if (!activeNote || aiSummaryLoading) return;
    const snap = editorHandleRef.current?.getSnapshot?.();
    const text = (snap?.contentText || activeNote.contentText || "").trim();
    if (!text) {
      toast.error(t("editor.aiSummaryEmptyContent") || "当前笔记内容为空，无法总结");
      return;
    }
    setAiSummaryLoading(true);
    setAiSummaryResult("");
    setShowSummaryDialog(true);
    try {
      const summaryCtx = buildAiContext({ action: "summarize", title: activeNote.title, contentText: text, maxInputTokens: 1800 });
      if (summaryCtx.notice) toast.info(summaryCtx.notice);
      let result: string;
      if (summaryCtx.strategy === "chunked" && summaryCtx.chunks && summaryCtx.chunks.length > 1) {
        const partials: string[] = [];
        for (const chunk of summaryCtx.chunks) {
          const partial = await api.aiChat("summarize", chunk.text);
          partials.push(partial.trim());
        }
        result = await api.aiChat("summarize", partials.join("\n\n---\n\n"));
      } else {
        result = await api.aiChat("summarize", summaryCtx.promptText);
      }
      result = extractFinalAnswer(result)
      if (!result.trim()) {
      toast.error(t("editor.aiSummaryEmptyResult") || "AI 未返回有效总结");
        setShowSummaryDialog(false);
        return;
      }
      setAiSummaryResult(result.trim());
    } catch (e: any) {
      console.error("AI summary error:", e);
      toast.error(e?.message || "AI 总结失败");
      setShowSummaryDialog(false);
    } finally {
      setAiSummaryLoading(false);
    }
  }, [activeNote, aiSummaryLoading, t]);

  const handleSummaryCopy = useCallback(async () => {
    if (!aiSummaryResult) return;
    try {
      await navigator.clipboard.writeText(aiSummaryResult);
      toast.success(t("editor.aiSummaryCopied") || "已复制");
    } catch {
      toast.error("复制失败");
    }
  }, [aiSummaryResult, t]);

  const handleSummaryAppend = useCallback(async () => {
    if (!activeNote || !aiSummaryResult) return;
      const md = "\n\n## AI 总结\n\n" + aiSummaryResult + "\n";
    const appended = editorHandleRef.current?.appendMarkdown?.(md);
    if (!appended) {
      // �༭����֧�� appendMarkdown��fallback ��������
      try {
        await navigator.clipboard.writeText(aiSummaryResult);
      toast.success(t("editor.aiSummaryCopied") || "已复制到剪贴板，请手动粘贴");
      } catch {
      toast.error("追加失败，请手动插入");
      }
      return;
    }
    // ��������
    try { editorHandleRef.current?.flushSave(); } catch { /* ignore */ }
      toast.success(t("editor.aiSummaryAppended") || "已追加到笔记末尾");
    setShowSummaryDialog(false);
  }, [activeNote, aiSummaryResult, t]);

  // AI ���� Mermaid
  const [aiMermaidLoading, setAiMermaidLoading] = useState(false);
  const [aiMermaidResult, setAiMermaidResult] = useState("");
  const [aiMermaidType, setAiMermaidType] = useState<"mermaid_mindmap" | "mermaid_flowchart">("mermaid_mindmap");
  const [showMermaidDialog, setShowMermaidDialog] = useState(false);

  const handleAIMermaid = useCallback(async (type: "mermaid_mindmap" | "mermaid_flowchart") => {
    if (!activeNote || aiMermaidLoading) return;
    const snap = editorHandleRef.current?.getSnapshot?.();
    const text = (snap?.contentText || activeNote.contentText || "").trim();
    if (!text) {
      toast.error(t("editor.aiSummaryEmptyContent") || "当前笔记内容为空");
      return;
    }
    setAiMermaidLoading(true);
    setAiMermaidResult("");
    setAiMermaidType(type);
    setShowMermaidDialog(true);
    try {
      const mermaidCtx = buildAiContext({ action: type, title: activeNote.title, contentText: text, maxInputTokens: 3000 });
      if (mermaidCtx.notice) toast.info(mermaidCtx.notice);
      let result = await api.aiChat(type, mermaidCtx.promptText)
      // ��ϴ��ȥ��Χ��
      result = result.replace(/^```mermaid\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```\s*$/, "").trim();
      // 从 AI 返回文本中提取 mermaid 源码（AI 可能返回思考过程 + 源码）
      const mindmapMatch = result.match(/^(mindmap[\s\S]*)/m);
      const flowchartMatch = result.match(/^(flowchart\s+TD[\s\S]*)/m);
      if (mindmapMatch) {
        result = mindmapMatch[1].trimEnd();
      } else if (flowchartMatch) {
        result = flowchartMatch[1].trimEnd();
      }
      // Sanitize: strip chars that break Mermaid mindmap parsing
      result = result.replace(/^(\s*\S+\s+)(.*?)(\s*)$/gm, (_m: string, prefix: string, body: string, tail: string) => {
        return prefix + body.replace(/[[\]{}:|]/g, " ") + tail;
      });
      if (!result) {
      toast.error(t("editor.aiSummaryEmptyResult") || "AI 未返回有效思维导图");
        setShowMermaidDialog(false);
        return;
      }
      setAiMermaidResult(result);
    } catch (e: any) {
      console.error("AI mermaid error:", e);
      toast.error(e?.message || "AI 生成失败");
      setShowMermaidDialog(false);
    } finally {
      setAiMermaidLoading(false);
    }
  }, [activeNote, aiMermaidLoading, t]);

  const handleMermaidInsert = useCallback(() => {
    if (!activeNote || !aiMermaidResult) return;
    const md = "\n\n```mermaid\n" + aiMermaidResult + "\n```\n";
    const appended = editorHandleRef.current?.appendMarkdown?.(md);
    if (!appended) {
      try {
        navigator.clipboard.writeText("```mermaid\n" + aiMermaidResult + "\n```");
      toast.success(t("editor.aiSummaryCopied") || "已复制到剪贴板，请手动粘贴");
    } catch { toast.error("复制失败"); }
      return;
    }
    try { editorHandleRef.current?.flushSave(); } catch {}
      toast.success("已插入笔记");
    setShowMermaidDialog(false);
  }, [activeNote, aiMermaidResult, t]);
  /** 将 Mermaid mindmap 源码解析为 MindMapData */
  const parseMermaidToMindMap = useCallback((source: string): MindMapData | null => {
    try {
      const data = parseMermaidMindmap(source);
      return normalizeMindMapData(data);
    } catch {
      return null;
    }
  }, []);

  const [mermaidSavingMindMap, setMermaidSavingMindMap] = useState(false);
  const handleMermaidSaveAsMindMap = useCallback(async () => {
    if (!aiMermaidResult) return;
    const data = parseMermaidToMindMap(aiMermaidResult);
    if (!data) {
      toast.error("无法将当前 Mermaid 转换为思维导图");
      return;
    }
    setMermaidSavingMindMap(true);
    try {
      const title = data.root.text.slice(0, 50) || "AI 生成思维导图";
      const created = await api.createMindMap({ title, data: JSON.stringify(data) });
      toast.success("已保存为思维导图");
      setShowMermaidDialog(false);
      // 通知 MindMapEditor 打开新图
      // 切换到思维导图视图
      // 保存 pending ID 到 sessionStorage 并切换到思维导图视图
      sessionStorage.setItem("pendingOpenMindMapId", created.id);
      actions.setViewMode("mindmaps");
    } catch (e: any) {
      console.error("Save mindmap error:", e);
      toast.error(e?.message || "保存失败");
    } finally {
      setMermaidSavingMindMap(false);
    }
  }, [aiMermaidResult, parseMermaidToMindMap]);

  const handleMoveToNotebook = useCallback(async (notebookId: string) => {
    if (!activeNote || notebookId === activeNote.notebookId) return;
    // ���� try/catch����˶Կ繤�����ƶ��᷵�� 400 CROSS_WORKSPACE_MOVE_FORBIDDEN��
    // ���������ð�ݳ� "Uncaught (in promise)" ����������ʶ������������ȷ��ʾ��
    try {
      const updated = await api.updateNote(activeNote.id, { notebookId } as any);
      actions.setActiveNote(updated);
      actions.updateNoteInList({ id: updated.id, notebookId: updated.notebookId });
      actions.updateNoteTab({ id: updated.id, notebookId: updated.notebookId, updatedAt: updated.updatedAt });
      setShowMoveDropdown(false);
      actions.refreshNotebooks();
    } catch (e: any) {
      const msg = String(e?.message || "");
      if (/CROSS_WORKSPACE_MOVE_FORBIDDEN/.test(msg)) {
      toast.error("无法在不同工作空间的笔记本之间移动");
      } else {
      toast.error(msg || "移动失败");
      }
      setShowMoveDropdown(false);
    }
  }, [activeNote, actions]);

  // ---- P3��AI �Զ����ཨ�� ----
  // ���"AI �������"��һ�� /ai/classify���� top-3 ������Ⱦ����������ڡ�
  // ��������ڼ䰴ť disabled��ʧ��ʱ�� toast ��ʾ���������û���ѡ��
  // ÿ�� activeNote �仯��ս��飬���⿴����һ���ʼǵľɽ����
  const [aiSuggestions, setAiSuggestions] = useState<{
    notebookId: string;
    notebookName: string;
    path: string;
    confidence: number;
    reason: string;
  }[] | null>(null);
  const [aiClassifyLoading, setAiClassifyLoading] = useState(false);

  useEffect(() => {
    setAiSuggestions(null);
  }, [activeNote?.id]);

  const handleAiClassify = useCallback(async () => {
    if (!activeNote || aiClassifyLoading) return;
    setAiClassifyLoading(true);
    try {
      const res = await api.aiClassify({ noteId: activeNote.id });
      // ���˵�"���ǵ�ǰ�ʼǱ�"�Ľ��顪��û������
      const filtered = res.suggestions.filter(
        (s) => s.notebookId !== activeNote.notebookId,
      );
      setAiSuggestions(filtered);
      if (filtered.length === 0) {
      toast.info(t("editor.aiClassifyNoSuggestion") || "AI 未找到合适的工作笔记本");
      }
    } catch (e: any) {
      toast.error(e?.message || t("editor.aiClassifyFailed") || "AI 自动分类失败");
    } finally {
      setAiClassifyLoading(false);
    }
  }, [activeNote, aiClassifyLoading, t]);

  // ���������������ȫһ�µıʼǱ���
  //
  // ��"�ƶ����ʼǱ�"�ĺ�ѡ�����ϸ�������**��ǰ�ʼ����ڵ� workspace**��
  // ��� PUT /notes/:id ��ǿ��Դ/Ŀ��ͬ workspace��������ǰ���� guard����
  // �û������������Ǹɾ���ͬ�ռ���������㵽��Ȼ�ᱻ 400 �ܾ��ıʼǱ���
  // workspaceId ��һ��undefined/"" ������ null��= ���˿ռ䣩��
  const notebookTree = useMemo(() => {
    const srcWs = (activeNote?.workspaceId || null) as string | null;
    const sameWsNotebooks = activeNote
      ? state.notebooks.filter((nb) => (nb.workspaceId || null) === srcWs)
      : state.notebooks;
    return buildTree(sameWsNotebooks);
  }, [state.notebooks, activeNote]);
  // ��ǰ�ʼ������ʼǱ�������·�������м��
  const currentPath = useMemo(
    () => findPathById(state.notebooks, activeNote?.notebookId),
    [state.notebooks, activeNote?.notebookId]
  );

  // ���� �ʼǼ����йǼ��� ����
  // �ڵ���ʼ��б������ݻ�û����ǰ��ʾ����̬
  if (noteLoading && !activeNote) {
    return (
      <div className="flex-1 flex flex-col bg-app-bg overflow-hidden transition-colors">
        {/* 未读消息数 */}
        <div className="flex items-center gap-3 px-6 py-4 border-b border-app-border">
          <div className="h-7 w-48 rounded-md bg-app-hover animate-pulse" />
          <div className="ml-auto flex items-center gap-2">
            <div className="h-7 w-7 rounded-md bg-app-hover animate-pulse" />
            <div className="h-7 w-7 rounded-md bg-app-hover animate-pulse" />
          </div>
        </div>
        {/* 未读消息数 */}
        <div className="flex-1 px-6 py-6 space-y-4">
          <div className="h-8 w-3/5 rounded-md bg-app-hover animate-pulse" />
          <div className="space-y-3 mt-6">
            <div className="h-4 w-full rounded bg-app-hover animate-pulse" />
            <div className="h-4 w-11/12 rounded bg-app-hover animate-pulse" />
            <div className="h-4 w-4/5 rounded bg-app-hover animate-pulse" />
            <div className="h-4 w-full rounded bg-app-hover animate-pulse" />
            <div className="h-4 w-3/4 rounded bg-app-hover animate-pulse" />
          </div>
          <div className="space-y-3 mt-4">
            <div className="h-4 w-full rounded bg-app-hover animate-pulse" />
            <div className="h-4 w-5/6 rounded bg-app-hover animate-pulse" />
            <div className="h-4 w-2/3 rounded bg-app-hover animate-pulse" />
          </div>
        </div>
      </div>
    );
  }

  if (!activeNote) {
    return (
      <div className="flex-1 flex flex-col bg-app-bg transition-colors relative">
        {/* ����˿�̬��ҲҪ����"չ���ʼ��б�"��ڣ�����һ���۵�+��ѡ�бʼǣ�������Ļ
            ��ֻʣ NavRail���û��Ҳ����κλص��б��ķ�ʽ��ͼƬ�������� bug����
            ���ɾ��Զ�λ�����Ͻǣ������ƻ�ԭ�����еĿ�̬�Ӿ��� */}
        {state.noteListCollapsed && (
          <button
            type="button"
            onClick={() => actions.toggleNoteListCollapsed()}
            title={t("common.expandList")}
            aria-label={t("common.expandList")}
            className="hidden md:flex absolute top-3 left-3 z-10 p-1.5 rounded-md text-tx-tertiary hover:bg-app-hover hover:text-tx-secondary transition-colors"
          >
            <PanelLeft size={16} />
          </button>
        )}
        {/* �ƶ��ˣ��������ذ�ť + ��ʾ��
            ������ԭ��̬�� `hidden md:flex` �����ݲ��������ƶ����е� editor ��ͼ��
            ���� activeNote ʱ��ĻһƬ�հף��û��Ҳ����ص��б�����ڣ�ϵͳ���ؼ�
            ��Ȼ�ܴ��� onBackToList���������û�/���Ƶ��������²���ֱ�ۣ���������
            ����"��ʼ�û��Ӧ"�����ﲹһ���ƶ��˿ɼ��ķ���������İ�����Ϊ���ס� */}
        <header className="flex items-center gap-2 px-3 py-2 border-b border-app-border bg-app-surface/50 md:hidden" style={{ paddingTop: 'calc(var(--safe-area-top) + 8px)' }}>
          <button
            onClick={() => actions.setMobileView("list")}
            className="flex items-center text-accent-primary py-1.5 px-1.5 -ml-1.5 rounded-lg active:bg-app-hover"
          >
            <ChevronLeft size={24} />
            <span className="text-sm font-medium">{t('editor.back')}</span>
          </button>
        </header>
        <div className="flex-1 flex items-center justify-center px-6">
          {/* �����ԭ�п�̬�������Ӿ����䣩 */}
          <div className="text-center hidden md:flex flex-col items-center">
            <div className="relative mb-6">
              <div className="w-20 h-20 rounded-2xl bg-accent-primary/5 border border-accent-primary/10 flex items-center justify-center">
                <svg width="36" height="36" viewBox="0 0 24 24" fill="none" className="text-accent-primary/30">
                  <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                  <polyline points="14,2 14,8 20,8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                  <line x1="8" y1="13" x2="16" y2="13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                  <line x1="8" y1="17" x2="12" y2="17" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                </svg>
              </div>
              <div className="absolute -bottom-1 -right-1 w-6 h-6 rounded-full bg-accent-primary/10 border border-accent-primary/15 flex items-center justify-center">
                <span className="text-accent-primary/50 text-xs">?</span>
              </div>
            </div>
            <p className="text-tx-secondary text-sm font-medium mb-1">{t('editor.selectNote')}</p>
            <p className="text-tx-tertiary text-xs max-w-[220px] leading-relaxed">{t('editor.orCreateNew')}</p>
            <div className="flex items-center gap-3 mt-5">
              <kbd className="px-2 py-1 rounded-md bg-app-hover border border-app-border text-[10px] text-tx-tertiary font-mono">Alt+N</kbd>
<span className="text-[10px] text-tx-tertiary">{t("editor.newNoteShortcut") || "新建笔记"}</span>
            </div>
          </div>
          {/* �ƶ��˼򻯿�̬�������� header ����ṩ�����ɵ㽻���� */}
          <div className="text-center md:hidden flex flex-col items-center">
            <div className="w-16 h-16 rounded-2xl bg-accent-primary/5 border border-accent-primary/10 flex items-center justify-center mb-4">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" className="text-accent-primary/30">
                <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                <polyline points="14,2 14,8 20,8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </div>
            <p className="text-tx-secondary text-sm font-medium mb-1">{t('editor.selectNote')}</p>
            <p className="text-tx-tertiary text-xs max-w-[240px] leading-relaxed">{t('editor.orCreateNew')}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <motion.div
      key={activeNote.id}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.15 }}
      className="flex-1 flex flex-col bg-app-bg overflow-hidden transition-colors relative"
    >
      {/* �ʼ��л� loading ���� */}
      <AnimatePresence>
        {noteLoading && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.12 }}
            className="absolute inset-0 z-50 flex items-center justify-center bg-app-bg/60 backdrop-blur-[2px]"
          >
            <div className="flex flex-col items-center gap-3">
              <Loader2 size={24} className="animate-spin text-accent-primary" />
              <span className="text-xs text-tx-tertiary">{t('editor.noteLoading')}</span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      {/* Mobile Editor Header �� iOS ���˫�нṹ
          �� 1 �У����� + ���м���ʼǱ�·����+ ͬ��״̬
          �� 2 �У���ǰ�ʼǱ��⣨�ضϣ�+ �ղ� + ����
          ˵����
            - С���������ޣ�ԭ��һ���� 5 ��ͼ�갴ť�Ѽ�ѹ���ҿ������ʼǱ�·������⣻
            - ��/�ö�����Ƶ���أ�Ų�� ? �˵����˵����ﷴӳ��ǰ״̬��
            - Presence ͷ����С�����岻���ƶ��˲���Ⱦ������˱����� */}
      <header className="flex flex-col border-b border-app-border bg-app-surface/50 md:hidden" style={{ paddingTop: 'var(--safe-area-top)' }}>
        {/* �� 1 �У����� + ���м + ͬ�� */}
        <div className="flex min-w-0 items-center gap-2 px-3 pt-2 pb-1">
          <button
            onClick={() => actions.setMobileView("list")}
            className="flex items-center text-accent-primary py-1 px-1 -ml-1 rounded-lg active:bg-app-hover shrink-0"
            aria-label={t('editor.back')}
          >
            <ChevronLeft size={22} />
          </button>
          {/* ���м������·�������һ�μӴ�ǿ���������ɹ�������ضϳ� "..."
              �������"�ƶ����ʼǱ�"�˵�������������м�ɵ��������һ�£� */}
          <button
            onClick={() => { setShowMobileMenu(true); setShowMobileMoveMenu(true); }}
            className="flex-1 min-w-0 flex items-center gap-1 text-xs text-tx-tertiary active:bg-app-hover rounded-md px-1.5 py-1 overflow-hidden"
            title={t('editor.moveToNotebook')}
          >
            {currentPath.length > 0 ? (
              <span className="flex min-w-0 items-center gap-1 overflow-hidden">
                {currentPath.map((nb, idx) => {
                  const isLast = idx === currentPath.length - 1;
                  return (
                    <React.Fragment key={nb.id}>
                      {idx > 0 && <ChevronRight size={10} className="text-tx-tertiary/60 shrink-0" />}
                      <span className={cn("flex min-w-0 items-center gap-0.5", isLast ? "text-tx-secondary font-medium" : "shrink-0")}>
                        <span className="leading-none">{getNotebookIcon(nb.icon)}</span>
                        <span className={cn("truncate", isLast ? "max-w-[120px]" : "max-w-[64px]")}>{nb.name}</span>
                      </span>
                    </React.Fragment>
                  );
                })}
              </span>
            ) : (
              <span className="shrink-0 leading-none">{getNotebookIcon()}</span>
            )}
          </button>
          <div className="shrink-0">
            <SyncIndicator syncStatus={syncStatus} lastSyncedAt={lastSyncedAt} onManualSync={handleManualSync} />
          </div>
        </div>
        {/* �� 2 �У����� + �ղ� + ���� */}
        <div className="flex items-center gap-1 px-3 pb-2 pt-0.5">
          <div className="flex-1 min-w-0 flex items-center gap-1.5">
            {/* ��/�ö� ״̬���£�ֻ��ʾ�Ѽ���״̬��δ���ռλ��
                ע�⣺isLocked / isPinned �� SQLite ���� 0/1��ֱ�� `value && <Icon/>`
                �� value=0 ʱ��·��������� 0��React ��� 0 ���ı���Ⱦ��������
                ���������������ʽ�����жϣ�����ҳ��������� "0"�� */}
            {/* ����ǰ����ͼ�꣺���������ó�ɫ��ʾ���־�������
                ֻ�ǻỰ����ƫ�á��򿪼���������ɣ��ø�ǳ�Ļ�ɫ����������״̬�� */}
            {activeNote.isLocked
              ? <Lock size={13} className="text-orange-500 shrink-0" />
              : isViewLocked
                ? <Lock size={13} className="text-tx-tertiary shrink-0" />
                : null}
            {activeNote.isPinned ? <Pin size={13} className="text-accent-primary fill-accent-primary shrink-0" /> : null}
            <span className="truncate text-sm font-semibold text-tx-primary">
              {activeNote.title || t('editor.untitled')}
            </span>
          </div>
          {/* ���� / �������ƶ��˹̶���������ť��࣬���ֳ�������ȶ��ɼ��� */}
          <Button
            variant="ghost" size="icon" className="h-8 w-8 shrink-0"
            onClick={toggleLock}
            disabled={isTrashed}
            aria-label={effectiveLocked ? t('editor.unlockTooltip') : t('editor.lockTooltip')}
            title={isTrashed ? t('editor.trashTooltip') : effectiveLocked ? t('editor.unlockTooltip') : t('editor.lockTooltip')}
          >
            {effectiveLocked
              ? <Lock size={17} className="text-orange-500" />
              : <Unlock size={17} className="text-tx-tertiary" />}
          </Button>
          {/* �����������滻�����ƶ��˸�Ƶ�������ᵽ��������������
              ͨ���Զ����¼� 'nowen:open-search' ���� TiptapEditor �ڲ��� SearchReplacePanel��
              ����� TiptapEditor ���ڲ� state �������ⲿ����������ӿڸɾ��� */}
          <Button
            variant="ghost" size="icon" className="h-8 w-8 shrink-0"
            onClick={() => window.dispatchEvent(new CustomEvent('nowen:open-search'))}
            aria-label={t('editor.searchInNote')}
          >
            <Search size={17} />
          </Button>
          <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={toggleFavorite}
            disabled={isTrashed}
            aria-label={activeNote.isFavorite ? t('editor.unfavoriteTooltip') : t('editor.favoriteTooltip')}>
            <Star size={17} className={cn(activeNote.isFavorite && "text-amber-400 fill-amber-400")} />
          </Button>
          {/* ���������ť */}
          <div className="relative shrink-0" ref={mobileMenuRef}>
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => { setShowMobileMenu(!showMobileMenu); setShowMobileMoveMenu(false); }}>
              <MoreHorizontal size={16} />
            </Button>
            {/* ������������˵� */}
            <AnimatePresence>
              {showMobileMenu && (
                <motion.div
                  initial={{ opacity: 0, scale: 0.95, y: -4 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.95, y: -4 }}
                  transition={{ duration: 0.12 }}
                  className="absolute top-full right-0 mt-1 w-56 bg-app-elevated border border-app-border rounded-lg shadow-xl z-50 py-1 overflow-hidden"
                >
                  {/* �ö� / ȡ���ö� */}
                  <button
                    onClick={() => { togglePin(); setShowMobileMenu(false); }}
                    disabled={!!activeNote.isLocked || isTrashed}
                    className="w-full flex items-center gap-2.5 px-3 py-2.5 text-sm text-tx-secondary active:bg-app-hover transition-colors disabled:opacity-40"
                  >
                    <Pin size={15} className={cn(activeNote.isPinned ? "text-accent-primary fill-accent-primary" : "text-tx-tertiary")} />
                    <span>{activeNote.isPinned ? t('editor.unpinTooltip') : t('editor.pinTooltip')}</span>
                  </button>
                  <div className="h-px bg-app-border mx-2 my-0.5" />
                  {/* �ƶ��ʼǱ� */}
                  <button
                    onClick={() => setShowMobileMoveMenu(!showMobileMoveMenu)}
                    disabled={isTrashed}
                    className="w-full flex items-center gap-2.5 px-3 py-2.5 text-sm text-tx-secondary active:bg-app-hover transition-colors disabled:opacity-40"
                  >
                    <FolderInput size={15} className="text-tx-tertiary" />
                    <span className="flex-1 text-left">{t('editor.moveToNotebook')}</span>
                    <ChevronRight size={14} className="text-tx-tertiary" />
                  </button>
                  {/* �ƶ��ʼǱ��Ӳ˵� */}
                  <AnimatePresence>
                    {showMobileMoveMenu && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.15 }}
                        className="overflow-hidden border-t border-b border-app-border bg-app-bg/50"
                      >
                        <div className="max-h-56 overflow-auto py-1 px-1">
                          {notebookTree.map((nb) => (
                            <MoveTreeItem
                              key={nb.id}
                              notebook={nb}
                              depth={0}
                              currentId={activeNote.notebookId}
                              onSelect={(id) => {
                                handleMoveToNotebook(id);
                                setShowMobileMenu(false);
                                setShowMobileMoveMenu(false);
                              }}
                            />
                          ))}
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                  {/* ��� */}
                  <button
                    onClick={() => {
                      setShowMobileOutline(true);
                      setShowMobileMenu(false);
                    }}
                    className="w-full flex items-center gap-2.5 px-3 py-2.5 text-sm text-tx-secondary active:bg-app-hover transition-colors"
                  >
                    <ListTree size={15} className="text-tx-tertiary" />
                    <span>{t('editor.showOutline')}</span>
                  </button>
                  <div className="h-px bg-app-border mx-2 my-0.5" />
                  {/* AI ���ɱ��� */}
                  <button
                    onClick={() => {
                      handleAITitle();
                      setShowMobileMenu(false);
                    }}
                    disabled={aiTitleLoading || !activeNote.contentText || effectiveLocked}
                    className="w-full flex items-center gap-2.5 px-3 py-2.5 text-sm text-tx-secondary active:bg-app-hover transition-colors disabled:opacity-40"
                  >
                    {aiTitleLoading ? <Loader2 size={15} className="animate-spin text-violet-500" /> : <Type size={15} className="text-violet-500" />}
                    <span>{t('editor.aiGenerateTitle')}</span>
                  </button>
                  {/* AI �Ƽ���ǩ */}
                  <button
                    onClick={() => {
                      handleAITags();
                      setShowMobileMenu(false);
                    }}
                    disabled={aiTagsLoading || !activeNote.contentText || effectiveLocked}
                    className="w-full flex items-center gap-2.5 px-3 py-2.5 text-sm text-tx-secondary active:bg-app-hover transition-colors disabled:opacity-40"
                  >
                    {aiTagsLoading ? <Loader2 size={15} className="animate-spin text-violet-500" /> : <TagIcon size={15} className="text-violet-500" />}
                    <span>{t('editor.aiSuggestTags')}</span>
                  </button>
                  {/* AI �ܽ� */}
                  <button
                    onClick={() => {
                      handleAISummary();
                      setShowMobileMenu(false);
                    }}
                    disabled={aiSummaryLoading || !activeNote.contentText || effectiveLocked}
                    className="w-full flex items-center gap-2.5 px-3 py-2.5 text-sm text-tx-secondary active:bg-app-hover transition-colors disabled:opacity-40"
                  >
                    {aiSummaryLoading ? <Loader2 size={15} className="animate-spin text-violet-500" /> : <Sparkles size={15} className="text-violet-500" />}
                    <span>{t('editor.aiSummary')}</span>
                  </button>
                  <div className="h-px bg-app-border mx-2 my-0.5" />
                  {/* ���� */}
                  <button
                    onClick={() => {
                      setShowShareModal(true);
                      setShowMobileMenu(false);
                    }}
                    className="w-full flex items-center gap-2.5 px-3 py-2.5 text-sm text-tx-secondary active:bg-app-hover transition-colors"
                  >
                    <Share2 size={15} className="text-emerald-500" />
                    <span>{t('editor.shareNote')}</span>
                  </button>
                  {/* �汾��ʷ */}
                  <button
                    onClick={() => {
                      setShowVersionHistory(true);
                      setShowMobileMenu(false);
                    }}
                    className="w-full flex items-center gap-2.5 px-3 py-2.5 text-sm text-tx-secondary active:bg-app-hover transition-colors"
                  >
                    <History size={15} className="text-violet-500" />
                    <span>{t('editor.versionHistory')}</span>
                  </button>
                  {/* ���� */}
                  <button
                    onClick={() => {
                      setShowCommentPanel(true);
                      setShowMobileMenu(false);
                    }}
                    className="w-full flex items-center gap-2.5 px-3 py-2.5 text-sm text-tx-secondary active:bg-app-hover transition-colors"
                  >
                    <MessageCircle size={15} className="text-blue-500" />
                    <span>{t('editor.noteComments')}</span>
                  </button>
                  {/* 反向链接 BACKLINKS-02 */}
                  <button
                    onClick={() => {
                      setShowBacklinksPanel(true);
                      setShowMobileMenu(false);
                    }}
                    className="w-full flex items-center gap-2.5 px-3 py-2.5 text-sm text-tx-secondary active:bg-app-hover transition-colors"
                  >
                    <Link2 size={15} className="text-emerald-500" />
                    <span>反向链接</span>
                    {!backlinksLoading && backlinksCount !== null && backlinksCount > 0 && (
                      <span className="ml-auto text-xs text-tx-tertiary">{backlinksCount}</span>
                    )}
                  </button>
                  {/* ����Ŀ¼ */}
                  <button
                    onClick={() => {
                      setShowAttachmentsPanel(true);
                      setShowMobileMenu(false);
                    }}
                    className="w-full flex items-center gap-2.5 px-3 py-2.5 text-sm text-tx-secondary active:bg-app-hover transition-colors"
                  >
                    <Paperclip size={15} className="text-amber-500" />
                    <span>{t('editor.attachments')}</span>
                  </button>
                  {/* HTML Ԥ�� / �༭�л����� HTML Ƭ�αʼ���ʾ����ȫ��¡��֧�ֱ༭�� */}
                  {noteIsHtml && !noteIsFullHtmlDoc && (
                    <>
                      <div className="h-px bg-app-border mx-2 my-0.5" />
                      <button
                        onClick={async () => {
                          setShowMobileMenu(false);
                          await handleToggleHtmlPreviewMode();
                        }}
                        className="w-full flex items-center gap-2.5 px-3 py-2.5 text-sm text-tx-secondary active:bg-app-hover transition-colors"
                      >
                        {htmlPreviewMode ? <Pencil size={15} className="text-amber-500" /> : <Eye size={15} className="text-blue-500" />}
                        <span>{htmlPreviewMode ? t("editor.htmlPreview.switchToEdit") : t("editor.htmlPreview.switchToPreview")}</span>
                      </button>
                    </>
                  )}
                  <div className="h-px bg-app-border mx-2 my-0.5" />
                  {/* NOTE-IMAGE-EXPORT-01: 导出为图片 */}
                  <button
                    onClick={() => { setShowMobileMenu(false); handleExportNoteImage("png"); }}
                    className="w-full flex items-center gap-2.5 px-3 py-2.5 text-sm text-tx-secondary active:bg-app-hover transition-colors"
                  >
                    <Image size={15} className="text-tx-tertiary" />
                    <span>{t("note.exportAsPng")}</span>
                  </button>
                  <button
                    onClick={() => { setShowMobileMenu(false); handleExportNoteImage("jpg"); }}
                    className="w-full flex items-center gap-2.5 px-3 py-2.5 text-sm text-tx-secondary active:bg-app-hover transition-colors"
                  >
                    <Image size={15} className="text-tx-tertiary" />
                    <span>{t("note.exportAsJpg")}</span>
                  </button>
                  <div className="h-px bg-app-border mx-2 my-0.5" />
                  {/* ɾ���ʼ� */}
                  <button
                    onClick={() => {
                      moveToTrash();
                      setShowMobileMenu(false);
                    }}
                    disabled={effectiveLocked}
                    className="w-full flex items-center gap-2.5 px-3 py-2.5 text-sm text-red-500 active:bg-red-50 dark:active:bg-red-900/20 transition-colors disabled:opacity-40"
                  >
                    <Trash2 size={15} />
                    <span>{t('editor.trashTooltip')}</span>
                  </button>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </header>

      {/* Mobile Outline Panel (ȫ������) */}
      <AnimatePresence>
        {showMobileOutline && (
          <motion.div
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: "spring", damping: 25, stiffness: 300 }}
            className="fixed inset-0 z-40 bg-app-surface flex flex-col md:hidden"
            style={{ paddingTop: 'var(--safe-area-top)' }}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-app-border">
              <div className="flex items-center gap-1.5 text-sm font-semibold text-tx-primary">
                <ListTree size={16} className="text-accent-primary" />
                <span>{t('editor.outline')}</span>
              </div>
              <button
                onClick={() => setShowMobileOutline(false)}
                className="p-1.5 rounded-md hover:bg-app-hover text-tx-secondary transition-colors"
              >
                <X size={18} />
              </button>
            </div>
            <ScrollArea className="flex-1">
              <div className="py-2 px-2">
                {headings.length === 0 ? (
                  <div className="px-3 py-12 text-center">
                    <p className="text-sm text-tx-tertiary">{t('editor.noHeadings')}</p>
                    <p className="text-xs text-tx-tertiary mt-1">{t('editor.noHeadingsHint')}</p>
                  </div>
                ) : (
                  headings.map((h) => (
                    <button
                      key={h.id}
                      onClick={() => {
                        scrollToRef.current?.(h.pos);
                        setShowMobileOutline(false);
                      }}
                      className={cn(
                        "w-full text-left px-4 py-2.5 text-sm transition-colors active:bg-app-hover rounded-lg",
                        h.level === 1 && "font-medium text-tx-primary",
                        h.level === 2 && "text-tx-secondary",
                        h.level === 3 && "text-tx-tertiary",
                      )}
                      style={{ paddingLeft: `${(h.level - 1) * 16 + 16}px` }}
                    >
                      <span className={cn(
                        "inline-block w-2 h-2 rounded-full mr-2.5 shrink-0 align-middle",
                        h.level === 1 && "bg-accent-primary",
                        h.level === 2 && "bg-accent-primary/50",
                        h.level === 3 && "bg-tx-tertiary/50",
                      )} />
                      {h.text || t('editor.untitled')}
                    </button>
                  ))
                )}
              </div>
            </ScrollArea>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Desktop Editor Header */}
      <div className="hidden md:flex min-w-0 items-center justify-between gap-3 px-4 py-2 border-b border-app-border bg-app-surface/30 transition-colors">
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          {/* �ʼ��б����۵�ʱ���������ṩ��չ������ť��δ�۵�ʱ���ء�
              ����������м��࣬�����ڡ���˭���б���ס�ˡ������֪��һ�ۿ����� */}
          {state.noteListCollapsed && (
            <button
              type="button"
              onClick={() => actions.toggleNoteListCollapsed()}
              title={t("common.expandList")}
              aria-label={t("common.expandList")}
              className="p-1 rounded-md text-tx-tertiary hover:bg-app-hover hover:text-tx-secondary transition-colors shrink-0"
            >
              <PanelLeft size={15} />
            </button>
          )}
          <div className="relative min-w-0 flex-1">
          <button
            onClick={() => setShowMoveDropdown(!showMoveDropdown)}
            className="flex min-w-0 max-w-full items-center gap-1 overflow-hidden text-xs text-tx-tertiary hover:text-tx-secondary transition-colors rounded-md px-1.5 py-1 hover:bg-app-hover"
            title={t('editor.moveToNotebook')}
          >
            {currentPath.length > 0 ? (
              <span className="flex min-w-0 items-center gap-1 overflow-hidden">
                {currentPath.map((nb, idx) => {
                  const isLast = idx === currentPath.length - 1;
                  // ĩ�������������ضϣ�min-w-0 + ���� shrink-0�����м�α��ֽ��ղ�����
                  // ֮ǰ���жζ��� shrink-0 + truncate������ truncate ʧЧ�������� emoji/��ͷ�Ӿ��ص�
                  return (
                    <React.Fragment key={nb.id}>
                      {idx > 0 && <ChevronRight size={11} className="text-tx-tertiary/60 shrink-0" />}
                      <span
                        className={cn(
                          "flex items-center gap-1",
                          isLast ? "min-w-0 text-tx-secondary font-medium" : "shrink-0"
                        )}
                      >
                        <span className="shrink-0 leading-none">{getNotebookIcon(nb.icon)}</span>
                        <span className={cn("truncate", isLast ? "max-w-[180px]" : "max-w-[120px]")}>
                          {nb.name}
                        </span>
                      </span>
                    </React.Fragment>
                  );
                })}
              </span>
            ) : (
              <span className="shrink-0 leading-none">{getNotebookIcon()}</span>
            )}
            <ChevronDown size={12} className="shrink-0 ml-0.5" />
          </button>
          {showMoveDropdown && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setShowMoveDropdown(false)} />
              <div
                ref={moveDropdownRef}
                        className="absolute top-full left-0 mt-1 w-72 bg-white dark:bg-zinc-950 border border-app-border rounded-lg shadow-xl z-50 py-1 max-h-96 overflow-auto"
                style={{ animation: "contextMenuIn 0.12s ease-out" }}
              >
                {/* ���� P3��AI ������� ����
                    ���ڶ�������λ�ã����������� �� չʾ���� �� ������ƶ���
                    ���鲻����"ȫ���ʼǱ�"��ѡ�б����û����ֶ��߹��档 */}
                <div className="px-2 pt-1 pb-0.5">
                  <button
                    onClick={handleAiClassify}
                    disabled={aiClassifyLoading}
                    className="w-full flex items-center gap-2 px-2 py-1.5 text-xs rounded-md text-violet-600 dark:text-violet-400 hover:bg-violet-50 dark:hover:bg-violet-500/10 disabled:opacity-50 disabled:cursor-wait transition-colors"
                    title={t('editor.aiClassifyTip') || "���ڱʼ������Ƽ�Ŀ��ʼǱ�"}
                  >
                    {aiClassifyLoading ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : (
                      <Sparkles size={12} />
                    )}
                    <span className="flex-1 text-left">
                      {aiClassifyLoading
                        ? (t('editor.aiClassifyLoading') || "AI ���ڷ�����")
                        : (t('editor.aiClassifyAction') || "AI �������")}
                    </span>
                  </button>
                  {aiSuggestions && aiSuggestions.length > 0 && (
                    <div className="mt-1 pl-1 border-l-2 border-violet-200 dark:border-violet-500/30 ml-1.5 flex flex-col gap-0.5">
                      {aiSuggestions.map((s) => (
                        <button
                          key={s.notebookId}
                          onClick={() => handleMoveToNotebook(s.notebookId)}
                          className="group w-full flex items-start gap-2 px-2 py-1.5 text-xs rounded-md hover:bg-violet-50 dark:hover:bg-violet-500/10 transition-colors text-left"
                          title={s.reason || s.path}
                        >
                          <FolderInput size={11} className="mt-0.5 shrink-0 text-violet-500" />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5">
                              <span className="truncate text-tx-primary group-hover:text-violet-600 dark:group-hover:text-violet-400">
                                {s.path}
                              </span>
                              <span className="shrink-0 text-[10px] text-violet-500/80 font-mono">
                                {Math.round(s.confidence * 100)}%
                              </span>
                            </div>
                            {s.reason && (
                              <div className="text-[10px] text-tx-tertiary truncate mt-0.5">
                                {s.reason}
                              </div>
                            )}
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <div className="px-3 py-1.5 mt-1 text-[10px] font-medium text-tx-tertiary border-t border-b border-app-border">
                  {t('editor.moveToLabel')}
                </div>
                <div className="px-1 pb-1 pt-1">
                  {notebookTree.map((nb) => (
                    <MoveTreeItem
                      key={nb.id}
                      notebook={nb}
                      depth={0}
                      currentId={activeNote.notebookId}
                      onSelect={handleMoveToNotebook}
                    />
                  ))}
                </div>
              </div>
            </>
          )}
          </div>
          {collabYDoc && (
            <span
              className="inline-flex shrink-0 items-center gap-1 rounded border border-accent-primary/20 bg-accent-primary/5 px-1.5 py-0.5 text-[10px] font-medium text-accent-primary"
              title="Live 协同编辑"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-accent-primary animate-pulse" />
              Live
            </span>
          )}
          {activeNote.contentFormat === "markdown" ? (
            <span className="inline-flex shrink-0 items-center gap-1 rounded border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-mono font-medium text-emerald-500" title={t('note.format.markdown')}>
              <FileCode size={11} />
              {t('note.format.markdownShort')}
            </span>
          ) : (
            <span className="inline-flex shrink-0 items-center gap-1 rounded border border-app-border bg-app-hover px-1.5 py-0.5 text-[10px] font-mono text-tx-tertiary" title={t('note.format.richText')}>
              <FileText size={11} />
              {t('note.format.richTextShort')}
            </span>
          )}
        </div>

        {/* Sync Indicator + Grouped Actions */}
        <div className="flex shrink-0 items-center gap-1.5">
          {/* ͬ��״̬ */}
          <SyncIndicator
            syncStatus={syncStatus}
            lastSyncedAt={lastSyncedAt}
            onManualSync={handleManualSync}
          />

          <div className="h-4 w-px shrink-0 bg-app-border" />

          {/* �༭������ */}
          <div className="flex shrink-0 items-center gap-0.5 bg-app-hover/50 rounded-lg px-1 py-0.5">
            <Button
              variant="ghost" size="icon" className="h-7 w-7 rounded-md"
              onClick={toggleLock}
              title={effectiveLocked ? t('editor.unlockTooltip') : t('editor.lockTooltip')}
            >
              {effectiveLocked
                ? <Lock size={14} className={activeNote.isLocked ? "text-orange-500" : "text-tx-tertiary"} />
                : <Unlock size={14} />}
            </Button>
            <Button
              variant="ghost" size="icon" className="h-7 w-7 rounded-md"
              onClick={togglePin}
              title={activeNote.isPinned ? t('editor.unpinTooltip') : t('editor.pinTooltip')}
            >
              <Pin size={14} className={cn(activeNote.isPinned && "text-accent-primary fill-accent-primary")} />
            </Button>
            <Button
              variant="ghost" size="icon" className="h-7 w-7 rounded-md"
              onClick={toggleFavorite}
              title={activeNote.isFavorite ? t('editor.unfavoriteTooltip') : t('editor.favoriteTooltip')}
            >
              <Star size={14} className={cn(activeNote.isFavorite && "text-amber-400 fill-amber-400")} />
            </Button>
          </div>

          {/* ���� */}
          <Button
            variant="ghost" size="icon" className="h-7 w-7 shrink-0"
            onClick={() => setShowShareModal(true)}
            title={t('editor.shareNote')}
          >
            <Share2 size={14} className="text-emerald-500" />
          </Button>

          <Button
            variant="ghost" size="icon" className="relative h-7 w-7 shrink-0"
            onClick={() => setShowBacklinksPanel(true)}
            title="反向链接"
          >
            <Link2 size={14} className="text-emerald-500" />
            {!backlinksLoading && backlinksCount !== null && backlinksCount > 0 && (
              <span className="absolute -right-0.5 -top-0.5 flex h-[14px] min-w-[14px] items-center justify-center rounded-full bg-emerald-500 px-0.5 text-[9px] leading-none text-white">
                {backlinksCount > 99 ? "99+" : backlinksCount}
              </span>
            )}
          </Button>

          {noteIsHtml && (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0"
              onClick={handleToggleHtmlPreviewMode}
              title={htmlPreviewMode ? t("editor.htmlPreview.switchToEditTooltip") : t("editor.htmlPreview.switchToPreviewTooltip")}
              aria-label={htmlPreviewMode ? t("editor.htmlPreview.switchToEdit") : t("editor.htmlPreview.switchToPreview")}
            >
              {htmlPreviewMode
                ? <Pencil size={14} className="text-amber-500" />
                : <Eye size={14} className="text-blue-500" />}
            </Button>
          )}

          <div className="flex shrink-0 items-center gap-0.5 rounded-lg bg-violet-500/5 px-1 py-0.5 dark:bg-violet-500/10">
            <Button
              variant="ghost" size="icon" className="h-7 w-7 rounded-md"
              onClick={handleAITitle}
              disabled={aiTitleLoading || !activeNote.contentText || effectiveLocked}
              title={t('editor.aiGenerateTitle')}
            >
              {aiTitleLoading ? <Loader2 size={14} className="animate-spin text-violet-500" /> : <Type size={14} className="text-violet-500" />}
            </Button>
            <Button
              variant="ghost" size="icon" className="h-7 w-7 rounded-md"
              onClick={handleAITags}
              disabled={aiTagsLoading || !activeNote.contentText || effectiveLocked}
              title={t('editor.aiSuggestTags')}
            >
              {aiTagsLoading ? <Loader2 size={14} className="animate-spin text-violet-500" /> : <TagIcon size={14} className="text-violet-500" />}
            </Button>
          </div>

          {/* 全屏 */}
          <Button
            variant="ghost" size="icon" className="h-7 w-7 shrink-0"
            onClick={toggleEditorFullscreen}
            title={state.editorFullscreen ? '退出全屏' : '编辑器全屏'}
            aria-label={state.editorFullscreen ? '退出全屏' : '编辑器全屏'}
          >
            {state.editorFullscreen
              ? <Minimize2 size={14} className="text-accent-primary" />
              : <Maximize2 size={14} />}
          </Button>

          {/* �༭��ģʽ�л���MD / Tiptap�� */}
          {/*
            ����Ѷ���ͨ�û����أ����ļ����� SHOW_EDITOR_MODE_TOGGLE ע�ͣ���
            URL `?md=1|0` ��Ȼ��Ч��toggleEditorMode ����Э�鱣�����·���

            disabled ������
              - �� modeSwitching�������л��У��������롣
            ���� collabSynced��
              ���ڰ汾���� `collabReady && !collabSynced` ʱ���ð�ť + ��ʾ"Эͬ
              ����ͬ����"tooltip����ʵ�ⷢ�ֲ��ֻ����� collabSynced ���ɿ���ͣ����
              false������ realtime δ��ͨ��provider ��̬�������� y:sync ��ʧ����
              ���°�ť���û����޷��л� RTE ���� ���Ǳ�"���ж���"�����ص��������⡣
              �����ı���������� `toggleEditorMode` ��ͷ�����Ϸ� �� ��ڣ���
                if (collabReadyRef.current && !collabSyncedRef.current) {
                  toast.error(...); return;
                }
              ��ť���ֿɵ������ CRDT ��δ sync ֻ�� toast ��ִ���л���sync ��ɺ�
              �ٵ㼴��˳���л�����Զ��������"��ť����"����״̬��
          */}
          {SHOW_EDITOR_MODE_TOGGLE && (
            <button
              onClick={toggleEditorMode}
              disabled={modeSwitching}
              title={
                modeSwitching
                  ? t("editor.modeSwitch.switching")
                  : editorMode === "md"
                  ? t("editor.modeSwitch.toTiptap")
                  : t("editor.modeSwitch.toMd")
              }
              className={cn(
                "flex items-center gap-1 h-7 px-1.5 rounded-md text-[10px] font-mono font-medium transition-colors border",
                editorMode === "md"
                  ? "bg-accent-primary/10 text-accent-primary border-accent-primary/30 hover:bg-accent-primary/15"
                  : "bg-app-hover text-tx-tertiary border-app-border hover:text-tx-secondary hover:bg-app-active",
                modeSwitching && "opacity-50 cursor-not-allowed"
              )}
            >
              <FileCode size={12} />
              <span>{editorMode === "md" ? "MD" : "RTE"}</span>
            </button>
          )}

          <div className="relative shrink-0" ref={desktopMoreMenuRef}>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => setShowDesktopMoreMenu((open) => !open)}
              title={t("tiptap.moreMenu") || "更多"}
              aria-label={t("tiptap.moreMenu") || "更多"}
            >
              <MoreHorizontal size={14} />
            </Button>
            <AnimatePresence>
              {showDesktopMoreMenu && (
                <motion.div
                  initial={{ opacity: 0, scale: 0.96, y: -4 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.96, y: -4 }}
                  transition={{ duration: 0.12 }}
                  className="absolute right-0 top-full z-50 mt-1 w-72 overflow-hidden rounded-lg border border-app-border bg-app-elevated py-1 shadow-xl"
                >
                  <div className="px-3 py-2 border-b border-app-border">
                    <div className="flex items-center justify-between gap-2 text-[11px] text-tx-tertiary">
                      <span>{activeNote.contentFormat === "markdown" ? t('note.format.markdown') : t('note.format.richText')}</span>
                      {noteIsHtml && <span className="rounded bg-blue-500/10 px-1.5 py-0.5 text-blue-500">HTML</span>}
                    </div>
                    <div className="mt-1">
                      <PresenceBar users={presenceUsers} isConnected={isConnected} />
                    </div>
                  </div>

                  <button
                    onClick={() => { setShowMoveDropdown(true); setShowDesktopMoreMenu(false); }}
                    disabled={isTrashed}
                    className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-tx-secondary hover:bg-app-hover transition-colors disabled:opacity-40"
                  >
                    <FolderInput size={15} className="text-tx-tertiary" />
                    <span>{t('editor.moveToNotebook')}</span>
                  </button>
                  <button
                    onClick={() => { setShowOutline(!showOutline); setShowDesktopMoreMenu(false); }}
                    className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-tx-secondary hover:bg-app-hover transition-colors"
                  >
                    <ListTree size={15} className={cn(showDesktopOutline && "text-accent-primary")} />
                    <span>{showDesktopOutline ? t('editor.hideOutline') : t('editor.showOutline')}</span>
                  </button>
                  <button
                    onClick={() => { setShowAttachmentsPanel(true); setShowDesktopMoreMenu(false); }}
                    className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-tx-secondary hover:bg-app-hover transition-colors"
                  >
                    <Paperclip size={15} className="text-amber-500" />
                    <span>{t('editor.attachments')}</span>
                  </button>

                  <div className="h-px bg-app-border mx-2 my-0.5" />
                  <button
                    onClick={() => { setShowVersionHistory(true); setShowDesktopMoreMenu(false); }}
                    className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-tx-secondary hover:bg-app-hover transition-colors"
                  >
                    <History size={15} className="text-violet-500" />
                    <span>{t('editor.versionHistory')}</span>
                  </button>
                  <button
                    onClick={() => { setShowCommentPanel(true); setShowDesktopMoreMenu(false); }}
                    className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-tx-secondary hover:bg-app-hover transition-colors"
                  >
                    <MessageCircle size={15} className="text-blue-500" />
                    <span>{t('editor.noteComments')}</span>
                  </button>

                  <div className="h-px bg-app-border mx-2 my-0.5" />
                  <button
                    onClick={() => { handleExportNoteImage("png"); setShowDesktopMoreMenu(false); }}
                    className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-tx-secondary hover:bg-app-hover transition-colors"
                  >
                    <Image size={15} className="text-tx-tertiary" />
                    <span>{t("note.exportAsPng")}</span>
                  </button>
                  <button
                    onClick={() => { handleExportNoteImage("jpg"); setShowDesktopMoreMenu(false); }}
                    className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-tx-secondary hover:bg-app-hover transition-colors"
                  >
                    <Image size={15} className="text-tx-tertiary" />
                    <span>{t("note.exportAsJpg")}</span>
                  </button>

                  {noteIsHtml && (
                    <>
                      <div className="h-px bg-app-border mx-2 my-0.5" />
                      <button
                        onClick={async () => {
                          setShowDesktopMoreMenu(false);
                          await handleToggleHtmlPreviewMode();
                        }}
                        className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-tx-secondary hover:bg-app-hover transition-colors"
                      >
                        {htmlPreviewMode ? <Pencil size={15} className="text-amber-500" /> : <Eye size={15} className="text-blue-500" />}
                        <span>{htmlPreviewMode ? t("editor.htmlPreview.switchToEdit") : t("editor.htmlPreview.switchToPreview")}</span>
                      </button>
                    </>
                  )}

                  <div className="h-px bg-app-border mx-2 my-0.5" />
                  <button
                    onClick={() => { handleAISummary(); setShowDesktopMoreMenu(false); }}
                    disabled={aiSummaryLoading || !activeNote.contentText || effectiveLocked}
                    className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-tx-secondary hover:bg-app-hover transition-colors disabled:opacity-40"
                  >
                    {aiSummaryLoading ? <Loader2 size={15} className="animate-spin text-violet-500" /> : <Sparkles size={15} className="text-violet-500" />}
                    <span>{t('editor.aiSummary')}</span>
                  </button>
                  <button
                    onClick={() => { handleAIMermaid("mermaid_mindmap"); setShowDesktopMoreMenu(false); }}
                    disabled={aiMermaidLoading || !activeNote.contentText || effectiveLocked}
                    className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-tx-secondary hover:bg-app-hover transition-colors disabled:opacity-40"
                  >
                    {aiMermaidLoading ? <Loader2 size={15} className="animate-spin text-violet-500" /> : <Network size={15} className="text-violet-500" />}
                    <span>{t('editor.aiGenMindMap') || "AI 思维导图"}</span>
                  </button>

                  <div className="h-px bg-app-border mx-2 my-0.5" />
                  <button
                    onClick={() => { moveToTrash(); setShowDesktopMoreMenu(false); }}
                    disabled={effectiveLocked}
                    className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors disabled:opacity-40"
                  >
                    <Trash2 size={15} />
                    <span>{t('editor.trashTooltip')}</span>
                  </button>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

        </div>
      </div>

      {userPrefs.enableNoteTabs && !state.editorSplit && <NoteTabsBar />}

      {/* Editor (HTML Ԥ�� / MD / Tiptap ��ģʽ����) + Outline */}
      <div className="flex-1 flex overflow-hidden">
        <div className="flex-1 overflow-hidden relative">
          {/* Phase 2: ʵʱЭ����������� / Զ�̸��� / Զ��ɾ�������� absolute ���㣬��ռ�ĵ���������ҳ�涶�� */}
          {false && pendingDraft ? (
            <div
              className="absolute top-2 left-2 right-2 z-30 px-3 py-2 rounded-md bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 text-amber-900 dark:text-amber-100 shadow-sm flex items-center justify-between gap-2"
              role="alert"
            >
              <div className="text-sm leading-snug">
{t("editor.draftFound") || "检测到未保存的修改"}
                <span className="ml-2 opacity-70">
                  ({new Date(pendingDraft?.savedAt ?? Date.now()).toLocaleString()})
                </span>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Button
                  size="sm"
                  variant="default"
                  className="h-7 px-2 text-xs"
                  onClick={handleRestoreDraft}
                >
{t("editor.draftRestore") || "恢复"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs"
                  onClick={handleDiscardDraft}
                >
{t("editor.draftDiscard") || "丢弃"}
                </Button>
              </div>
            </div>
          ) : null}
          {/* ErrorBoundary �������ֱ༭�����бʼ�Ϊ key���������Զ����ã�
              �ײ㻹�ܴ� console �� [EditorErrorBoundary] ��־�� window.__lastDirtyDoc */}
          <EditorErrorBoundary resetKey={activeNote.id}>
          {/* 原生 Markdown 笔记：contentFormat === "markdown" 时始终用 MarkdownEditor */}
          {activeNote.contentFormat === "markdown" ? (
            <MarkdownEditor
              key={`md-native-${activeNote.id}`}
              ref={editorHandleRef}
              note={activeNote}
              onUpdate={handleUpdate}
              onTagsChange={handleTagsChange}
              onHeadingsChange={setHeadings}
              onEditorReady={(fn) => { scrollToRef.current = fn; }}
              editable={!effectiveLocked && !modeSwitching}
              yDoc={collabYDoc}
              awareness={collabProvider?.awareness ?? null}
            />
          ) : htmlPreviewMode ? (
            <HtmlPreviewPane
              key={`html-${activeNote.id}`}
              ref={editorHandleRef}
              note={activeNote}
              onUpdate={handleUpdate}
              onTagsChange={handleTagsChange}
              onHeadingsChange={setHeadings}
              editable={false}
            />
          ) : editorMode === "md" ? (
            <MarkdownEditor
              // Phase 3: key �� CRDT ����̬���л� provider ʱǿ���ؽ��༭����
              // ���� yCollab ��չ������ʱ���� yText ������״̬����
              key={collabYDoc ? `md-y-${activeNote.id}` : `md-${activeNote.id}`}
              ref={editorHandleRef}
              note={activeNote}
              onUpdate={handleUpdate}
              onTagsChange={handleTagsChange}
              onHeadingsChange={setHeadings}
              onEditorReady={(fn) => { scrollToRef.current = fn; }}
              // UX3��ģʽ�л��ڼ䶳��༭�������û��� mount��unmount ��������֣�
              // ��������������һ�༭����������������"�ڶ�����"����
              editable={!effectiveLocked && !modeSwitching}
              yDoc={collabYDoc}
              awareness={collabProvider?.awareness ?? null}
            />
          ) : (
            <TiptapEditor
              ref={editorHandleRef}
              note={activeNote}
              onUpdate={handleUpdate}
              onTagsChange={handleTagsChange}
              onHeadingsChange={setHeadings}
              onEditorReady={(fn) => { scrollToRef.current = fn; }}
              onOpenNote={handleOpenNote}
              editable={!effectiveLocked && !modeSwitching}
              searchQuery={state.searchQuery}
            />
          )}
          </EditorErrorBoundary>
          {/*
            UX1/UX2���༭���л��� overlay��
            - ���ڵ�ǰ�༭���Ϸ����赲���� / �Ӿ���ʾ"�л���"��
            - AnimatePresence �ý�������ƽ��������"��"һ�£�
            - pointer-events-auto �����ص��Ҳ��ֹ Tiptap/CM6 ��ѡ�����ƻ���
          */}
          <AnimatePresence>
            {modeSwitching && (
              <motion.div
                key="editor-mode-switching-overlay"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15 }}
                className="absolute inset-0 z-20 flex items-center justify-center bg-app-bg/60 backdrop-blur-sm pointer-events-auto"
              >
                <div className="flex items-center gap-2 px-4 py-2 rounded-lg bg-app-elevated border border-app-border shadow-sm text-sm text-tx-secondary">
                  <Loader2 size={14} className="animate-spin text-accent-primary" />
                  <span>{t("editor.modeSwitch.switchingLabel")}</span>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      {/* �������� */}
      {showShareModal && (
        <ShareModal
          noteId={activeNote.id}
          noteTitle={activeNote.title}
          onClose={() => setShowShareModal(false)}
        />
      )}

      {/* �汾��ʷ */}
      {showVersionHistory && (
        <VersionHistoryPanel
          noteId={activeNote.id}
          noteTitle={activeNote.title}
          onRestore={(updated) => {
            try { editorHandleRef.current?.discardPending?.(); } catch { /* ignore */ }
            try { clearDraft(updated.id); } catch { /* ignore */ }
            skipNextSwitchFlushForNoteIdRef.current = updated.id;
            actions.setActiveNote(updated);
            actions.updateNoteInList({
              id: updated.id,
              title: updated.title,
              contentText: updated.contentText,
              updatedAt: updated.updatedAt,
              version: updated.version,
              isPinned: updated.isPinned,
              isTrashed: updated.isTrashed,
              notebookId: updated.notebookId,
              workspaceId: updated.workspaceId,
            });
            actions.updateNoteTab({
              id: updated.id,
              title: updated.title,
              notebookId: updated.notebookId,
              workspaceId: updated.workspaceId,
              contentFormat: updated.contentFormat,
              isLocked: updated.isLocked,
              isTrashed: updated.isTrashed,
              updatedAt: updated.updatedAt,
            });
            actions.setSyncStatus("saved");
            actions.setLastSynced(new Date().toISOString());
          }}
          onClose={() => setShowVersionHistory(false)}
        />
      )}

      {/* ������� */}
      {showCommentPanel && (
        <CommentPanel
          noteId={activeNote.id}
          noteTitle={activeNote.title}
          onClose={() => setShowCommentPanel(false)}
        />
      )}

      {/* 反向链接 BACKLINKS-02 */}
      {showBacklinksPanel && (
        <BacklinksPanel
          noteId={activeNote.id}
          noteTitle={activeNote.title}
          onClose={() => setShowBacklinksPanel(false)}
        />
      )}

      {/* ����Ŀ¼��� */}
      {showAttachmentsPanel && (
        <NoteAttachmentsPanel
          noteId={activeNote.id}
          noteTitle={activeNote.title}
          onClose={() => setShowAttachmentsPanel(false)}
        />
      )}

      {/* Delete ��ɾ��ȷ�ϵ��� */}
      <AnimatePresence>
        {showDeleteConfirm && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
            onClick={() => setShowDeleteConfirm(false)}
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="bg-app-surface border border-app-border rounded-xl shadow-2xl p-6 max-w-sm mx-4"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center gap-3 mb-3">
                <div className="w-10 h-10 rounded-full bg-red-500/10 flex items-center justify-center">
                  <Trash2 size={18} className="text-red-500" />
                </div>
                <h3 className="text-base font-semibold text-tx-primary">{t('sidebar.deleteNoteTitle')}</h3>
              </div>
              <p className="text-sm text-tx-secondary mb-5">{t('sidebar.deleteNoteConfirm')}</p>
              <div className="flex justify-end gap-2">
                <button
                  onClick={() => setShowDeleteConfirm(false)}
                  className="px-4 py-2 text-sm rounded-lg bg-app-hover text-tx-secondary hover:bg-app-active transition-colors"
                >
                  {t('common.cancel')}
                </button>
                <button
                  onClick={() => {
                    setShowDeleteConfirm(false);
                    moveToTrash();
                  }}
                  className="px-4 py-2 text-sm rounded-lg bg-red-500 text-white hover:bg-red-600 transition-colors"
                >
                  {t('sidebar.confirmDeleteNote')}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>


      {/* AI �ܽᵯ�� */}
      <AnimatePresence>
        {showSummaryDialog && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
            onClick={() => { if (!aiSummaryLoading) setShowSummaryDialog(false); }}
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              onClick={(e) => e.stopPropagation()}
              className="bg-app-surface border border-app-border rounded-xl shadow-2xl w-full max-w-lg max-h-[80vh] flex flex-col"
            >
              {/* ������ */}
              <div className="flex items-center justify-between px-5 py-3.5 border-b border-app-border">
                <div className="flex items-center gap-2">
                  <Sparkles size={16} className="text-violet-500" />
<h3 className="text-sm font-semibold text-tx-primary">{t("editor.aiSummaryTitle") || "单篇笔记总结"}</h3>
                </div>
                <button
                  onClick={() => { if (!aiSummaryLoading) setShowSummaryDialog(false); }}
                  className="p-1 rounded hover:bg-app-hover text-tx-secondary transition-colors"
                >
                  <X size={16} />
                </button>
              </div>
              {/* ������ */}
              <div className="flex-1 overflow-y-auto px-5 py-4">
                {aiSummaryLoading ? (
                  <div className="flex flex-col items-center justify-center py-10 gap-3">
                    <Loader2 size={24} className="animate-spin text-violet-500" />
                    <span className="text-sm text-tx-secondary">{t("editor.aiSummaryGenerating") || "正在生成总结..."}</span>
                  </div>
                ) : (
                  <div className="text-sm text-tx-primary whitespace-pre-wrap leading-relaxed">
                    {aiSummaryResult}
                  </div>
                )}
              </div>
              {/* ������ */}
              {!aiSummaryLoading && aiSummaryResult && (
                <div className="flex items-center justify-between gap-2 px-5 py-3 border-t border-app-border">
                  <div className="flex items-center gap-2">
                    <Button variant="outline" size="sm" onClick={handleSummaryCopy}>
                      {t("editor.aiSummaryCopy") || "复制"}
                    </Button>
                    <Button variant="outline" size="sm" onClick={handleSummaryAppend}>
                      {t("editor.aiSummaryAppend") || "追加到文末"}
                    </Button>
                    <Button variant="outline" size="sm" onClick={handleAISummary}>
                      {t("editor.aiSummaryRegenerate") || "重新生成"}
                    </Button>
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => setShowSummaryDialog(false)}>
                    {t("editor.aiSummaryClose") || "关闭"}
                  </Button>
                </div>
              )}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* AI Mermaid Ԥ������ */}
      <AnimatePresence>
        {showMermaidDialog && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
            onClick={() => { if (!aiMermaidLoading) setShowMermaidDialog(false); }}
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              onClick={(e) => e.stopPropagation()}
              className="bg-app-surface border border-app-border rounded-xl shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col"
            >
              <div className="flex items-center justify-between px-5 py-3.5 border-b border-app-border">
                <div className="flex items-center gap-2">
                  <Network size={16} className="text-violet-500" />
                  <h3 className="text-sm font-semibold text-tx-primary">{aiMermaidType === "mermaid_mindmap" ? "AI 思维导图" : "AI 流程图"}</h3>
                </div>
                <button onClick={() => { if (!aiMermaidLoading) setShowMermaidDialog(false); }} className="p-1 rounded hover:bg-app-hover text-tx-secondary transition-colors">
                  <X size={16} />
                </button>
              </div>
              <div className="flex-1 overflow-y-auto px-5 py-4">
                {aiMermaidLoading ? (
                  <div className="flex flex-col items-center justify-center py-10 gap-3">
                    <Loader2 size={24} className="animate-spin text-violet-500" />
                    <span className="text-sm text-tx-secondary">正在生成...</span>
                  </div>
                ) : aiMermaidResult ? (
                  <div className="rounded-lg border border-app-border overflow-hidden">
                    <MermaidView source={aiMermaidResult} debounceMs={0} />
                  </div>
                ) : null}
              </div>
              {!aiMermaidLoading && aiMermaidResult && (
                <div className="flex items-center justify-between gap-2 px-5 py-3 border-t border-app-border">
                  <div className="flex items-center gap-2">
                    <Button variant="outline" size="sm" onClick={() => { navigator.clipboard.writeText(aiMermaidResult); toast.success("已复制"); }}>
                      复制源码
                    </Button>
                    <Button variant="outline" size="sm" onClick={handleMermaidInsert}>
                      插入笔记
                    </Button>
                    {aiMermaidType === "mermaid_mindmap" && (
                      <Button variant="outline" size="sm" onClick={handleMermaidSaveAsMindMap} disabled={mermaidSavingMindMap}>
                        {mermaidSavingMindMap ? "保存中..." : "保存为思维导图"}
                      </Button>
                    )}
                    <Button variant="outline" size="sm" onClick={() => handleAIMermaid(aiMermaidType)}>
                      重新生成
                    </Button>
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => setShowMermaidDialog(false)}>关闭</Button>
                </div>
              )}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
      {/* HTML Ԥ�� �� �༭ģʽ�л�ȷ�ϵ��� */}
      <AnimatePresence>
        {showHtmlEditWarning && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
            onClick={() => setShowHtmlEditWarning(false)}
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="bg-app-surface border border-app-border rounded-xl shadow-2xl p-6 max-w-sm mx-4"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center gap-3 mb-3">
                <div className="w-10 h-10 rounded-full bg-amber-500/10 flex items-center justify-center">
                  <Pencil size={18} className="text-amber-500" />
                </div>
                <h3 className="text-base font-semibold text-tx-primary">
                  {t("editor.htmlPreview.editWarningTitle")}
                </h3>
              </div>
              <p className="text-sm text-tx-secondary mb-5">
                {t("editor.htmlPreview.editWarningMessage")}
              </p>
              <div className="flex justify-end gap-2">
                <button
                  onClick={() => setShowHtmlEditWarning(false)}
                  className="px-4 py-2 text-sm rounded-lg bg-app-hover text-tx-secondary hover:bg-app-active transition-colors"
                >
                  {t("editor.htmlPreview.editWarningCancel")}
                </button>
                <button
                  onClick={() => {
                    setShowHtmlEditWarning(false);
                    setHtmlPreviewMode(false);
                  }}
                  className="px-4 py-2 text-sm rounded-lg bg-amber-500 text-white hover:bg-amber-600 transition-colors"
                >
                  {t("editor.htmlPreview.editWarningConfirm")}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {showDesktopOutline && (
          <OutlinePanel
            headings={headings}
            onSelect={(pos) => scrollToRef.current?.(pos)}
            onClose={() => setShowOutline(false)}
          />
        )}
      </div>
    </motion.div>
  );
}

/* ===== ������ ===== */
function OutlinePanel({
  headings,
  onSelect,
  onClose,
}: {
  headings: NoteEditorHeading[];
  onSelect: (pos: number) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="hidden md:flex flex-col w-56 min-w-[200px] border-l border-app-border bg-app-surface/50 transition-colors">
      <div className="flex items-center justify-between px-3 py-2 border-b border-app-border">
        <div className="flex items-center gap-1.5 text-xs font-medium text-tx-secondary">
          <ListTree size={13} className="text-accent-primary" />
          <span>{t('editor.outline')}</span>
        </div>
        <button
          onClick={onClose}
          className="p-0.5 rounded hover:bg-app-hover text-tx-tertiary hover:text-tx-secondary transition-colors"
        >
          <X size={13} />
        </button>
      </div>
      <ScrollArea className="flex-1">
        <div className="py-1">
          {headings.length === 0 ? (
            <div className="px-3 py-6 text-center">
              <p className="text-[11px] text-tx-tertiary">{t('editor.noHeadings')}</p>
              <p className="text-[10px] text-tx-tertiary mt-1">{t('editor.noHeadingsHint')}</p>
            </div>
          ) : (
            headings.map((h) => (
              <button
                key={h.id}
                onClick={() => onSelect(h.pos)}
                className={cn(
                  "w-full text-left px-3 py-1.5 text-xs transition-colors hover:bg-app-hover truncate",
                  h.level === 1 && "font-medium text-tx-primary",
                  h.level === 2 && "text-tx-secondary",
                  h.level === 3 && "text-tx-tertiary",
                )}
                style={{ paddingLeft: `${(h.level - 1) * 12 + 12}px` }}
                title={h.text}
              >
                <span className={cn(
                  "inline-block w-1.5 h-1.5 rounded-full mr-2 shrink-0 align-middle",
                  h.level === 1 && "bg-accent-primary",
                  h.level === 2 && "bg-accent-primary/50",
                  h.level === 3 && "bg-tx-tertiary/50",
                )} />
                {h.text || t('editor.untitled')}
              </button>
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

/* ===== �ʼǱ����������� Sidebar.tsx �� buildTree ��ȫһ�£� ===== */
function buildTree(notebooks: Notebook[]): Notebook[] {
  const map = new Map<string, Notebook>();
  const roots: Notebook[] = [];
  notebooks.forEach((nb) => map.set(nb.id, { ...nb, children: [] }));
  notebooks.forEach((nb) => {
    const node = map.get(nb.id)!;
    if (nb.parentId && map.has(nb.parentId)) {
      map.get(nb.parentId)!.children!.push(node);
    } else {
      roots.push(node);
    }
  });
  // �� sortOrder �ȶ�����ȷ����ק�����˳��������ӳ�� UI
  const byOrder = (a: Notebook, b: Notebook) =>
    (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
  const sortRecursive = (list: Notebook[]) => {
    list.sort(byOrder);
    list.forEach((n) => {
      if (n.children && n.children.length > 0) sortRecursive(n.children);
    });
  };
  sortRecursive(roots);
  return roots;
}

/* �Ӹ���ָ�� id ������·���������������������мչʾ */
function findPathById(notebooks: Notebook[], id: string | null | undefined): Notebook[] {
  if (!id) return [];
  const byId = new Map(notebooks.map((n) => [n.id, n]));
  const path: Notebook[] = [];
  let cursor: string | null | undefined = id;
  const visited = new Set<string>();
  while (cursor) {
    if (visited.has(cursor)) break;
    visited.add(cursor);
    const nb = byId.get(cursor);
    if (!nb) break;
    path.unshift(nb);
    cursor = nb.parentId ?? null;
  }
  return path;
}

function getNotebookIcon(icon?: string | null): string {
  const value = (icon ?? "").trim();
  if (!value || value === "??" || value.includes("\uFFFD")) return "📒";
  return value;
}

/* ===== �༭������"�ƶ��ʼǱ�"������Ŀ��������Ŀ¼�ṹ����һ�£� ===== */
function MoveTreeItem({
  notebook, depth, currentId, onSelect,
}: {
  notebook: Notebook;
  depth: number;
  currentId: string;
  onSelect: (id: string) => void;
}) {
  const hasChildren = !!notebook.children && notebook.children.length > 0;
  // Ĭ��չ�����������������а�����ǰ�ʼǣ���չ���������۵�
  const containsCurrent = useMemo(() => {
    const stack: Notebook[] = [notebook];
    while (stack.length) {
      const n = stack.pop()!;
      if (n.id === currentId) return true;
      if (n.children) stack.push(...n.children);
    }
    return false;
  }, [notebook, currentId]);
  const [expanded, setExpanded] = useState(containsCurrent || depth === 0);
  const isCurrent = notebook.id === currentId;
  const { t } = useTranslation();

  return (
    <div>
      <button
        disabled={isCurrent}
        onClick={() => !isCurrent && onSelect(notebook.id)}
        className={cn(
          "w-full flex items-center gap-1.5 px-2 py-1.5 rounded-md text-sm transition-colors",
          isCurrent
            ? "opacity-40 cursor-not-allowed text-tx-tertiary"
            : "text-tx-secondary hover:bg-app-hover hover:text-tx-primary"
        )}
        style={{ paddingLeft: `${depth * 14 + 8}px` }}
      >
        {hasChildren ? (
          <span
            onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
            className="w-4 h-4 flex items-center justify-center shrink-0 cursor-pointer hover:text-tx-primary"
          >
            {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </span>
        ) : (
          <span className="w-4 h-4 shrink-0" />
        )}
        <span className="text-base shrink-0">{getNotebookIcon(notebook.icon)}</span>
        <span className="truncate flex-1 text-left">{notebook.name}</span>
        {isCurrent && (
          <span className="ml-auto text-[10px] text-tx-tertiary shrink-0">{t('common.current')}</span>
        )}
      </button>
      {hasChildren && expanded && notebook.children!.map((child) => (
        <MoveTreeItem
          key={child.id}
          notebook={child}
          depth={depth + 1}
          currentId={currentId}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

/* ===== ͬ��״ָ̬ʾ�� ===== */
function SyncIndicator({
  syncStatus,
  lastSyncedAt,
  onManualSync,
}: {
  syncStatus: SyncStatus;
  lastSyncedAt: string | null;
  onManualSync: () => void;
}) {
  const { t } = useTranslation();
  const formatFullTime = (ts: string) => {
    try { return new Date(ts).toLocaleString(); } catch { return ts; }
  };

  const getTooltip = () => {
    switch (syncStatus) {
      case "saving": return t('editor.saving');
      case "saved":
        return lastSyncedAt
          ? `${t('editor.allSaved')}：${formatFullTime(lastSyncedAt)}`
          : t('editor.allSaved');
      case "error":
        return lastSyncedAt
          ? `${t('editor.saveFailed')}，${t('editor.lastSaved')}：${formatFullTime(lastSyncedAt)}`
          : t('editor.saveFailed');
      case "queued": return t("editor.queued", { defaultValue: "草稿存储，等待网络恢复后自动同步" });
      case "offline": return t("editor.offline", { defaultValue: "当前离线" });
      default:
        if (lastSyncedAt) {
          const diff = Date.now() - new Date(lastSyncedAt).getTime();
          if (diff < 10_000) return t('editor.justSaved');
          if (diff < 60_000) return t('editor.savedSecondsAgo', { count: Math.floor(diff / 1000) });
          if (diff < 3600_000) return t('editor.savedMinutesAgo', { count: Math.floor(diff / 60_000) });
          return t('editor.savedHoursAgo', { count: Math.floor(diff / 3600_000) });
        }
        return t('editor.clickToSync');
    }
  };

  return (
    <button
      onClick={onManualSync}
      disabled={syncStatus === "saving" || syncStatus === "offline"}
      title={getTooltip()}
      className="flex shrink-0 items-center gap-1.5 whitespace-nowrap px-2 py-1 rounded-md text-[11px] transition-colors hover:bg-app-hover group"
    >
      <AnimatePresence mode="wait">
        {syncStatus === "saving" && (
          <motion.div
            key="saving"
            initial={{ opacity: 0, scale: 0.5 }}
            animate={{ opacity: 1, scale: 1, rotate: 360 }}
            exit={{ opacity: 0, scale: 0.5 }}
            transition={{ rotate: { repeat: Infinity, duration: 1, ease: "linear" }, opacity: { duration: 0.15 } }}
          >
            <RefreshCw size={13} className="text-accent-primary" />
          </motion.div>
        )}
        {syncStatus === "saved" && (
          <motion.div
            key="saved"
            initial={{ opacity: 0, scale: 0.5 }}
            animate={{ opacity: 1, scale: [1.3, 1] }}
            exit={{ opacity: 0, scale: 0.5 }}
            transition={{ duration: 0.25 }}
          >
            <Check size={13} className="text-green-500" />
          </motion.div>
        )}
        {syncStatus === "error" && (
          <motion.div
            key="error"
            initial={{ opacity: 0, scale: 0.5 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.5 }}
            transition={{ duration: 0.15 }}
          >
            <CloudOff size={13} className="text-red-500" />
          </motion.div>
        )}
        {(syncStatus === "queued" || syncStatus === "offline") && (
          <motion.div
            key="queued"
            initial={{ opacity: 0, scale: 0.5 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.5 }}
            transition={{ duration: 0.15 }}
          >
            <CloudUpload size={13} className="text-amber-500" />
          </motion.div>
        )}
        {syncStatus === "idle" && (
          <motion.div
            key="idle"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
          >
            <Cloud size={13} className="text-tx-tertiary group-hover:text-tx-secondary transition-colors" />
          </motion.div>
        )}
      </AnimatePresence>

      <span className={cn(
        "hidden whitespace-nowrap sm:inline transition-colors",
        syncStatus === "saving" && "text-accent-primary",
        syncStatus === "saved" && "text-green-500",
        syncStatus === "error" && "text-red-500",
        (syncStatus === "queued" || syncStatus === "offline") && "text-amber-500",
        syncStatus === "idle" && "text-tx-tertiary group-hover:text-tx-secondary",
      )}>
        {syncStatus === "saving" && t('editor.savingStatus')}
        {syncStatus === "saved" && (
          <>
            {t('editor.savedStatus')}
            {lastSyncedAt && (
              <span className="ml-1 opacity-70">
                · {new Date(lastSyncedAt).toLocaleTimeString()}
              </span>
            )}
          </>
        )}
        {syncStatus === "error" && t('editor.saveFailedStatus')}
        {syncStatus === "queued" && t("editor.queuedStatus", { defaultValue: "草稿存储" })}
        {syncStatus === "offline" && t("editor.offlineStatus", { defaultValue: "离线" })}
        {syncStatus === "idle" && (
          lastSyncedAt
            ? <>{t('editor.synced')}<span className="ml-1 opacity-70">· {new Date(lastSyncedAt).toLocaleTimeString()}</span></>
            : t('editor.sync')
        )}
      </span>
    </button>
  );
}

