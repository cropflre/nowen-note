import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Download,
  FileType2,
  FolderInput,
  Image as ImageIcon,
  Pencil,
  Printer,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useApp, useAppActions } from "@/store/AppContext";
import { getLatestContextMenuState } from "@/hooks/useContextMenu";
import { api } from "@/lib/api";
import { exportSingleNote, exportSingleNoteAsImage, exportSingleNoteAsPDF } from "@/lib/exportService";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { Notebook } from "@/types";
import { useTranslation } from "react-i18next";
import RenameContextNoteModal from "@/components/RenameContextNoteModal";

export interface ContextMenuItem {
  id: string;
  label: string;
  icon?: React.ReactNode;
  danger?: boolean;
  disabled?: boolean;
  separator?: boolean;
  /** 子菜单项，hover/click 后展开二级菜单 */
  children?: ContextMenuItem[];
}

interface ContextMenuProps {
  isOpen: boolean;
  x: number;
  y: number;
  items: ContextMenuItem[];
  menuRef: React.RefObject<HTMLDivElement | null>;
  onAction: (actionId: string) => void;
  header?: string;
}

function buildNotebookTree(notebooks: Notebook[]): Notebook[] {
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
  const sortRecursive = (list: Notebook[]) => {
    list.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
    list.forEach((nb) => {
      if (nb.children?.length) sortRecursive(nb.children);
    });
  };
  sortRecursive(roots);
  return roots;
}

function NotebookTargetItem({
  notebook,
  depth,
  selectedId,
  currentNotebookId,
  onSelect,
}: {
  notebook: Notebook;
  depth: number;
  selectedId: string | null;
  currentNotebookId: string;
  onSelect: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(true);
  const hasChildren = !!notebook.children?.length;
  const isCurrent = notebook.id === currentNotebookId;
  const isSelected = notebook.id === selectedId;

  return (
    <div>
      <button
        type="button"
        disabled={isCurrent}
        onClick={() => !isCurrent && onSelect(notebook.id)}
        className={cn(
          "w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm transition-colors",
          isCurrent
            ? "opacity-40 cursor-not-allowed text-tx-tertiary"
            : isSelected
            ? "bg-accent-primary/10 text-accent-primary"
            : "text-tx-secondary hover:bg-app-hover hover:text-tx-primary",
        )}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
      >
        {hasChildren ? (
          <span
            onClick={(e) => {
              e.stopPropagation();
              setExpanded((v) => !v);
            }}
            className="w-4 h-4 flex items-center justify-center shrink-0 cursor-pointer"
          >
            {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </span>
        ) : (
          <span className="w-4 h-4 shrink-0" />
        )}
        <span className="text-base shrink-0">{notebook.icon || "📒"}</span>
        <span className="truncate flex-1 text-left">{notebook.name}</span>
        {isCurrent && <span className="text-[10px] text-tx-tertiary shrink-0">{t("common.current")}</span>}
        {isSelected && <Check size={14} className="text-accent-primary shrink-0" />}
      </button>
      {hasChildren && expanded && notebook.children!.map((child) => (
        <NotebookTargetItem
          key={child.id}
          notebook={child}
          depth={depth + 1}
          selectedId={selectedId}
          currentNotebookId={currentNotebookId}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

function MoveContextNoteModal({
  noteId,
  onClose,
}: {
  noteId: string | null;
  onClose: () => void;
}) {
  const { state } = useApp();
  const actions = useAppActions();
  const { t } = useTranslation();
  const [note, setNote] = useState<any | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [moving, setMoving] = useState(false);

  useEffect(() => {
    if (!noteId) {
      setNote(null);
      setSelectedId(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setSelectedId(null);
    api.getNote(noteId)
      .then((fresh) => {
        if (!cancelled) setNote(fresh);
      })
      .catch((err: any) => {
        if (!cancelled) {
          console.error("Failed to load note before move:", err);
          toast.error(err?.message || t("noteList.loadFailed") || "加载笔记失败");
          onClose();
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [noteId, onClose, t]);

  useEffect(() => {
    if (!noteId) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [noteId, onClose]);

  if (!noteId) return null;

  const sourceWorkspaceId = note?.workspaceId || null;
  const notebooks = note
    ? state.notebooks.filter((nb) => (nb.workspaceId || null) === sourceWorkspaceId)
    : [];
  const tree = buildNotebookTree(notebooks);
  const canMove = !!note && !!selectedId && selectedId !== note.notebookId && !moving;

  const handleMove = async () => {
    if (!note || !selectedId || selectedId === note.notebookId || moving) return;
    if (note.isLocked === 1) {
      toast.warning(t("common.noteLockedCannotEdit") || t("editor.lockedBanner") || "笔记已锁定");
      return;
    }
    setMoving(true);
    try {
      await api.updateNote(note.id, { notebookId: selectedId } as any);
      actions.updateNoteInList({ id: note.id, notebookId: selectedId });
      if (state.activeNote?.id === note.id) {
        actions.setActiveNote({ ...state.activeNote, notebookId: selectedId } as any);
        actions.setSelectedNotebook(selectedId);
      }
      actions.refreshNotebooks();
      actions.refreshNotes();
      onClose();
    } catch (err: any) {
      console.error("Failed to move note:", err);
      toast.error(err?.message || t("noteList.bulkMoveFailed", { error: "" }) || "移动笔记失败");
      actions.refreshNotebooks();
      actions.refreshNotes();
    } finally {
      setMoving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={moving ? undefined : onClose} />
      <div
        className="relative w-full max-w-[360px] mx-4 max-h-[80vh] bg-app-elevated border border-app-border rounded-xl shadow-2xl flex flex-col overflow-hidden"
        style={{ animation: "contextMenuIn 0.15s ease-out" }}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-app-border">
          <div className="flex items-center gap-2 min-w-0">
            <FolderInput size={16} className="text-accent-primary shrink-0" />
            <span className="text-sm font-medium text-tx-primary truncate">{t("noteList.moveNote")}</span>
          </div>
          <button
            type="button"
            disabled={moving}
            onClick={onClose}
            className="p-1 rounded-md hover:bg-app-hover text-tx-tertiary disabled:opacity-40"
          >
            <X size={16} />
          </button>
        </div>
        <div className="px-4 py-2 text-xs text-tx-tertiary truncate border-b border-app-border">
          {loading ? t("common.loading") : (note?.title || t("common.untitledNote") || "无标题笔记")}
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain">
          <div className="p-2">
            {tree.map((nb) => (
              <NotebookTargetItem
                key={nb.id}
                notebook={nb}
                depth={0}
                selectedId={selectedId}
                currentNotebookId={note?.notebookId || ""}
                onSelect={setSelectedId}
              />
            ))}
            {!loading && tree.length === 0 && (
              <p className="text-xs text-tx-tertiary text-center py-4">{t("noteList.noNotebooks")}</p>
            )}
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-app-border">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={moving}>{t("common.cancel")}</Button>
          <Button
            size="sm"
            disabled={!canMove}
            onClick={handleMove}
            className="bg-accent-primary text-white hover:bg-accent-primary/90 disabled:opacity-40"
          >
            {moving ? t("common.loading") : t("noteList.moveButton")}
          </Button>
        </div>
      </div>
    </div>
  );
}

export default function ContextMenu({
  isOpen, x, y, items, menuRef, onAction, header,
}: ContextMenuProps) {
  const internalRef = useRef<HTMLDivElement | null>(null);
  const [adjustedPos, setAdjustedPos] = useState({ x, y });
  const [moveNoteId, setMoveNoteId] = useState<string | null>(null);
  const [renameNoteId, setRenameNoteId] = useState<string | null>(null);
  const [submenuParentId, setSubmenuParentId] = useState<string | null>(null);
  const submenuCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { t, i18n } = useTranslation();

  const latestMenu = getLatestContextMenuState();
  const targetId = latestMenu.targetId;
  const isNoteMenu = isOpen && latestMenu.targetType === "note" && !!targetId;
  const isTrashNoteMenu = items.some((item) => item.id === "restore" || item.id === "delete_permanent");
  // 批量菜单没有“打开”这一单篇操作。树形笔记菜单虽然同样包含 toggle_pin，
  // 但它有 open；不能再仅凭 toggle_pin + 缺少 export_submenu 将其误判为批量菜单。
  const isBulkNoteMenu =
    !items.some((item) => item.id === "open") &&
    items.some((item) => item.id === "toggle_pin") &&
    !items.some((item) => item.id === "export_submenu");
  const isInlineNotebookTreeNoteMenu =
    isNoteMenu &&
    items.some((item) => item.id === "open") &&
    items.some((item) => item.id === "trash") &&
    !items.some((item) => item.id === "move") &&
    !items.some((item) => item.id === "export_md");

  const isZh = (i18n.resolvedLanguage || i18n.language || "").toLowerCase().startsWith("zh");
  const renameLabel = isZh ? "重命名" : "Rename";

  const displayItems = useMemo(() => {
    let nextItems = items;

    if (isInlineNotebookTreeNoteMenu) {
      const beforeTrash = items.filter((item) => item.id !== "trash");
      const trash = items.find((item) => item.id === "trash");
      const isLocked = !!trash?.disabled;
      nextItems = [
        ...beforeTrash,
        {
          id: "move",
          label: t("noteList.moveTo") || "移动到...",
          icon: <FolderInput size={14} />,
          disabled: isLocked,
        },
        {
          id: "export_submenu",
          label: t("noteList.export") || "导出...",
          icon: <Download size={14} />,
          children: [
            { id: "export_md", label: t("noteList.exportAsMarkdown") || "Markdown", icon: <Download size={14} /> },
            { id: "export_pdf", label: t("noteList.exportAsPDF") || "PDF", icon: <Printer size={14} /> },
            { id: "export_png", label: t("note.exportAsPng") || "PNG", icon: <ImageIcon size={14} /> },
            { id: "export_jpg", label: t("note.exportAsJpg") || "JPG", icon: <ImageIcon size={14} /> },
            { id: "export_word", label: t("noteList.exportAsWord") || "Word", icon: <FileType2 size={14} /> },
          ],
        },
        { id: "sep_context_note_exports", label: "", separator: true },
        ...(trash ? [trash] : []),
      ] as ContextMenuItem[];
    }

    const shouldOfferRename =
      isNoteMenu &&
      !isTrashNoteMenu &&
      !isBulkNoteMenu &&
      !nextItems.some((item) => item.id === "rename_note");

    if (!shouldOfferRename) return nextItems;

    const lockSource = nextItems.find((item) => item.id === "trash" || item.id === "move");
    const renameItem: ContextMenuItem = {
      id: "rename_note",
      label: renameLabel,
      icon: <Pencil size={14} />,
      disabled: !!lockSource?.disabled,
    };

    const openIndex = nextItems.findIndex((item) => item.id === "open");
    if (openIndex >= 0) {
      return [
        ...nextItems.slice(0, openIndex + 1),
        renameItem,
        ...nextItems.slice(openIndex + 1),
      ];
    }

    return [
      renameItem,
      { id: "sep_context_note_rename", label: "", separator: true },
      ...nextItems,
    ];
  }, [
    isBulkNoteMenu,
    isInlineNotebookTreeNoteMenu,
    isNoteMenu,
    isTrashNoteMenu,
    items,
    renameLabel,
    t,
  ]);

  useEffect(() => {
    if (!isOpen || !menuRef || !("current" in menuRef)) return;
    const externalRef = menuRef as React.MutableRefObject<HTMLDivElement | null>;
    externalRef.current = internalRef.current;
    return () => {
      if (externalRef.current === internalRef.current) {
        externalRef.current = null;
      }
    };
  }, [isOpen, menuRef]);

  useEffect(() => {
    if (!isOpen) return;
    requestAnimationFrame(() => {
      const el = internalRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let newX = x;
      let newY = y;
      if (newX + rect.width > vw - 8) newX = vw - rect.width - 8;
      if (newY + rect.height > vh - 8) newY = vh - rect.height - 8;
      if (newX < 8) newX = 8;
      if (newY < 8) newY = 8;
      if (newX !== x || newY !== y) setAdjustedPos({ x: newX, y: newY });
    });
  }, [isOpen, x, y, displayItems]);

  useEffect(() => {
    setAdjustedPos({ x, y });
  }, [x, y]);

  useEffect(() => () => {
    if (submenuCloseTimer.current) clearTimeout(submenuCloseTimer.current);
  }, []);

  const closeOwnerMenu = () => onAction("__context_menu_internal_close");

  const handleSpecialInlineNoteAction = async (actionId: string) => {
    const currentTargetId = getLatestContextMenuState().targetId || targetId;

    if (actionId === "rename_note" && isNoteMenu && currentTargetId) {
      setRenameNoteId(currentTargetId);
      closeOwnerMenu();
      return;
    }

    if (!isInlineNotebookTreeNoteMenu || !currentTargetId) {
      onAction(actionId);
      return;
    }

    if (actionId === "move") {
      setMoveNoteId(currentTargetId);
      closeOwnerMenu();
      return;
    }

    if (!actionId.startsWith("export_")) {
      onAction(actionId);
      return;
    }

    closeOwnerMenu();

    if (actionId === "export_md") {
      const toastId = toast.info(t("export.exportingNote", { name: header || t("common.untitledNote") }), 0);
      try {
        const ok = await exportSingleNote(currentTargetId);
        toast.dismiss(toastId);
        ok ? toast.success(t("export.exportComplete")) : toast.error(t("export.exportFailed", { error: "" }));
      } catch (err: any) {
        toast.dismiss(toastId);
        toast.error(err?.message || t("export.exportFailed", { error: String(err) }));
      }
      return;
    }

    if (actionId === "export_pdf") {
      const toastId = toast.info(t("export.exportingNote", { name: header || t("common.untitledNote") }), 0);
      try {
        const res = await exportSingleNoteAsPDF(currentTargetId);
        toast.dismiss(toastId);
        if (res.ok && (res.mode === "desktop" || res.mode === "web")) {
          toast.success(t("export.exportComplete"));
        } else if (!res.ok && res.mode !== "canceled") {
          toast.error(t("export.exportFailed", { error: (res as { error?: string }).error || "" }));
        }
      } catch (err: any) {
        toast.dismiss(toastId);
        toast.error(err?.message || t("export.exportFailed", { error: String(err) }));
      }
      return;
    }

    if (actionId === "export_image") {
      const toastId = toast.info(t("export.exportingNote", { name: header || t("common.untitledNote") }), 0);
      try {
        const ok = await exportSingleNoteAsImage(currentTargetId);
        toast.dismiss(toastId);
        ok ? toast.success(t("export.exportComplete")) : toast.error(t("export.exportFailed", { error: "" }));
      } catch (err: any) {
        toast.dismiss(toastId);
        toast.error(err?.message || t("export.exportFailed", { error: String(err) }));
      }
      return;
    }

    if (actionId === "export_word") {
      const toastId = toast.info(t("export.exportingNote", { name: header || t("common.untitledNote") }), 0);
      try {
        const fresh = await api.getNote(currentTargetId);
        const { exportNoteAsDocx, downloadDocxBlob } = await import("@/lib/wordNoteService");
        const title = fresh.title || t("common.untitledNote") || "未命名笔记";
        const blob = await exportNoteAsDocx(fresh.content || "", title);
        downloadDocxBlob(blob, title);
        toast.dismiss(toastId);
        toast.success(t("export.exportComplete"));
      } catch (err: any) {
        toast.dismiss(toastId);
        toast.error(err?.message || t("export.exportFailed", { error: String(err) }));
      }
      return;
    }

    if (actionId === "export_png" || actionId === "export_jpg") {
      const format: "png" | "jpg" = actionId === "export_png" ? "png" : "jpg";
      const toastId = toast.info(t("note.exportImageExporting") || "导出中...", 0);
      try {
        const fullNote = await api.getNote(currentTargetId);
        const { exportNoteAsImage } = await import("@/lib/exportService");
        const ok = await exportNoteAsImage(
          {
            id: fullNote.id,
            title: fullNote.title,
            content: fullNote.content,
            contentText: fullNote.contentText,
            contentFormat: fullNote.contentFormat,
            updatedAt: fullNote.updatedAt,
          },
          { format },
        );
        toast.dismiss(toastId);
        ok
          ? toast.success(t("note.exportImageSuccess") || "导出成功")
          : toast.error(t("note.exportImageFailed") || "导出失败");
      } catch (err: any) {
        toast.dismiss(toastId);
        toast.error(err?.message || t("note.exportImageFailed") || "导出失败");
      }
      return;
    }

    onAction(actionId);
  };

  return (
    <>
      {isOpen && (
        <div
          ref={internalRef}
          style={{
            position: "fixed",
            top: adjustedPos.y,
            left: adjustedPos.x,
            zIndex: 100,
            animation: "contextMenuIn 0.12s ease-out",
          }}
          className="w-48 backdrop-blur-xl bg-white/90 dark:bg-zinc-900/90 rounded-[12px] shadow-lg shadow-black/[0.08] dark:shadow-black/30 border border-black/[0.06] dark:border-white/[0.08] py-1 select-none"
        >
          {header && (
            <div className="px-3 py-1.5 text-[11px] font-medium text-tx-tertiary border-b border-black/[0.06] dark:border-white/[0.08] mb-0.5 truncate">
              {header}
            </div>
          )}
          {displayItems.map((item) =>
            item.separator ? (
              <div key={item.id} className="h-px bg-black/[0.06] dark:bg-white/[0.08] my-1 mx-2" />
            ) : item.children ? (
              <div
                key={item.id}
                className="relative"
                onMouseEnter={() => {
                  if (submenuCloseTimer.current) clearTimeout(submenuCloseTimer.current);
                  setSubmenuParentId(item.id);
                }}
                onMouseLeave={() => {
                  submenuCloseTimer.current = setTimeout(() => setSubmenuParentId(null), 150);
                }}
              >
                <button
                  type="button"
                  disabled={item.disabled}
                  className={cn(
                    "w-full flex items-center justify-between gap-2 px-3 py-2 text-sm transition-colors duration-150 ease-out",
                    item.disabled && "opacity-40 cursor-not-allowed",
                    submenuParentId === item.id && "bg-black/[0.04] dark:bg-white/[0.06]",
                    "text-zinc-700 dark:text-zinc-300 hover:bg-black/[0.04] dark:hover:bg-white/[0.06] hover:text-tx-primary",
                  )}
                >
                  <span className="flex items-center gap-2">
                    {item.icon && <span className="w-4 h-4 flex items-center justify-center">{item.icon}</span>}
                    {item.label}
                  </span>
                  <ChevronRight size={12} className="text-tx-tertiary" />
                </button>
                {submenuParentId === item.id && (
                  <div
                    className="absolute left-full top-0 ml-1 w-40 backdrop-blur-xl bg-white/90 dark:bg-zinc-900/90 rounded-[12px] shadow-lg shadow-black/[0.08] dark:shadow-black/30 border border-black/[0.06] dark:border-white/[0.08] py-1 z-[101]"
                    onMouseEnter={() => {
                      if (submenuCloseTimer.current) clearTimeout(submenuCloseTimer.current);
                    }}
                    onMouseLeave={() => {
                      submenuCloseTimer.current = setTimeout(() => setSubmenuParentId(null), 150);
                    }}
                  >
                    {item.children.map((child) => (
                      <button
                        key={child.id}
                        type="button"
                        disabled={child.disabled}
                        onMouseDown={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setSubmenuParentId(null);
                          if (!child.disabled) void handleSpecialInlineNoteAction(child.id);
                        }}
                        className={cn(
                          "w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors duration-150 ease-out",
                          child.disabled && "opacity-40 cursor-not-allowed",
                          "text-zinc-700 dark:text-zinc-300 hover:bg-black/[0.04] dark:hover:bg-white/[0.06] hover:text-tx-primary",
                        )}
                      >
                        {child.icon && <span className="w-3.5 h-3.5 flex items-center justify-center">{child.icon}</span>}
                        {child.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <button
                key={item.id}
                disabled={item.disabled}
                onMouseDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  if (!item.disabled) void handleSpecialInlineNoteAction(item.id);
                }}
                className={cn(
                  "w-full flex items-center gap-2 px-3 py-2 text-sm transition-colors duration-150 ease-out",
                  item.disabled && "opacity-40 cursor-not-allowed",
                  item.danger
                    ? "text-red-600 dark:text-red-400 hover:bg-red-50/60 dark:hover:bg-red-900/20"
                    : "text-zinc-700 dark:text-zinc-300 hover:bg-black/[0.04] dark:hover:bg-white/[0.06] hover:text-tx-primary",
                )}
              >
                {item.icon && <span className="w-4 h-4 flex items-center justify-center">{item.icon}</span>}
                {item.label}
              </button>
            ),
          )}
        </div>
      )}

      <MoveContextNoteModal noteId={moveNoteId} onClose={() => setMoveNoteId(null)} />
      <RenameContextNoteModal
        noteId={renameNoteId}
        initialTitle={header}
        onClose={() => setRenameNoteId(null)}
      />
    </>
  );
}
