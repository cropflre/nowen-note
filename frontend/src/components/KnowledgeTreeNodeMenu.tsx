import { useEffect, useMemo, useState, type RefObject } from "react";
import {
  Download,
  FileCode,
  FilePlus,
  FileText,
  FileType2,
  FolderInput,
  FolderPlus,
  Image as ImageIcon,
  Link2,
  Lock,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Printer,
  ShieldCheck,
  SplitSquareHorizontal,
  SplitSquareVertical,
  Star,
  StarOff,
  Trash2,
  Unlock,
  Upload,
} from "lucide-react";

import ContextMenu, { type ContextMenuItem } from "@/components/ContextMenu";
import EmojiIconPicker from "@/components/EmojiPicker";
import NotebookShareDialog from "@/components/NotebookShareDialog";
import { prompt as appPrompt } from "@/components/ui/confirm";
import type { ContextMenuState } from "@/hooks/useContextMenu";
import { api } from "@/lib/api";
import {
  exportNotebook,
  exportSingleNote,
  exportSingleNoteAsPDF,
  exportNoteAsImage,
} from "@/lib/exportService";
import type { KnowledgeTreeInlineCreateKind } from "@/lib/knowledgeTreeInlineCreate";
import type { KnowledgeTreeNode } from "@/lib/knowledgeTreeApi";
import { knowledgeTreeApi } from "@/lib/knowledgeTreeApi";
import { toast } from "@/lib/toast";
import { useApp, useAppActions } from "@/store/AppContext";
import type { Notebook } from "@/types";

type LoadedNote = Awaited<ReturnType<typeof api.getNote>>;

export interface KnowledgeTreeNodeMenuProps {
  menu: ContextMenuState;
  menuRef: RefObject<HTMLDivElement | null>;
  node: KnowledgeTreeNode | null;
  nodes: KnowledgeTreeNode[];
  onClose: () => void;
  onOpen: (node: KnowledgeTreeNode) => void | Promise<void>;
  onSplit: (node: KnowledgeTreeNode, direction: "right" | "down") => void;
  onCreate: (node: KnowledgeTreeNode, kind: KnowledgeTreeInlineCreateKind) => void;
  onRename: (node: KnowledgeTreeNode) => void | Promise<void>;
  onMove: (node: KnowledgeTreeNode) => void;
  onPermissions: (node: KnowledgeTreeNode) => void;
  onDelete: (node: KnowledgeTreeNode) => void | Promise<void>;
  onReload: () => void | Promise<void>;
}

function separator(id: string): ContextMenuItem {
  return { id, label: "", separator: true };
}

function exportChildren(): ContextMenuItem[] {
  return [
    { id: "export_note_md", label: "Markdown", icon: <Download size={14} /> },
    { id: "export_note_pdf", label: "PDF", icon: <Printer size={14} /> },
    { id: "export_note_png", label: "PNG", icon: <ImageIcon size={14} /> },
    { id: "export_note_jpg", label: "JPG", icon: <ImageIcon size={14} /> },
    { id: "export_note_word", label: "Word", icon: <FileType2 size={14} /> },
  ];
}

function createChildren(): ContextMenuItem[] {
  return [
    { id: "new_note", label: "文档", icon: <FilePlus size={14} /> },
    { id: "new_markdown", label: "Markdown 文档", icon: <FileCode size={14} /> },
    { id: "new_folder", label: "文件夹", icon: <FolderPlus size={14} /> },
  ];
}

function importChildren(): ContextMenuItem[] {
  return [
    { id: "import_word", label: "Word 文档", icon: <FileType2 size={14} /> },
    { id: "import_url", label: "公众号文章", icon: <Link2 size={14} /> },
  ];
}

/** Shared by right-click, mobile long-press and the row's More button. */
export function buildKnowledgeTreeNodeMenuItems(
  node: KnowledgeTreeNode,
  note: LoadedNote | null,
): ContextMenuItem[] {
  const items: ContextMenuItem[] = [];
  const capabilities = node.access.capabilities;
  const isDocument = node.resourceType === "note";
  const isNotebook = node.resourceType === "notebook";
  const isOwned = !node.sharedRootId;

  if (isDocument) {
    items.push(
      { id: "open", label: "打开", icon: <FileText size={14} /> },
      { id: "split_right", label: "在右侧分屏打开", icon: <SplitSquareHorizontal size={14} /> },
      { id: "split_down", label: "在下方分屏打开", icon: <SplitSquareVertical size={14} /> },
    );
  }

  if (capabilities.canCreate) {
    if (items.length) items.push(separator("sep-create"));
    items.push(
      { id: "create", label: "新建", icon: <Plus size={14} />, children: createChildren() },
      { id: "import", label: "导入", icon: <Upload size={14} />, children: importChildren() },
    );
  }

  if (isDocument && isOwned && capabilities.canEdit) {
    items.push(separator("sep-note-flags"));
    items.push(
      {
        id: "toggle_pin",
        label: note?.isPinned === 1 ? "取消置顶" : "置顶",
        icon: note?.isPinned === 1 ? <PinOff size={14} /> : <Pin size={14} />,
        disabled: !note,
      },
      {
        id: "toggle_favorite",
        label: note?.isFavorite === 1 ? "取消收藏" : "收藏",
        icon: note?.isFavorite === 1 ? <StarOff size={14} /> : <Star size={14} />,
        disabled: !note,
      },
      {
        id: "toggle_lock",
        label: note?.isLocked === 1 ? "解锁" : "锁定",
        icon: note?.isLocked === 1 ? <Unlock size={14} /> : <Lock size={14} />,
        disabled: !note,
      },
    );
  }

  const management: ContextMenuItem[] = [];
  if (isNotebook && capabilities.canEdit) {
    management.push({ id: "change_icon", label: "修改图标", icon: <MoreHorizontal size={14} /> });
  }
  if (capabilities.canEdit) management.push({ id: "rename", label: "重命名", icon: <Pencil size={14} /> });
  if (isNotebook && (capabilities.canReshare || capabilities.canManageMembers)) {
    management.push({ id: "share", label: "分享与发布", icon: <Link2 size={14} /> });
  }
  if (capabilities.canMove && !node.sharedRootId) {
    management.push({ id: "move", label: "移动", icon: <FolderInput size={14} /> });
  }
  if (capabilities.canManageMembers) {
    management.push({ id: "permissions", label: "成员与权限", icon: <ShieldCheck size={14} /> });
  }
  if (management.length) {
    if (items.length) items.push(separator("sep-manage"));
    items.push(...management);
  }

  if (capabilities.canDownload) {
    if (items.length) items.push(separator("sep-export"));
    if (isNotebook) {
      items.push({ id: "export_folder", label: "导出目录为 Markdown", icon: <Download size={14} /> });
    } else if (isDocument) {
      items.push({ id: "export_note", label: "导出", icon: <Download size={14} />, children: exportChildren() });
    }
  }

  if (capabilities.canDelete) {
    if (items.length) items.push(separator("sep-delete"));
    items.push({
      id: "delete",
      label: "移到回收站",
      icon: <Trash2 size={14} />,
      danger: true,
      disabled: isDocument && (!note || note.isLocked === 1),
    });
  }

  return items;
}

function descendantNotebookResources(node: KnowledgeTreeNode, nodes: KnowledgeTreeNode[]) {
  const children = new Map<string, KnowledgeTreeNode[]>();
  for (const candidate of nodes) {
    if (!candidate.parentId) continue;
    const list = children.get(candidate.parentId) || [];
    list.push(candidate);
    children.set(candidate.parentId, list);
  }
  const ids = new Set<string>();
  const names = new Set<string>();
  const stack = [node];
  const visited = new Set<string>();
  while (stack.length) {
    const current = stack.pop()!;
    if (visited.has(current.id)) continue;
    visited.add(current.id);
    if (current.resourceType === "notebook") {
      ids.add(current.resourceId);
      names.add(current.title);
    }
    for (const child of children.get(current.id) || []) stack.push(child);
  }
  return { ids, names };
}

export default function KnowledgeTreeNodeMenu({
  menu,
  menuRef,
  node,
  nodes,
  onClose,
  onOpen,
  onSplit,
  onCreate,
  onRename,
  onMove,
  onPermissions,
  onDelete,
  onReload,
}: KnowledgeTreeNodeMenuProps) {
  const { state } = useApp();
  const actions = useAppActions();
  const [note, setNote] = useState<LoadedNote | null>(null);
  const [shareNotebook, setShareNotebook] = useState<Notebook | null>(null);
  const [iconPicker, setIconPicker] = useState<{ notebook: Notebook; top: number; left: number } | null>(null);

  useEffect(() => {
    if (!menu.isOpen || node?.resourceType !== "note") {
      setNote(null);
      return;
    }
    let cancelled = false;
    api.getNote(node.resourceId)
      .then((value) => { if (!cancelled) setNote(value); })
      .catch(() => { if (!cancelled) setNote(null); });
    return () => { cancelled = true; };
  }, [menu.isOpen, node?.id, node?.resourceId, node?.resourceType]);

  const items = useMemo(
    () => node ? buildKnowledgeTreeNodeMenuItems(node, note) : [],
    [node, note],
  );

  const openLoadedNote = (value: LoadedNote) => {
    actions.setActiveNote(value);
    actions.setSelectedNotebook(value.notebookId);
    actions.setSelectedTag(null);
    actions.setViewMode("notebook");
    actions.openNoteTab({
      id: value.id,
      title: value.title,
      notebookId: value.notebookId,
      workspaceId: value.workspaceId,
      contentFormat: value.contentFormat,
      isLocked: value.isLocked,
      isTrashed: value.isTrashed,
      updatedAt: value.updatedAt,
    });
    actions.setMobileView("editor");
    actions.setMobileSidebar(false);
  };

  const resolvePhysicalNotebookId = async (parent: KnowledgeTreeNode): Promise<string> => {
    let cursor: KnowledgeTreeNode | undefined = parent;
    const byId = new Map(nodes.map((candidate) => [candidate.id, candidate]));
    const visited = new Set<string>();
    while (cursor && !visited.has(cursor.id)) {
      visited.add(cursor.id);
      if (cursor.resourceType === "notebook") return cursor.resourceId;
      cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
    }
    if (parent.resourceType === "note") {
      return (await api.getNote(parent.resourceId)).notebookId;
    }
    throw new Error("找不到可用于导入的物理目录");
  };

  const importWord = async () => {
    if (!node) return;
    const notebookId = await resolvePhysicalNotebookId(node);
    const { pickDocxFile, importDocxAsNote } = await import("@/lib/wordNoteService");
    const file = await pickDocxFile();
    if (!file) return;
    const toastId = toast.info("正在导入 Word 文档…", 0);
    try {
      const { note: imported } = await importDocxAsNote({ notebookId, file });
      if (node.id !== `notebook:${notebookId}`) {
        await knowledgeTreeApi.move(`note:${imported.id}`, { parentId: node.id });
      }
      toast.dismiss(toastId);
      toast.success("导入成功");
      openLoadedNote(imported as LoadedNote);
      await onReload();
      actions.refreshNotes();
      actions.refreshNotebooks();
    } catch (error: any) {
      toast.dismiss(toastId);
      throw error;
    }
  };

  const importUrl = async () => {
    if (!node) return;
    const raw = await appPrompt({
      title: "导入公众号文章",
      description: "请输入微信公众号文章链接",
      placeholder: "https://mp.weixin.qq.com/s/...",
      confirmText: "导入",
      validate: (value) => {
        const url = value.trim();
        if (!url) return "请输入文章链接";
        return /^https:\/\/mp\.weixin\.qq\.com\/s[\/?]/.test(url) ? null : "暂只支持微信公众号文章链接";
      },
    });
    if (raw == null) return;
    const notebookId = await resolvePhysicalNotebookId(node);
    const toastId = toast.info("正在导入文章…", 0);
    try {
      const result = await api.urlImport(raw.trim(), notebookId);
      if (node.id !== `notebook:${notebookId}`) {
        await knowledgeTreeApi.move(`note:${result.noteId}`, { parentId: node.id });
      }
      const imported = await api.getNote(result.noteId);
      toast.dismiss(toastId);
      toast.success(`已导入：${result.title}`);
      openLoadedNote(imported);
      await onReload();
      actions.refreshNotes();
      actions.refreshNotebooks();
    } catch (error: any) {
      toast.dismiss(toastId);
      throw error;
    }
  };

  const getNotebook = async (): Promise<Notebook> => {
    if (!node || node.resourceType !== "notebook") throw new Error("该节点不是目录");
    const cached = state.notebooks.find((candidate) => candidate.id === node.resourceId);
    if (cached) return cached;
    const rows = await api.getNotebooks();
    const found = rows.find((candidate) => candidate.id === node.resourceId);
    if (!found) throw new Error("目录资源不存在");
    return found;
  };

  const patchNote = async (patch: Partial<LoadedNote>) => {
    if (!node || node.resourceType !== "note") return;
    const current = note || await api.getNote(node.resourceId);
    await api.updateNote(current.id, patch as any);
    const next = { ...current, ...patch } as LoadedNote;
    setNote(next);
    actions.updateNoteInList({ id: current.id, ...patch } as any);
    if (patch.isLocked !== undefined) actions.updateNoteTab({ id: current.id, isLocked: patch.isLocked });
    if (state.activeNote?.id === current.id) actions.setActiveNote({ ...state.activeNote, ...patch } as any);
    actions.refreshNotes();
  };

  const exportFolder = async () => {
    if (!node || node.resourceType !== "notebook") return;
    const { ids, names } = descendantNotebookResources(node, nodes);
    const toastId = toast.info(`正在导出“${node.title}”…`, 0);
    try {
      const ok = await exportNotebook({
        notebookId: node.resourceId,
        notebookName: node.title,
        descendantNotebookIds: ids,
        descendantNotebookNames: names,
      });
      toast.dismiss(toastId);
      ok ? toast.success("导出完成") : toast.error("导出失败");
    } catch (error: any) {
      toast.dismiss(toastId);
      throw error;
    }
  };

  const exportNote = async (actionId: string) => {
    if (!node || node.resourceType !== "note") return;
    const noteId = node.resourceId;
    const toastId = toast.info(`正在导出“${node.title}”…`, 0);
    try {
      if (actionId === "export_note_md") {
        const ok = await exportSingleNote(noteId);
        if (!ok) throw new Error("导出失败");
      } else if (actionId === "export_note_pdf") {
        const result = await exportSingleNoteAsPDF(noteId);
        if (!result.ok && result.mode !== "canceled") throw new Error((result as { error?: string }).error || "导出失败");
      } else if (actionId === "export_note_png" || actionId === "export_note_jpg") {
        const fresh = await api.getNote(noteId);
        const ok = await exportNoteAsImage({
          id: fresh.id,
          title: fresh.title,
          content: fresh.content,
          contentText: fresh.contentText,
          contentFormat: fresh.contentFormat,
          updatedAt: fresh.updatedAt,
        }, { format: actionId.endsWith("png") ? "png" : "jpg" });
        if (!ok) throw new Error("导出失败");
      } else if (actionId === "export_note_word") {
        const fresh = await api.getNote(noteId);
        const { exportNoteAsDocx, downloadDocxBlob } = await import("@/lib/wordNoteService");
        const blob = await exportNoteAsDocx(fresh.content || "", fresh.title || "未命名笔记");
        await downloadDocxBlob(blob, fresh.title || "未命名笔记");
      }
      toast.dismiss(toastId);
      toast.success("导出完成");
    } catch (error) {
      toast.dismiss(toastId);
      throw error;
    }
  };

  const handleAction = async (actionId: string) => {
    if (actionId === "__context_menu_internal_close") {
      onClose();
      return;
    }
    if (!node) return;
    onClose();
    try {
      switch (actionId) {
        case "open": await onOpen(node); break;
        case "split_right": onSplit(node, "right"); break;
        case "split_down": onSplit(node, "down"); break;
        case "new_note": onCreate(node, "note"); break;
        case "new_markdown": onCreate(node, "markdown"); break;
        case "new_folder": onCreate(node, "folder"); break;
        case "import_word": await importWord(); break;
        case "import_url": await importUrl(); break;
        case "toggle_pin": await patchNote({ isPinned: note?.isPinned === 1 ? 0 : 1 }); break;
        case "toggle_favorite": await patchNote({ isFavorite: note?.isFavorite === 1 ? 0 : 1 }); break;
        case "toggle_lock": await patchNote({ isLocked: note?.isLocked === 1 ? 0 : 1 }); break;
        case "rename": await onRename(node); break;
        case "move": onMove(node); break;
        case "permissions": onPermissions(node); break;
        case "delete": await onDelete(node); break;
        case "share": setShareNotebook(await getNotebook()); break;
        case "change_icon": {
          const notebook = await getNotebook();
          setIconPicker({ notebook, top: menu.y, left: menu.x });
          break;
        }
        case "export_folder": await exportFolder(); break;
        default:
          if (actionId.startsWith("export_note_")) await exportNote(actionId);
          break;
      }
    } catch (error: any) {
      console.error("Knowledge tree context menu action failed:", error);
      toast.error(error?.message || "操作失败");
      actions.refreshNotes();
      actions.refreshNotebooks();
    }
  };

  return (
    <>
      <ContextMenu
        isOpen={menu.isOpen && !!node}
        x={menu.x}
        y={menu.y}
        items={items}
        menuRef={menuRef}
        onAction={(actionId) => { void handleAction(actionId); }}
        header={node?.title}
      />
      {shareNotebook && <NotebookShareDialog notebook={shareNotebook} onClose={() => setShareNotebook(null)} />}
      {iconPicker && (
        <EmojiIconPicker
          currentIcon={iconPicker.notebook.icon || "📁"}
          position={{ top: iconPicker.top, left: iconPicker.left }}
          onClose={() => setIconPicker(null)}
          onSelect={(emoji) => {
            void (async () => {
              try {
                await api.updateNotebook(iconPicker.notebook.id, { icon: emoji });
                actions.updateNotebook({ id: iconPicker.notebook.id, icon: emoji });
                setIconPicker(null);
                await onReload();
                toast.success("图标已更新");
              } catch (error: any) {
                toast.error(error?.message || "修改图标失败");
              }
            })();
          }}
        />
      )}
    </>
  );
}
