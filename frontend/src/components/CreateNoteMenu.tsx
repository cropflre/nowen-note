import { useEffect, useState } from "react";
import { KnowledgeTreeCreateDropdown } from "@/components/KnowledgeTreeCreateDropdown";
import NoteTemplatePickerDialog from "@/components/NoteTemplatePickerDialog";
import EncryptedNoteCreateDialog from "@/components/EncryptedNoteCreateDialog";
import {
  importMarkdownIntoKnowledgeTree,
  importMarkdownZipIntoKnowledgeTree,
  importWordIntoKnowledgeTree,
  importWeChatArticleIntoKnowledgeTree,
} from "@/components/knowledgeTreeImport";
import { prompt } from "@/components/ui/confirm";
import { api, getCurrentWorkspace } from "@/lib/api";
import { knowledgeTreeApi, type KnowledgeTreeNode } from "@/lib/knowledgeTreeApi";
import { defaultInlineCreateTitle, type KnowledgeTreeInlineCreateKind } from "@/lib/knowledgeTreeInlineCreate";
import { isFolderUnlocked, loadUnlockedFolderIds } from "@/lib/knowledgeTreePassword";
import { revealCreatedKnowledgeTreeNote } from "@/lib/knowledgeTreeCreateVisibility";
import { emitKnowledgeTreeRefresh } from "@/lib/workspaceRefreshBridge";
import { isRootDocumentNotebookId } from "@/lib/rootDocumentCreatePolicy";
import { markNewNoteForImmediateEdit } from "@/lib/newNoteImmediateEdit";
import { cancelNewNoteTitleFocus, requestNewNoteTitleFocus } from "@/lib/noteTitleFocus";
import { pushMindMapAppPath } from "@/lib/mindMapDeepLink";
import { pushSheetAppPath } from "@/lib/sheetDeepLink";
import { noteTemplatesApi } from "@/lib/noteTemplatesApi";
import { pluginApi } from "@/lib/pluginApi";
import { isMobileLocalMode } from "@/lib/mobileLocalMode";
import { toast } from "@/lib/toast";
import { useApp, useAppActions } from "@/store/AppContext";

export type NoteType = "normal" | "markdown" | "word";

export interface CreateNoteMenuProps {
  open: boolean;
  parentId?: string | null;
  onPick: (type: NoteType) => void | Promise<void>;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement | null>;
}

/** 列表入口复用目录树菜单；侧栏收起时也能创建和导入。 */
export default function CreateNoteMenu({ open, parentId, onPick, onClose, anchorRef }: CreateNoteMenuProps) {
  const { state } = useApp();
  const actions = useAppActions();
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const [templateParent, setTemplateParent] = useState<{ parentId: string | null } | null>(null);
  const [encryptedParent, setEncryptedParent] = useState<{ parentId: string | null } | null>(null);

  useEffect(() => {
    setAnchor(open ? anchorRef.current?.getBoundingClientRect() || null : null);
  }, [open, anchorRef]);

  async function resolveTarget() {
    const [owned, shared] = await Promise.allSettled([knowledgeTreeApi.list(), knowledgeTreeApi.listShared()]);
    if (owned.status === "rejected") throw owned.reason;
    const nodes = [...owned.value.nodes, ...(shared.status === "fulfilled" ? shared.value.nodes : [])];
    const parent = parentId !== undefined
      ? nodes.find((node) => node.id === parentId) || null
      : nodes.find((node) => node.resourceType === "notebook" && node.resourceId === state.selectedNotebookId) || null;
    const expectsParent = parentId !== undefined
      ? parentId !== null
      : !!state.selectedNotebookId && !isRootDocumentNotebookId(state.selectedNotebookId);
    if (expectsParent && !parent) throw new Error("目标目录不存在，请刷新后重试");
    if (parent && !parent.access.capabilities.canCreate) throw new Error("没有在此处新建内容的权限");
    if (parent && !isFolderUnlocked(parent, loadUnlockedFolderIds())) throw new Error("请先在目录树中解锁目录后重试");
    return { parent, nodes, fallbackNotebookId: state.selectedNotebookId || state.notebooks[0]?.id || null };
  }

  function refresh(targetParentId: string | null, nodeId?: string) {
    revealCreatedKnowledgeTreeNote(targetParentId, nodeId);
    emitKnowledgeTreeRefresh("content-created-from-note-list");
    actions.refreshNotes();
    actions.refreshNotebooks();
  }

  async function activateNote(note: Awaited<ReturnType<typeof api.getNote>>, newlyCreated = false) {
    if (newlyCreated) {
      if (state.viewMode === "favorites") {
        try { note = await api.updateNote(note.id, { isFavorite: 1 } as any); } catch { /* 收藏失败不阻断打开。 */ }
      }
      markNewNoteForImmediateEdit(note.id);
    }
    actions.setActiveNote(note);
    actions.addNoteToList(note);
    actions.setMobileView("editor");
  }

  async function create(kind: KnowledgeTreeInlineCreateKind) {
    onClose();
    const focusRequestId = kind === "note" || kind === "markdown" ? requestNewNoteTitleFocus() : null;
    try {
      if (isMobileLocalMode() && (kind === "note" || kind === "markdown")) {
        await onPick(kind === "note" ? "normal" : "markdown");
        return;
      }
      const target = await resolveTarget();
      let title = defaultInlineCreateTitle(kind);
      if (kind === "folder" || kind === "mindmap" || kind === "sheet") {
        const entered = await prompt({ title: "新建", defaultValue: title, confirmText: "创建" });
        if (!entered?.trim()) return;
        title = entered.trim();
      }
      const targetParentId = target.parent?.id ?? null;
      const node = await knowledgeTreeApi.create({ parentId: targetParentId, nodeType: kind, title });
      refresh(targetParentId, node.id);
      if (kind === "folder") toast.success("已创建文件夹");
      else if (kind === "mindmap") pushMindMapAppPath(node.resourceId);
      else if (kind === "sheet") pushSheetAppPath(node.resourceId);
      else await activateNote(await api.getNote(node.resourceId), true);
    } catch (error: any) {
      if (focusRequestId !== null) cancelNewNoteTitleFocus(focusRequestId);
      toast.error(error?.message || "创建失败，请重试");
    }
  }

  async function importContent(kind: "markdown" | "markdown-zip" | "word" | "wechat") {
    onClose();
    try {
      const target = await resolveTarget();
      const importer = kind === "markdown" ? importMarkdownIntoKnowledgeTree
        : kind === "markdown-zip" ? importMarkdownZipIntoKnowledgeTree
          : kind === "word" ? importWordIntoKnowledgeTree : importWeChatArticleIntoKnowledgeTree;
      const note = await importer(target);
      if (!note) return;
      refresh(target.parent?.id ?? null);
      await activateNote(note);
    } catch (error: any) {
      toast.error(error?.message || "导入失败，请重试");
    }
  }

  async function openDialog(kind: "template" | "encrypted") {
    onClose();
    try {
      const target = await resolveTarget();
      const selection = { parentId: target.parent?.id ?? null };
      if (kind === "template") setTemplateParent(selection);
      else setEncryptedParent(selection);
    } catch (error: any) {
      toast.error(error?.message || "无法在此处新建内容");
    }
  }

  async function openTemplateNote(result: { noteId: string; node: KnowledgeTreeNode }) {
    refresh(templateParent!.parentId, result.node.id);
    await activateNote(await api.getNote(result.noteId), true);
  }

  return <>
    <KnowledgeTreeCreateDropdown
      menu={open && anchor ? { parentId: parentId ?? null, anchor } : null}
      onClose={onClose}
      onCreate={(_parentId, kind) => { void create(kind); }}
      onCreateFromTemplate={() => { void openDialog("template"); }}
      onCreateEncrypted={() => { void openDialog("encrypted"); }}
      onImport={(_parentId, kind) => { void importContent(kind); }}
    />
    <NoteTemplatePickerDialog
      open={Boolean(templateParent)} onClose={() => setTemplateParent(null)}
      onCreate={async (templateId) => { await openTemplateNote(await noteTemplatesApi.createNote(templateId, templateParent!.parentId)); }}
      onCreatePlugin={async (pluginId, templateId, values) => {
        const result = await pluginApi.createNoteFromTemplate(pluginId, templateId, { workspaceId: getCurrentWorkspace(), parentId: templateParent!.parentId, values });
        await openTemplateNote({ noteId: result.noteId, node: result.node as KnowledgeTreeNode });
      }}
    />
    {encryptedParent && <EncryptedNoteCreateDialog parentId={encryptedParent.parentId} onClose={() => setEncryptedParent(null)} />}
  </>;
}
