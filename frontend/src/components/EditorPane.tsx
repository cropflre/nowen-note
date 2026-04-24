import React, { useCallback, useRef, useState, useEffect, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Star, Pin, Trash2, Cloud, CloudOff, RefreshCw, Check, Loader2, ChevronLeft, FolderInput, ChevronRight, ChevronDown, X, ListTree, Lock, Unlock, Tag as TagIcon, Type, MoreHorizontal, Share2, History, MessageCircle, FileCode, Eye, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import TiptapEditor, { HeadingItem } from "@/components/TiptapEditor";
import MarkdownEditor from "@/components/MarkdownEditor";
import HtmlPreviewPane, { isFullHtmlDocument } from "@/components/HtmlPreviewPane";
import type { NoteEditorHandle } from "@/components/editors/types";
import { useApp, useAppActions, SyncStatus } from "@/store/AppContext";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Tag, Notebook } from "@/types";
import { useTranslation } from "react-i18next";
import { haptic } from "@/hooks/useCapacitor";
import { toast } from "@/lib/toast";
import ShareModal from "@/components/ShareModal";
import VersionHistoryPanel from "@/components/VersionHistoryPanel";
import CommentPanel from "@/components/CommentPanel";
import {
  PresenceBar,
  EditingLockBanner,
  RemoteUpdateBanner,
  RemoteDeleteBanner,
} from "@/components/PresenceBar";
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
  isAborted,
} from "@/lib/optimisticLockApi";

// ---------------------------------------------------------------------------
// 编辑器模式切换（MD vs Tiptap）
// ---------------------------------------------------------------------------
// URL `?md=1|0` 强制；否则读 localStorage["nowen.editor_mode"]。
// 读写协议与工具：frontend/src/lib/editorMode.ts
// 切换完整流程：docs/editor-mode-switch.md
//
// UI 入口策略（2026-04 起）：
//   顶栏的 `MD / RTE` 徽标按钮对普通用户隐藏 —— 绝大多数人用不到双引擎，
//   按钮占位 + tooltip 反而造成困惑。双引擎**本身并没有删除**：
//     - `?md=1` / `?md=0` URL 参数仍然生效（给高级用户和自动化测试留口子）
//     - `localStorage["nowen.editor_mode"]` 仍然被读取
//     - toggleEditorMode 完整切换协议保留，未来若把入口迁到设置页，一行开关即可恢复
//   如要在开发期临时显示按钮，把下方常量改为 true；正式发布请保持 false。
const SHOW_EDITOR_MODE_TOGGLE = false;

export default function EditorPane() {
  const { state } = useApp();
  const actions = useAppActions();
  const { activeNote, syncStatus, lastSyncedAt } = state;
  const savedTimerRef = useRef<NodeJS.Timeout | null>(null);
  const [showMoveDropdown, setShowMoveDropdown] = useState(false);
  const moveDropdownRef = useRef<HTMLDivElement | null>(null);
  const [showOutline, setShowOutline] = useState(false);
  const [headings, setHeadings] = useState<HeadingItem[]>([]);
  const scrollToRef = useRef<((pos: number) => void) | null>(null);
  const { t } = useTranslation();
  const [showMobileMenu, setShowMobileMenu] = useState(false);
  const [showMobileMoveMenu, setShowMobileMoveMenu] = useState(false);
  const [showMobileOutline, setShowMobileOutline] = useState(false);
  const [showShareModal, setShowShareModal] = useState(false);
  const [showVersionHistory, setShowVersionHistory] = useState(false);
  const [showCommentPanel, setShowCommentPanel] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const mobileMenuRef = useRef<HTMLDivElement | null>(null);

  // ── HTML 预览模式 ──
  // 当笔记内容被检测为 HTML 格式（如 clipper 剪藏）时自动启用只读预览，
  // 用户可手动切换到 Tiptap 编辑（会有格式丢失警告）。
  const [htmlPreviewMode, setHtmlPreviewMode] = useState(false);
  const [showHtmlEditWarning, setShowHtmlEditWarning] = useState(false);
  // 记住当前笔记的原始格式是否为 HTML。
  // 切换到编辑模式后编辑器会把内容 normalize 成 Markdown，导致 detectFormat 返回 "md"，
  // 如果单靠 detectFormat 判断，切换按钮会消失，用户就无法切回预览模式。
  // 用这个标记来保持按钮始终可见。
  const [noteIsHtml, setNoteIsHtml] = useState(false);
  // 完全克隆模式（完整 HTML 文档，如 <!DOCTYPE ...>）不支持编辑，不显示切换按钮。
  const [noteIsFullHtmlDoc, setNoteIsFullHtmlDoc] = useState(false);

  // 编辑器模式（MD / Tiptap）——初值来自 URL / localStorage，运行时可切换
  const [editorMode, setEditorMode] = useState<EditorMode>(() => resolveEditorMode());
  /**
   * 当前编辑器（Tiptap 或 Markdown）暴露的命令式句柄。
   * EditorPane 只在需要"立即 flush"的临界点使用（切换编辑器、切换笔记、卸载前），
   * 日常数据流依然靠 onUpdate 回调。
   */
  const editorHandleRef = useRef<NoteEditorHandle | null>(null);

  /** 正在进行编辑器模式切换（防止用户连点导致并发 PUT/mount 竞态） */
  const modeSwitchInflightRef = useRef<boolean>(false);
  const [modeSwitching, setModeSwitching] = useState(false);

  /**
   * 最近一次 handleUpdate 触发的 PUT Promise。
   *
   * 用途：编辑器模式切换时若 RTE 的 debounce 刚好在 500ms 前 fire 了且 PUT 还在途中，
   * 即使切换时 `discardPending()` 清了本地 timer 也无法阻止这个正在飞的请求。
   * 而我们接下来要发一次带同 version 的"规范化 PUT"，二者并发会造成：
   *   - 先到者 bump version=N+1；后到者带旧 version=N → 409
   *   - 409 reconcile 会用最新 version 重放"后到者"，可能把 notes.content 写回
   *     旧 Tiptap JSON（取决于到达次序），导致切换成果被覆盖
   *
   * 解决：toggleEditorMode 进入时 await 该 promise，让 in-flight 的 handleUpdate
   * 跑完（handleUpdate 里已经处理 409/回填 version），之后我们的规范化 PUT 拿到
   * 就是"最新且没有 in-flight"的版本号，可以安全并发。
   */
  const saveInflightRef = useRef<Promise<void> | null>(null);

  /**
   * 切换 MD ↔ Tiptap。
   *
   * 完整协议见 `docs/editor-mode-switch.md`。主干步骤：
   *   1) 入口守卫：去重 / 协同未 sync 时拒绝
   *   2) 记录 preSwitchNote 快照（失败回滚用）
   *   3) await saveInflightRef（防止与 handleUpdate 并发 PUT）
   *   4) 取当前编辑器 snapshot
   *   5) flush / discardPending（按方向）
   *   6) MD→RTE：从 yDoc 回填 activeNote
   *   7) RTE→MD：normalizeToMarkdown + 规范化 PUT（带乐观锁 / syncToYjs）
   *   8) 失败回滚 preSwitchNote，成功则提交副作用（persistEditorMode / clearForcedModeFromUrl / setEditorMode）
   *   9) MD→RTE：releaseYjsRoom
   */
  const toggleEditorMode = useCallback(async () => {
    if (modeSwitchInflightRef.current) return;

    // ① 入口：CRDT 未 sync 时的保护 + 救命出口（D4/UX6+UX7）
    // ------------------------------------------------------------------
    // collabReady=true 表示已发起 y:join 但 synced=false 代表服务端还没把完整
    // state 广播回来，此时 yDoc.getText("content") 可能是空串或 IDB 陈旧缓存。
    // MD→RTE 会据此回填 activeNote → 用户最近输入被覆盖为空。
    //
    // 但若 collabSynced 因 provider/WS 异常永远卡在 false，禁止切换会把用户
    // 堵死在 MD 模式（曾有用户反馈等了 10+ 分钟）。因此改为"二次点击强制切换"：
    //   1st click：toast 警告 + 记录时间戳，阻止切换
    //   3s 内 2nd click：视为用户坚持切换，放行（用户承担可能丢字的风险）
    //   > 3s：时间戳过期，重新走一次警告流程
    // i18n 文案保持不变，仅在警告文案里追加"再次点击可强制切换"。
    if (collabReadyRef.current && !collabSyncedRef.current) {
      const now = Date.now();
      const last = lastUnsyncedClickAtRef.current;
      if (last && now - last < 3000) {
        // 2nd click in window → 放行，同时清掉时间戳避免误复用
        console.warn(
          "[EditorPane] toggleEditorMode: user forced mode switch while CRDT not synced; " +
          "content may be incomplete if yDoc is stale",
        );
        lastUnsyncedClickAtRef.current = 0;
        // 落到下面正常流程
      } else {
        lastUnsyncedClickAtRef.current = now;
        try {
          toast.warning(
            `${t("editor.modeSwitch.syncingToast")}（${t("editor.modeSwitch.forceHint")}）`,
            4000,
          );
        } catch { /* ignore */ }
        return;
      }
    } else {
      // 已同步或未启用协同 → 清掉遗留时间戳
      lastUnsyncedClickAtRef.current = 0;
    }

    modeSwitchInflightRef.current = true;
    setModeSwitching(true);

    // ② 切换前快照，失败时回滚（D5）
    const preSwitchNote = activeNoteRef.current
      ? { ...activeNoteRef.current }
      : null;

    const fromMode = editorMode;
    const next: EditorMode = nextEditorMode(fromMode);

    try {
      // ③ 等待 handleUpdate 的在途 PUT（D6，不变量 2）
      //    不等的后果：规范化 PUT(v=N) 与 debounce PUT(v=N) 并发，409 reconcile 时
      //    先到者 bump v 后，后到者重放把旧内容覆盖回来。
      if (saveInflightRef.current) {
        try {
          await saveInflightRef.current;
        } catch {
          /* handleUpdate 内部已处理，这里只是串行化 */
        }
      }

      // ④ 取当前编辑器内容快照（同步读，避免依赖 flushSave 的异步 PUT）
      let snapshot: { content: string; contentText: string } | null = null;
      try {
        snapshot = editorHandleRef.current?.getSnapshot?.() ?? null;
      } catch (err) {
        console.warn("[EditorPane] getSnapshot before switch failed:", err);
      }

      // ⑤ 按方向选择 flush 策略
      //    - MD→RTE：flushSave —— 内部 PUT 的是 markdown，与最终 notes.content 一致，无副作用
      //    - RTE→MD：discardPending —— 避免 Tiptap JSON PUT 与规范化 PUT 竞态
      try {
        if (fromMode === "md") {
          editorHandleRef.current?.flushSave();
        } else {
          editorHandleRef.current?.discardPending?.();
        }
      } catch (err) {
        console.warn("[EditorPane] flush/discard before switch failed:", err);
      }

      // ⑥ MD→RTE：CRDT 漂移兜底 —— 从 yDoc 读最新 markdown 回填 activeNote
      //    MD 下真正内容在 yText 里，activeNote.content 只在打开笔记时赋过一次；
      //    不回填，TiptapEditor mount 时 parseContent 会用旧 note.content 初始化。
      if (fromMode === "md") {
        syncActiveNoteFromYDoc();
      }

      // ⑦ RTE→MD：normalizeToMarkdown + 规范化 PUT
      //    失败时 rollback + return（不变量 4）
      if (fromMode === "tiptap") {
        const ok = await normalizeAndPersistOnSwitchRteToMd(snapshot, preSwitchNote);
        if (!ok) return;
      }

      // ⑧ 副作用提交
      //    所有副作用放在 setEditorMode 外面（avoid React18 "setState during render"）
      persistEditorMode(next);
      clearForcedModeFromUrl();
      setEditorMode(next);

      // 清状态栏残留：旧编辑器的 saving/error 文案不应跨越到新编辑器
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
      } catch { /* toast 不可用也没关系 */ }

      // ⑨ MD→RTE：释放服务端 y room（不变量 3）
      //    失败仅记录日志——syncToYjs 机制会在下次切回 MD 前修正状态。
      if (next === "tiptap" && preSwitchNote) {
        try {
          await api.releaseYjsRoom(preSwitchNote.id);
        } catch (err) {
          console.warn("[EditorPane] releaseYjsRoom after MD→RTE switch failed:", err);
        }
      }
    } finally {
      modeSwitchInflightRef.current = false;
      setModeSwitching(false);
    }
  // toggleEditorMode 依赖仅 editorMode / actions / t；子函数读取其他 ref 不需要入 deps
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editorMode, actions, t]);

  // ---------------------------------------------------------------------------
  // toggleEditorMode 的内部子过程（拆出来降低圈复杂度，见 A1）
  // ---------------------------------------------------------------------------

  /**
   * MD→RTE 前，从 yDoc 读取最新 markdown 回填 activeNote。
   *
   * 只读取 ref（不依赖闭包），因此不需要 useCallback；也避免把它加到
   * toggleEditorMode 的 deps 里。
   */
  function syncActiveNoteFromYDoc() {
    const yDocNow = collabYDocRef.current;
    const note = activeNoteRef.current;
    if (!yDocNow || !note || note.isLocked) return;
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
   * RTE→MD：把 Tiptap JSON 规范化为 markdown，本地先回填 activeNote，
   * 再 PUT 回服务端（带乐观锁 + syncToYjs）。
   *
   * 返回 true 表示成功或无需 PUT（可以继续推进 setEditorMode）；
   * 返回 false 表示规范化 PUT 失败并已完成回滚（toggleEditorMode 应提前 return）。
   */
  async function normalizeAndPersistOnSwitchRteToMd(
    snapshot: { content: string; contentText: string } | null,
    preSwitchNote: ReturnType<typeof Object.assign> | null,
  ): Promise<boolean> {
    const note = activeNoteRef.current;
    if (!snapshot || !note || note.isLocked) return true;

    // snapshot.content 通常是 Tiptap JSON 字符串；兜底识别一下。
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
        console.warn("[EditorPane] normalize RTE→MD content failed:", err);
      }
    }

    // 本地先回填，让新 MD 编辑器 mount 时读到规范化后的内容
    // （即使后续 PUT 失败，也能立即以本地 markdown 渲染）
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

    // syncToYjs=true 让服务端在 REST 成功后把 yText 同步替换为这份 markdown，
    // 保证下次切回 MD 时 y:join 拿到的 state 与 notes.content 一致。
    const sendNormalizePut = (version: number) =>
      api.updateNote(noteId, {
        content: normalizedMd,
        contentText: normalizedText,
        version,
        syncToYjs: true,
      } as any);

    try {
      actions.setSyncStatus("saving");
      const updated = await putWithReconcile({
        initialVersion,
        send: sendNormalizePut,
        fetchLatestVersion: makeFetchLatestNoteVersion(noteId),
        onAbort: () => activeNoteRef.current?.id !== noteId,
      });

      // 回填 version / updatedAt，避免后续 handleUpdate 继续 409
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
      // Abort（切笔记）按 idle 处理，仍视为可继续切换
      if (isAborted(err)) {
        actions.setSyncStatus("idle");
        return true;
      }
      console.warn("[EditorPane] normalize PUT on mode switch failed:", err);
      actions.setSyncStatus("error");

      // 回滚 activeNote：避免本地 content 已被 normalizedMd 覆盖但 editorMode 没切
      // （会让 Tiptap 把 markdown 当 JSON 解析 → 编辑器视觉错乱）
      if (preSwitchNote && activeNoteRef.current?.id === (preSwitchNote as any).id) {
        actions.setActiveNote(preSwitchNote as any);
      }
      try { toast.error(t("editor.modeSwitch.failRollback")); } catch { /* ignore */ }
      return false;
    }
  }

  /**
   * 切换笔记（activeNote.id 变化）前，也把当前编辑器的 debounce 立刻刷一次，
   * 防止"写到一半切走 → 500ms 内丢字"。
   */
  const lastActiveIdRef = useRef<string | null>(activeNote?.id ?? null);
  useEffect(() => {
    const prevId = lastActiveIdRef.current;
    const nextId = activeNote?.id ?? null;
    if (prevId && prevId !== nextId) {
      try { editorHandleRef.current?.flushSave(); } catch { /* ignore */ }
    }
    lastActiveIdRef.current = nextId;
  }, [activeNote?.id]);

  // 使用 ref 追踪最新的 activeNote，避免 handleUpdate 闭包引用过期
  const activeNoteRef = useRef(activeNote);
  activeNoteRef.current = activeNote;

  // ---------------------------------------------------------------------------
  // Phase 2: 实时协作 —— Presence / 软锁 / 远程更新提示
  // ---------------------------------------------------------------------------
  /** 远程更新横幅：当别人保存了同一篇笔记，提示用户重新加载 */
  const [remoteUpdate, setRemoteUpdate] = useState<{ actorUserId?: string; version: number } | null>(null);
  /** 远程删除横幅 */
  const [remoteDelete, setRemoteDelete] = useState<{ actorUserId?: string; trashed?: boolean } | null>(null);

  const { presenceUsers, isConnected, setEditing: rtSetEditing } = useRealtimeNote({
    noteId: activeNote?.id ?? null,
    onRemoteUpdate: (msg) => {
      // 只对当前激活笔记生效；注意闭包里用 activeNoteRef 拿最新值
      const cur = activeNoteRef.current;
      if (!cur || cur.id !== msg.noteId) return;
      // 若我方 version 已经 >= 远程版本（自己刚保存过但广播延迟到达），忽略
      if (cur.version >= msg.version) return;
      // Phase 3: CRDT 托管的笔记不需要"请重新加载"横幅，因为 yCollab 会自动合并
      if (collabYDoc) return;
      setRemoteUpdate({ actorUserId: msg.actorUserId, version: msg.version });
    },
    onRemoteDelete: (msg) => {
      const cur = activeNoteRef.current;
      if (!cur || cur.id !== msg.noteId) return;
      setRemoteDelete({ actorUserId: msg.actorUserId, trashed: msg.trashed });
    },
  });

  // ---------------------------------------------------------------------------
  // Phase 3: Y.js CRDT 协同
  // ---------------------------------------------------------------------------
  /** 当前登录用户信息，用于 awareness 显示本人名字与颜色 */
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
      .catch(() => { /* 未登录/网络失败静默 */ });
    return () => { cancelled = true; };
  }, [selfUser]);

  /**
   * Phase 3 启用条件：
   *   - 使用 Markdown 编辑器（Tiptap JSON 无法无损映射到 Y.Text）
   *   - 笔记未锁定（锁定态直接只读，无需协同）
   *   - 已知当前用户信息（作为 awareness 身份）
   *   - 有 activeNote
   *
   * 注：单人场景下也启用——本地只一个 client，y-collab 相当于空操作，但获得了
   * 服务端增量持久化与断线重连后的自动合并。
   */
  const collabReady = !!(activeNote && !activeNote.isLocked && selfUser && editorMode === "md");
  const { doc: collabYDoc, provider: collabProvider, synced: collabSynced } = useYDoc({
    noteId: collabReady ? (activeNote?.id ?? null) : null,
    user: selfUser,
    enabled: collabReady,
  });

  /**
   * collabYDoc 的 ref 镜像。
   *
   * 背景：`toggleEditorMode`（在组件顶部定义）需要在切换前从 yDoc 读取最新
   * markdown 回填 activeNote，避免切到 RTE 后丢最近几百毫秒的输入。但是
   * `toggleEditorMode` 声明点在 `collabYDoc` 之前，若把 collabYDoc 直接写进
   * useCallback 的闭包与 deps，会踩 TDZ（初次 render 时 deps 数组求值发生在
   * useYDoc 之前，collabYDoc 还在暂时性死区）。用 ref 间接访问即可规避。
   */
  const collabYDocRef = useRef<typeof collabYDoc>(null);
  collabYDocRef.current = collabYDoc;

  /**
   * CRDT synced 状态的 ref 镜像。
   *
   * 用途：
   *   - toggleEditorMode 需要在切换前判断"CRDT 是否已完成初次 sync"。未 synced 时
   *     yDoc.getText("content") 读出来可能是空串（还没收到服务端 y:sync），
   *     此时贸然切到 RTE 会把空内容当作最新内容回填 activeNote，用户最近输入全丢。
   *   - 同样用 ref 而非直接引用 collabSynced，规避 toggleEditorMode useCallback
   *     的 TDZ 问题（声明顺序晚于 toggleEditorMode）。
   *   - collabReadyRef 用于区分"没启用 CRDT (MD→RTE 不在 CRDT 模式)"与"启用但未 sync"。
   */
  const collabSyncedRef = useRef<boolean>(false);
  collabSyncedRef.current = collabSynced;
  const collabReadyRef = useRef<boolean>(false);
  collabReadyRef.current = collabReady;

  /**
   * UX7 救命出口：记录上次"未 sync 时尝试切换"的时间戳。
   * 第一次点击：toast 警告+记录时间戳，阻止切换。
   * 3 秒内第二次点击：认为用户坚持切换，放行（绕过 UX6 保护）。
   * 超过 3 秒：时间戳过期，视为新一次"第一次点击"。
   * 用 ref 存，不污染 render 循环。
   */
  const lastUnsyncedClickAtRef = useRef<number>(0);

  // 切换笔记时清空横幅
  useEffect(() => {
    setRemoteUpdate(null);
    setRemoteDelete(null);
  }, [activeNote?.id]);

  // ── 切换笔记时自动检测 HTML 格式并进入预览模式 ──
  // 如果笔记内容格式为 "html"，自动启用 HTML 预览；否则回退到常规编辑器。
  useEffect(() => {
    if (!activeNote) return;
    const fmt = detectFormat(activeNote.content);
    const isHtml = fmt === "html";
    const isFullDoc = isHtml && isFullHtmlDocument(activeNote.content);
    setHtmlPreviewMode(isHtml);
    setNoteIsHtml(isHtml);
    setNoteIsFullHtmlDoc(isFullDoc);
  }, [activeNote?.id]); // 只在切换笔记时检测，编辑过程中不再自动切换

  /** 从 presence 中反查用户名（用于横幅显示） */
  const findUsername = useCallback(
    (userId?: string) => {
      if (!userId) return undefined;
      const match = presenceUsers.find((u) => u.userId === userId);
      return match?.username;
    },
    [presenceUsers],
  );

  /** 用户点"重新加载"：拉取最新笔记，先 flush 本地 pending 再覆盖 activeNote */
  const handleReloadRemote = useCallback(async () => {
    const cur = activeNoteRef.current;
    if (!cur) return;
    try { editorHandleRef.current?.flushSave(); } catch {}
    try {
      const fresh = await api.getNote(cur.id);
      actions.setActiveNote(fresh);
      actions.updateNoteInList({
        id: fresh.id,
        title: fresh.title,
        contentText: fresh.contentText,
        updatedAt: fresh.updatedAt,
      });
    } catch (e) {
      console.warn("[Phase2] reload remote note failed:", e);
      toast.error("加载最新版本失败");
    }
    setRemoteUpdate(null);
  }, [actions]);

  /** 用户确认远程删除提示：清空当前笔记并从列表移除 */
  const handleAckRemoteDelete = useCallback(() => {
    const cur = activeNoteRef.current;
    if (cur) {
      actions.setActiveNote(null);
      actions.removeNoteFromList(cur.id);
      // 回收站：refreshNotes 会把它加回"回收站"视图
      actions.refreshNotes();
    }
    setRemoteDelete(null);
  }, [actions]);

  /** 编辑态广播：handleUpdate 调用时临时置 editing=true，500ms 后自动取消 */
  const editingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flagEditing = useCallback(() => {
    rtSetEditing(true);
    if (editingTimerRef.current) clearTimeout(editingTimerRef.current);
    editingTimerRef.current = setTimeout(() => {
      rtSetEditing(false);
      editingTimerRef.current = null;
    }, 1500);
  }, [rtSetEditing]);
  // 组件卸载时清理
  useEffect(() => {
    return () => {
      if (editingTimerRef.current) clearTimeout(editingTimerRef.current);
    };
  }, []);

  // 窗口卸载前兜底 flush（刷新、关闭标签）
  useEffect(() => {
    const onBeforeUnload = () => {
      try { editorHandleRef.current?.flushSave(); } catch { /* ignore */ }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  // Delete 键删除笔记快捷键（仅在编辑器未聚焦时生效）
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Delete" && activeNote && !activeNote.isLocked) {
        // 检查焦点是否在编辑器内部（如果在编辑器内，Delete 键应该正常删除文字）
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

  // 点击外部关闭移动端菜单
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

  const handleUpdate = useCallback(async (data: { content?: string; contentText?: string; title: string }) => {
    const currentNote = activeNoteRef.current;
    if (!currentNote || currentNote.isLocked) return;
    // Phase 2: 广播"我正在编辑"（1.5s 内无新输入则自动取消）
    try { flagEditing(); } catch {}
    actions.setSyncStatus("saving");

    // 封装成小函数以便 409 后用 server 返回的 currentVersion 重放一次。
    const sendOnce = (version: number) => {
      // P0-#2 修复：CRDT 模式下 content 未传 → 只同步 meta（title），
      // 避免 REST PUT 与服务端 yjs 回写 notes.content 产生竞态覆盖
      const payload: any = { title: data.title, version };
      if (data.content !== undefined) payload.content = data.content;
      if (data.contentText !== undefined) payload.contentText = data.contentText;
      return api.updateNote(currentNote.id, payload);
    };

    // 把本次 PUT 注册为 "inflight"，供 toggleEditorMode 在切换前 await。
    // 串行化的是"本组件发起的 REST PUT"，不涉及 yjs update 流。
    //
    // 并发多次调用时后进者直接覆盖 ref（上一次的 handleUpdate 也还在 await 这个
    // inflight 链），无需 FIFO 队列；toggleEditorMode 只关心"切换点当下还未完成
    // 的那一笔 PUT"。
    const inflight = (async () => {
    try {
      // 乐观锁冲突 reconcile：服务端返回 { status: 409, currentVersion: N }。
      // 不做这一步的话，本地 activeNote.version 永远停留在旧值，之后每次 debounce
      // 自动保存都会再次 409，形成"409 风暴"（后端日志里能看到几十次连续 409）。
      //
      // putWithReconcile 的策略（与 toggleEditorMode 的规范化 PUT 共用同一套实现）：
      //   1) 首选用 err.currentVersion 重放一次；
      //   2) 服务端没附带版本号时再兜底走 fetchLatestVersion（GET /notes/:id）；
      //   3) 期间切笔记（onAbort）则 abort 重放，防止把旧笔记内容写入新笔记。
      const updated = await putWithReconcile({
        initialVersion: currentNote.version,
        send: sendOnce,
        fetchLatestVersion: makeFetchLatestNoteVersion(currentNote.id),
        onAbort: () => activeNoteRef.current?.id !== currentNote.id,
      });

      // 仅在保存的笔记仍是当前激活笔记时更新状态（防止快速切换时覆盖错误笔记）
      if (activeNoteRef.current?.id === updated.id) {
        // 关键：必须把刚保存的 content / contentText 也回填到 activeNote。
        //
        // 背景（为什么之前只回填元数据）：曾经担心 content 回填会让 activeNote
        // 引用变化 → TiptapEditor 的 useEffect([note.content]) 触发 setContent
        // → 光标/输入被打断。所以之前只回填 version/updatedAt/title。
        //
        // 但这在"切换编辑器 (MD ↔ RTE)"场景下是致命 bug：
        //   - MD 编辑器保存 → activeNote.content 仍是旧 Tiptap JSON（未刷新）
        //   - 切到 Tiptap → TiptapEditor 读 note.content → 读到的是旧 JSON
        //     → 用户在 MD 里做的所有修改完全"消失"
        //   - 反向同理
        // 表现为"来回切换就丢内容、后续修改也被清空"。
        //
        // 解决办法：这里必须回填。编辑器侧通过 lastEmittedContentRef 守卫，
        // 比较 note.content 是否等于自己上次派出去的那份，是就跳过 setContent，
        // 避免光标抖动；不是（来自另一个编辑器或版本恢复）就正常同步。
        actions.setActiveNote({
          ...activeNoteRef.current,
          version: updated.version,
          updatedAt: updated.updatedAt,
          title: data.title,
          // CRDT 模式下 data.content 为 undefined → 保留 activeNote 原值（由 yjs 广播更新）
          content: data.content !== undefined ? data.content : activeNoteRef.current.content,
          contentText:
            data.contentText !== undefined ? data.contentText : activeNoteRef.current.contentText,
        });
        actions.updateNoteInList({ id: updated.id, title: updated.title, contentText: updated.contentText, updatedAt: updated.updatedAt });
        actions.setSyncStatus("saved");
        actions.setLastSynced(new Date().toISOString());
        // 2秒后恢复 idle
        if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
        savedTimerRef.current = setTimeout(() => actions.setSyncStatus("idle"), 2000);
      }
    } catch (err) {
      // 切笔记中断（putWithReconcile 内部标记为 aborted）不是真正的错误
      if (isAborted(err)) return;
      console.warn("[EditorPane] save failed:", err);
      actions.setSyncStatus("error");
    }
    })();

    saveInflightRef.current = inflight;
    try {
      await inflight;
    } finally {
      // 只清空"自己"注册的那份；若期间又有新 PUT 注册新 promise，保留不动
      if (saveInflightRef.current === inflight) {
        saveInflightRef.current = null;
      }
    }
  }, [actions, flagEditing]);

  // 手动触发同步：重新保存当前编辑器内容
  const handleManualSync = useCallback(async () => {
    if (!activeNote || syncStatus === "saving") return;
    actions.setSyncStatus("saving");
    try {
      const updated = await api.updateNote(activeNote.id, {
        title: activeNote.title,
        content: activeNote.content,
        contentText: activeNote.contentText,
        version: activeNote.version,
      } as any);
      actions.setActiveNote(updated);
      actions.updateNoteInList({ id: updated.id, title: updated.title, contentText: updated.contentText, updatedAt: updated.updatedAt });
      actions.setSyncStatus("saved");
      actions.setLastSynced(new Date().toISOString());
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
      savedTimerRef.current = setTimeout(() => actions.setSyncStatus("idle"), 2000);
    } catch {
      actions.setSyncStatus("error");
    }
  }, [activeNote, syncStatus, actions]);

  const toggleFavorite = useCallback(async () => {
    if (!activeNote) return;
    haptic.light();
    const updated = await api.updateNote(activeNote.id, { isFavorite: activeNote.isFavorite ? 0 : 1 } as any);
    actions.setActiveNote(updated);
    actions.updateNoteInList({ id: updated.id, isFavorite: updated.isFavorite });
  }, [activeNote, actions]);

  const togglePin = useCallback(async () => {
    if (!activeNote) return;
    haptic.light();
    const updated = await api.updateNote(activeNote.id, { isPinned: activeNote.isPinned ? 0 : 1 } as any);
    actions.setActiveNote(updated);
    actions.updateNoteInList({ id: updated.id, isPinned: updated.isPinned });
  }, [activeNote, actions]);

  const toggleLock = useCallback(async () => {
    if (!activeNote) return;
    haptic.medium();
    const updated = await api.updateNote(activeNote.id, { isLocked: activeNote.isLocked ? 0 : 1 } as any);
    actions.setActiveNote(updated);
    actions.updateNoteInList({ id: updated.id, isLocked: updated.isLocked });
  }, [activeNote, actions]);

  const moveToTrash = useCallback(async () => {
    if (!activeNote || activeNote.isLocked) return;
    haptic.heavy();
    const noteId = activeNote.id;
    actions.setActiveNote(null);
    actions.removeNoteFromList(noteId);
    api.updateNote(noteId, { isTrashed: 1 } as any)
      .then(() => {
        actions.refreshNotebooks();
        // 刷新列表：若当前处于"回收站"视图，这条笔记需要立即出现；
        // 其他视图也重新拉一下，保证与服务端一致。
        actions.refreshNotes();
      })
      .catch(console.error);
  }, [activeNote, actions]);

  const handleTagsChange = useCallback((tags: Tag[]) => {
    if (!activeNote) return;
    actions.setActiveNote({ ...activeNote, tags });
    api.getTags().then(actions.setTags).catch(console.error);
  }, [activeNote, actions]);

  // AI 生成标题
  const [aiTitleLoading, setAiTitleLoading] = useState(false);
  const handleAITitle = useCallback(async () => {
    if (!activeNote || !activeNote.contentText || aiTitleLoading) return;
    setAiTitleLoading(true);
    try {
      // 1) 先把编辑器里 pending 的 debounce 改动 flush 出去，避免：
      //    - AI 基于过期的 contentText 生成标题
      //    - 稍后 updateNote 因 version 落后被后端返回 409 "Version conflict"
      //      导致标题请求静默失败（之前只 console.error，用户看不到任何反馈）。
      try { editorHandleRef.current?.flushSave(); } catch { /* ignore */ }

      // 2) AI 生成
      const rawTitle = await api.aiChat("title", activeNote.contentText.slice(0, 2000));
      const cleaned = rawTitle.replace(/^["'"""'']+|["'"""'']+$/g, "").trim();
      if (!cleaned) {
        toast.error(t('editor.aiTitleFailed') || "AI 未返回有效标题");
        return;
      }

      // 3) 写入标题：带乐观锁冲突的一次性重试。
      //    MD 编辑器 debounce 虽然已 flush，但 AI 请求耗时中用户仍可能继续输入
      //    → 保存 → version 自增；这里如果 409，就重新拉最新笔记拿新 version 再试。
      const doUpdate = async (version: number) =>
        api.updateNote(activeNote.id, { title: cleaned, version } as any);

      let updated;
      try {
        updated = await doUpdate(activeNote.version);
      } catch (err: any) {
        const msg = String(err?.message || "");
        if (/409|conflict/i.test(msg)) {
          // 只需要 latest.version 去做重试，用 slim 避免拉大 content（可能几 MB base64 图）。
          const latest = await api.getNoteSlim(activeNote.id).catch(() => null);
          if (latest?.version !== undefined) {
            updated = await doUpdate(latest.version);
          } else {
            throw err;
          }
        } else {
          throw err;
        }
      }

      // 4) 同步前端状态；MarkdownEditor 侧有独立的 [note.title] effect
      //    会把非受控 title input 的 DOM 值刷新成新标题。
      actions.setActiveNote(updated);
      actions.updateNoteInList({ id: updated.id, title: updated.title, updatedAt: updated.updatedAt });
      toast.success(t('editor.aiTitleApplied') || "已应用 AI 生成的标题");
    } catch (e: any) {
      console.error("AI title error:", e);
      toast.error(e?.message || t('editor.aiTitleFailed') || "AI 生成标题失败");
    } finally {
      setAiTitleLoading(false);
    }
  }, [activeNote, actions, aiTitleLoading, t]);

  // AI 推荐标签
  const [aiTagsLoading, setAiTagsLoading] = useState(false);
  const handleAITags = useCallback(async () => {
    if (!activeNote || !activeNote.contentText || aiTagsLoading) return;
    setAiTagsLoading(true);
    try {
      const result = await api.aiChat("tags", activeNote.contentText.slice(0, 2000));
      const tagNames = result.split(/[,，、\s]+/).map(s => s.replace(/^#/, "").trim()).filter(Boolean);
      for (const name of tagNames) {
        // 检查是否已存在
        const existing = state.tags.find(t => t.name === name);
        let tagId: string;
        if (existing) {
          tagId = existing.id;
        } else {
          const newTag = await api.createTag({ name });
          tagId = newTag.id;
        }
        // 检查是否已关联
        const noteTags = activeNote.tags || [];
        if (!noteTags.find(t => t.id === tagId)) {
          await api.addTagToNote(activeNote.id, tagId);
        }
      }
      // 重新获取笔记和标签
      const updatedNote = await api.getNote(activeNote.id);
      actions.setActiveNote(updatedNote);
      api.getTags().then(actions.setTags).catch(console.error);
    } catch (e) { console.error("AI tags error:", e); }
    setAiTagsLoading(false);
  }, [activeNote, actions, state.tags, aiTagsLoading]);

  const handleMoveToNotebook = useCallback(async (notebookId: string) => {
    if (!activeNote || notebookId === activeNote.notebookId) return;
    const updated = await api.updateNote(activeNote.id, { notebookId } as any);
    actions.setActiveNote(updated);
    actions.updateNoteInList({ id: updated.id, notebookId: updated.notebookId });
    setShowMoveDropdown(false);
    actions.refreshNotebooks();
  }, [activeNote, actions]);

  // 构建与左侧侧边栏完全一致的笔记本树
  const notebookTree = useMemo(() => buildTree(state.notebooks), [state.notebooks]);
  // 当前笔记所属笔记本的完整路径（面包屑）
  const currentPath = useMemo(
    () => findPathById(state.notebooks, activeNote?.notebookId),
    [state.notebooks, activeNote?.notebookId]
  );

  if (!activeNote) {
    return (
      <div className="flex-1 flex items-center justify-center bg-app-bg transition-colors">
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
              <span className="text-accent-primary/50 text-xs">✦</span>
            </div>
          </div>
          <p className="text-tx-secondary text-sm font-medium mb-1">{t('editor.selectNote')}</p>
          <p className="text-tx-tertiary text-xs max-w-[220px] leading-relaxed">{t('editor.orCreateNew')}</p>
          <div className="flex items-center gap-3 mt-5">
            <kbd className="px-2 py-1 rounded-md bg-app-hover border border-app-border text-[10px] text-tx-tertiary font-mono">Alt+N</kbd>
            <span className="text-[10px] text-tx-tertiary">{t('editor.newNoteShortcut') || '快速新建笔记'}</span>
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
      className="flex-1 flex flex-col bg-app-bg overflow-hidden transition-colors"
    >
      {/* Mobile Editor Header - 返回按钮 */}
      <header className="flex items-center gap-2 px-3 py-2 border-b border-app-border bg-app-surface/50 md:hidden" style={{ paddingTop: 'calc(var(--safe-area-top) + 8px)' }}>
        <button
          onClick={() => actions.setMobileView("list")}
          className="flex items-center text-accent-primary py-1.5 px-1.5 -ml-1.5 rounded-lg active:bg-app-hover"
        >
          <ChevronLeft size={24} />
          <span className="text-sm font-medium">{t('editor.back')}</span>
        </button>
        <div className="ml-auto flex items-center gap-1.5">
          <PresenceBar users={presenceUsers} isConnected={isConnected} maxVisible={2} />
          <SyncIndicator syncStatus={syncStatus} lastSyncedAt={lastSyncedAt} onManualSync={handleManualSync} />
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={toggleLock}
            title={activeNote.isLocked ? t('editor.unlockTooltip') : t('editor.lockTooltip')}>
            {activeNote.isLocked
              ? <Lock size={16} className="text-orange-500" />
              : <Unlock size={16} />}
          </Button>
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={togglePin}>
            <Pin size={16} className={cn(activeNote.isPinned && "text-accent-primary fill-accent-primary")} />
          </Button>
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={toggleFavorite}>
            <Star size={16} className={cn(activeNote.isFavorite && "text-amber-400 fill-amber-400")} />
          </Button>
          {/* 更多操作按钮 */}
          <div className="relative" ref={mobileMenuRef}>
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => { setShowMobileMenu(!showMobileMenu); setShowMobileMoveMenu(false); }}>
              <MoreHorizontal size={16} />
            </Button>
            {/* 更多操作下拉菜单 */}
            <AnimatePresence>
              {showMobileMenu && (
                <motion.div
                  initial={{ opacity: 0, scale: 0.95, y: -4 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.95, y: -4 }}
                  transition={{ duration: 0.12 }}
                  className="absolute top-full right-0 mt-1 w-56 bg-app-elevated border border-app-border rounded-lg shadow-xl z-50 py-1 overflow-hidden"
                >
                  {/* 移动笔记本 */}
                  <button
                    onClick={() => setShowMobileMoveMenu(!showMobileMoveMenu)}
                    className="w-full flex items-center gap-2.5 px-3 py-2.5 text-sm text-tx-secondary active:bg-app-hover transition-colors"
                  >
                    <FolderInput size={15} className="text-tx-tertiary" />
                    <span className="flex-1 text-left">{t('editor.moveToNotebook')}</span>
                    <ChevronRight size={14} className="text-tx-tertiary" />
                  </button>
                  {/* 移动笔记本子菜单 */}
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
                  {/* 大纲 */}
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
                  {/* AI 生成标题 */}
                  <button
                    onClick={() => {
                      handleAITitle();
                      setShowMobileMenu(false);
                    }}
                    disabled={aiTitleLoading || !activeNote.contentText || !!activeNote.isLocked}
                    className="w-full flex items-center gap-2.5 px-3 py-2.5 text-sm text-tx-secondary active:bg-app-hover transition-colors disabled:opacity-40"
                  >
                    {aiTitleLoading ? <Loader2 size={15} className="animate-spin text-violet-500" /> : <Type size={15} className="text-violet-500" />}
                    <span>{t('editor.aiGenerateTitle')}</span>
                  </button>
                  {/* AI 推荐标签 */}
                  <button
                    onClick={() => {
                      handleAITags();
                      setShowMobileMenu(false);
                    }}
                    disabled={aiTagsLoading || !activeNote.contentText || !!activeNote.isLocked}
                    className="w-full flex items-center gap-2.5 px-3 py-2.5 text-sm text-tx-secondary active:bg-app-hover transition-colors disabled:opacity-40"
                  >
                    {aiTagsLoading ? <Loader2 size={15} className="animate-spin text-violet-500" /> : <TagIcon size={15} className="text-violet-500" />}
                    <span>{t('editor.aiSuggestTags')}</span>
                  </button>
                  <div className="h-px bg-app-border mx-2 my-0.5" />
                  {/* 分享 */}
                  <button
                    onClick={() => {
                      setShowShareModal(true);
                      setShowMobileMenu(false);
                    }}
                    className="w-full flex items-center gap-2.5 px-3 py-2.5 text-sm text-tx-secondary active:bg-app-hover transition-colors"
                  >
                    <Share2 size={15} className="text-emerald-500" />
                    <span>分享</span>
                  </button>
                  {/* 版本历史 */}
                  <button
                    onClick={() => {
                      setShowVersionHistory(true);
                      setShowMobileMenu(false);
                    }}
                    className="w-full flex items-center gap-2.5 px-3 py-2.5 text-sm text-tx-secondary active:bg-app-hover transition-colors"
                  >
                    <History size={15} className="text-violet-500" />
                    <span>版本历史</span>
                  </button>
                  {/* 评论 */}
                  <button
                    onClick={() => {
                      setShowCommentPanel(true);
                      setShowMobileMenu(false);
                    }}
                    className="w-full flex items-center gap-2.5 px-3 py-2.5 text-sm text-tx-secondary active:bg-app-hover transition-colors"
                  >
                    <MessageCircle size={15} className="text-blue-500" />
                    <span>评论批注</span>
                  </button>
                  {/* HTML 预览 / 编辑切换（仅 HTML 片段笔记显示，完全克隆不支持编辑） */}
                  {noteIsHtml && !noteIsFullHtmlDoc && (
                    <>
                      <div className="h-px bg-app-border mx-2 my-0.5" />
                      <button
                        onClick={async () => {
                          setShowMobileMenu(false);
                          if (htmlPreviewMode) {
                            setShowHtmlEditWarning(true);
                          } else {
                            // 从编辑切回预览——先 flush 编辑器 pending 数据，确保最新内容已保存
                            try { await editorHandleRef.current?.flushSave(); } catch {}
                            // 不覆盖 activeNote.content：让预览展示编辑后的最新内容
                            setHtmlPreviewMode(true);
                          }
                        }}
                        className="w-full flex items-center gap-2.5 px-3 py-2.5 text-sm text-tx-secondary active:bg-app-hover transition-colors"
                      >
                        {htmlPreviewMode ? <Pencil size={15} className="text-amber-500" /> : <Eye size={15} className="text-blue-500" />}
                        <span>{htmlPreviewMode ? t("editor.htmlPreview.switchToEdit") : t("editor.htmlPreview.switchToPreview")}</span>
                      </button>
                    </>
                  )}
                  <div className="h-px bg-app-border mx-2 my-0.5" />
                  {/* 删除笔记 */}
                  <button
                    onClick={() => {
                      moveToTrash();
                      setShowMobileMenu(false);
                    }}
                    disabled={!!activeNote.isLocked}
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

      {/* Mobile Outline Panel (全屏覆盖) */}
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
      <div className="hidden md:flex items-center justify-between px-4 py-2 border-b border-app-border bg-app-surface/30 transition-colors">
        <div className="relative">
          <button
            onClick={() => setShowMoveDropdown(!showMoveDropdown)}
            className="flex items-center gap-1 text-xs text-tx-tertiary hover:text-tx-secondary transition-colors rounded-md px-1.5 py-1 hover:bg-app-hover max-w-[520px]"
            title={t('editor.moveToNotebook')}
          >
            {currentPath.length > 0 ? (
              <span className="flex items-center gap-1 min-w-0">
                {currentPath.map((nb, idx) => (
                  <React.Fragment key={nb.id}>
                    {idx > 0 && <ChevronRight size={11} className="text-tx-tertiary/60 shrink-0" />}
                    <span className={cn(
                      "flex items-center gap-1 shrink-0 truncate",
                      idx === currentPath.length - 1 && "text-tx-secondary font-medium"
                    )}>
                      <span>{nb.icon || "📁"}</span>
                      <span className="truncate max-w-[120px]">{nb.name}</span>
                    </span>
                  </React.Fragment>
                ))}
              </span>
            ) : (
              <span>—</span>
            )}
            <ChevronDown size={12} className="shrink-0 ml-0.5" />
          </button>
          {showMoveDropdown && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setShowMoveDropdown(false)} />
              <div
                ref={moveDropdownRef}
                className="absolute top-full left-0 mt-1 w-64 bg-app-elevated border border-app-border rounded-lg shadow-xl z-50 py-1 max-h-80 overflow-auto"
                style={{ animation: "contextMenuIn 0.12s ease-out" }}
              >
                <div className="px-3 py-1.5 text-[10px] font-medium text-tx-tertiary border-b border-app-border mb-1">
                  {t('editor.moveToLabel')}
                </div>
                <div className="px-1 pb-1">
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

        {/* Sync Indicator + Grouped Actions */}
        <div className="flex items-center gap-2">
          {/* Phase 2: Presence 头像条 */}
          <PresenceBar users={presenceUsers} isConnected={isConnected} />

          {/* Phase 3: CRDT 协同状态小徽章 */}
          {collabYDoc && (
            <span
              className={cn(
                "inline-flex items-center gap-1 px-1.5 h-5 rounded text-[10px] font-medium border",
                "bg-accent-primary/5 text-accent-primary border-accent-primary/20"
              )}
              title="Live 协同编辑（CRDT）：字符级实时合并，无冲突"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-accent-primary animate-pulse" />
              Live
            </span>
          )}

          {/* 同步状态 */}
          <SyncIndicator
            syncStatus={syncStatus}
            lastSyncedAt={lastSyncedAt}
            onManualSync={handleManualSync}
          />

          <div className="w-px h-4 bg-app-border" />

          {/* 编辑操作组 */}
          <div className="flex items-center gap-0.5 bg-app-hover/50 rounded-lg px-1 py-0.5">
            <Button
              variant="ghost" size="icon" className="h-7 w-7 rounded-md"
              onClick={toggleLock}
              title={activeNote.isLocked ? t('editor.unlockTooltip') : t('editor.lockTooltip')}
            >
              {activeNote.isLocked
                ? <Lock size={14} className="text-orange-500" />
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
            <Button
              variant="ghost" size="icon" className="h-7 w-7 rounded-md"
              onClick={moveToTrash}
              title={t('editor.trashTooltip')}
              disabled={!!activeNote.isLocked}
            >
              <Trash2 size={14} className={cn(activeNote.isLocked && "opacity-30")} />
            </Button>
          </div>

          {/* 大纲 */}
          <Button
            variant="ghost" size="icon" className="h-7 w-7"
            onClick={() => setShowOutline(!showOutline)}
            title={showOutline ? t('editor.hideOutline') : t('editor.showOutline')}
          >
            <ListTree size={14} className={cn(showOutline && "text-accent-primary")} />
          </Button>

          {/* 分享 */}
          <Button
            variant="ghost" size="icon" className="h-7 w-7"
            onClick={() => setShowShareModal(true)}
            title="分享笔记"
          >
            <Share2 size={14} className="text-emerald-500" />
          </Button>

          {/* 版本历史 */}
          <Button
            variant="ghost" size="icon" className="h-7 w-7"
            onClick={() => setShowVersionHistory(true)}
            title="版本历史"
          >
            <History size={14} className="text-violet-500" />
          </Button>

          {/* 评论批注 */}
          <Button
            variant="ghost" size="icon" className="h-7 w-7"
            onClick={() => setShowCommentPanel(true)}
            title="评论批注"
          >
            <MessageCircle size={14} className="text-blue-500" />
          </Button>

          {/* 编辑器模式切换（MD / Tiptap） */}
          {/*
            入口已对普通用户隐藏（见文件顶部 SHOW_EDITOR_MODE_TOGGLE 注释）。
            URL `?md=1|0` 仍然生效；toggleEditorMode 完整协议保留在下方。

            disabled 条件：
              - 仅 modeSwitching：正在切换中，避免重入。
            关于 collabSynced：
              早期版本曾在 `collabReady && !collabSynced` 时禁用按钮 + 显示"协同
              正在同步中"tooltip，但实测发现部分环境下 collabSynced 不可靠地停留在
              false（例如 realtime 未连通、provider 竟态、或服务端 y:sync 丢失），
              导致按钮永久灰灭、无法切回 RTE —— 这是比"误切丢字"更严重的体验问题。
              真正的保护放在入口 `toggleEditorMode` 开头（见上方 ① 入口）：
                if (collabReadyRef.current && !collabSyncedRef.current) {
                  toast.error(...); return;
                }
              按钮保持可点击，若 CRDT 仍未 sync 只弹 toast 不执行切换；sync 完成后
              再点即可顺利切换，永远不会陷入"按钮坏了"的死状态。
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

          {/* HTML 预览 / 编辑切换：仅在笔记原始格式为 HTML 时显示 */}
          {noteIsHtml && (
            <button
              onClick={async () => {
                if (htmlPreviewMode) {
                  // 从预览切到编辑——弹确认弹窗
                  setShowHtmlEditWarning(true);
                } else {
                  // 从编辑切回预览——先 flush 编辑器 pending 数据，确保最新内容已保存
                  try { await editorHandleRef.current?.flushSave(); } catch {}
                  // 不覆盖 activeNote.content：让 HtmlPreviewPane 展示编辑后的最新内容。
                  // 如果用户没做任何编辑，content 仍然是原始 HTML（完全克隆模式依旧生效）；
                  // 如果用户编辑过，content 已变为 MD/HTML 片段，预览组件会用片段模式渲染。
                  setHtmlPreviewMode(true);
                }
              }}
              title={
                htmlPreviewMode
                  ? t("editor.htmlPreview.switchToEditTooltip")
                  : t("editor.htmlPreview.switchToPreviewTooltip")
              }
              className={cn(
                "flex items-center gap-1 h-7 px-1.5 rounded-md text-[10px] font-medium transition-colors border",
                htmlPreviewMode
                  ? "bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/30 hover:bg-blue-500/15"
                  : "bg-app-hover text-tx-tertiary border-app-border hover:text-tx-secondary hover:bg-app-active"
              )}
            >
              {htmlPreviewMode ? <Eye size={12} /> : <Pencil size={12} />}
              <span>{htmlPreviewMode ? t("editor.htmlPreview.switchToEdit") : t("editor.htmlPreview.switchToPreview")}</span>
            </button>
          )}

          <div className="w-px h-4 bg-app-border" />

          {/* AI 工具组 */}
          <div className="flex items-center gap-0.5 bg-violet-500/5 dark:bg-violet-500/10 rounded-lg px-1 py-0.5">
            <Button
              variant="ghost" size="icon" className="h-7 w-7 rounded-md"
              onClick={handleAITitle}
              disabled={aiTitleLoading || !activeNote.contentText || !!activeNote.isLocked}
              title={t('editor.aiGenerateTitle')}
            >
              {aiTitleLoading ? <Loader2 size={14} className="animate-spin text-violet-500" /> : <Type size={14} className="text-violet-500" />}
            </Button>
            <Button
              variant="ghost" size="icon" className="h-7 w-7 rounded-md"
              onClick={handleAITags}
              disabled={aiTagsLoading || !activeNote.contentText || !!activeNote.isLocked}
              title={t('editor.aiSuggestTags')}
            >
              {aiTagsLoading ? <Loader2 size={14} className="animate-spin text-violet-500" /> : <TagIcon size={14} className="text-violet-500" />}
            </Button>
          </div>
        </div>
      </div>

      {/* Phase 2: 实时协作横幅（软锁 / 远程更新 / 远程删除） */}
      <EditingLockBanner users={presenceUsers} />
      {remoteUpdate && (
        <RemoteUpdateBanner
          actorName={findUsername(remoteUpdate.actorUserId)}
          onReload={handleReloadRemote}
          onDismiss={() => setRemoteUpdate(null)}
        />
      )}
      {remoteDelete && (
        <RemoteDeleteBanner
          actorName={findUsername(remoteDelete.actorUserId)}
          trashed={remoteDelete.trashed}
          onDismiss={handleAckRemoteDelete}
        />
      )}

      {/* Editor (HTML 预览 / MD / Tiptap 按模式分派) + Outline */}
      <div className="flex-1 flex overflow-hidden">
        <div className="flex-1 overflow-hidden relative">
          {htmlPreviewMode ? (
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
              // Phase 3: key 绑定 CRDT 启用态，切换 provider 时强制重建编辑器，
              // 避免 yCollab 扩展在运行时更换 yText 带来的状态错乱
              key={collabYDoc ? `md-y-${activeNote.id}` : `md-${activeNote.id}`}
              ref={editorHandleRef}
              note={activeNote}
              onUpdate={handleUpdate}
              onTagsChange={handleTagsChange}
              onHeadingsChange={setHeadings}
              onEditorReady={(fn) => { scrollToRef.current = fn; }}
              // UX3：模式切换期间冻结编辑（避免用户在 mount→unmount 间隔里敲字，
              // 这段输入进不了任一编辑器的数据流，属于"黑洞输入"）。
              editable={!activeNote.isLocked && !modeSwitching}
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
              editable={!activeNote.isLocked && !modeSwitching}
            />
          )}
          {/*
            UX1/UX2：编辑器切换中 overlay。
            - 盖在当前编辑器上方，阻挡误点击 / 视觉提示"切换中"；
            - AnimatePresence 让进出过渡平滑，避免"咔"一下；
            - pointer-events-auto 既拦截点击也防止 Tiptap/CM6 的选区被破坏。
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
      {/* 分享弹窗 */}
      {showShareModal && (
        <ShareModal
          noteId={activeNote.id}
          noteTitle={activeNote.title}
          onClose={() => setShowShareModal(false)}
        />
      )}

      {/* 版本历史 */}
      {showVersionHistory && (
        <VersionHistoryPanel
          noteId={activeNote.id}
          noteTitle={activeNote.title}
          onRestore={(updated) => {
            actions.setActiveNote(updated);
            actions.updateNoteInList({ id: updated.id, title: updated.title, contentText: updated.contentText, updatedAt: updated.updatedAt });
          }}
          onClose={() => setShowVersionHistory(false)}
        />
      )}

      {/* 评论面板 */}
      {showCommentPanel && (
        <CommentPanel
          noteId={activeNote.id}
          noteTitle={activeNote.title}
          onClose={() => setShowCommentPanel(false)}
        />
      )}

      {/* Delete 键删除确认弹窗 */}
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

      {/* HTML 预览 → 编辑模式切换确认弹窗 */}
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

      {showOutline && (
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

/* ===== 大纲面板 ===== */
function OutlinePanel({
  headings,
  onSelect,
  onClose,
}: {
  headings: HeadingItem[];
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

/* ===== 笔记本树构建（与 Sidebar.tsx 的 buildTree 完全一致） ===== */
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
  // 按 sortOrder 稳定排序，确保拖拽后的新顺序立即反映到 UI
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

/* 从根到指定 id 的完整路径（含自身），用于面包屑展示 */
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

/* ===== 编辑器顶部"移动笔记本"树形条目（与侧边栏目录结构保持一致） ===== */
function MoveTreeItem({
  notebook, depth, currentId, onSelect,
}: {
  notebook: Notebook;
  depth: number;
  currentId: string;
  onSelect: (id: string) => void;
}) {
  const hasChildren = !!notebook.children && notebook.children.length > 0;
  // 默认展开：若自身或子孙中包含当前笔记，则展开；否则折叠
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
        <span className="text-base shrink-0">{notebook.icon || "📁"}</span>
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

/* ===== 同步状态指示器 ===== */
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
  const getTooltip = () => {
    switch (syncStatus) {
      case "saving": return t('editor.saving');
      case "saved": return t('editor.allSaved');
      case "error": return t('editor.saveFailed');
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
      disabled={syncStatus === "saving"}
      title={getTooltip()}
      className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] transition-colors hover:bg-app-hover group"
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
        "hidden sm:inline transition-colors",
        syncStatus === "saving" && "text-accent-primary",
        syncStatus === "saved" && "text-green-500",
        syncStatus === "error" && "text-red-500",
        syncStatus === "idle" && "text-tx-tertiary group-hover:text-tx-secondary",
      )}>
        {syncStatus === "saving" && t('editor.savingStatus')}
        {syncStatus === "saved" && t('editor.savedStatus')}
        {syncStatus === "error" && t('editor.saveFailedStatus')}
        {syncStatus === "idle" && (lastSyncedAt ? t('editor.synced') : t('editor.sync'))}
      </span>
    </button>
  );
}
