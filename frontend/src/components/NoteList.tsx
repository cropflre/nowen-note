import React, { useEffect, useCallback, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Plus, Pin, PinOff, Star, StarOff, Clock, FileText, Trash2, ArchiveRestore, Menu, FolderInput, ChevronRight, ChevronDown, Folder, X, Check, Lock, Unlock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import ContextMenu, { ContextMenuItem } from "@/components/ContextMenu";
import { useContextMenu } from "@/hooks/useContextMenu";
import { useApp, useAppActions } from "@/store/AppContext";
import { api } from "@/lib/api";
import { NoteListItem, Notebook } from "@/types";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";

function formatTime(dateStr: string, t: (key: string, opts?: any) => string) {
  const d = new Date(dateStr + "Z");
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return t('common.justNow');
  if (diffMin < 60) return t('common.minutesAgo', { count: diffMin });
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return t('common.hoursAgo', { count: diffHr });
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return t('common.daysAgo', { count: diffDay });
  return d.toLocaleDateString();
}

/* ===== 笔记本树形选择 ===== */
function buildNotebookTree(notebooks: Notebook[]): Notebook[] {
  const map = new Map<string, Notebook>();
  const roots: Notebook[] = [];
  for (const nb of notebooks) {
    map.set(nb.id, { ...nb, children: [] });
  }
  for (const nb of notebooks) {
    const node = map.get(nb.id)!;
    if (nb.parentId && map.has(nb.parentId)) {
      map.get(nb.parentId)!.children!.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

function NotebookTreeItem({
  notebook, depth, selectedId, currentNotebookId, onSelect,
}: {
  notebook: Notebook; depth: number; selectedId: string | null;
  currentNotebookId: string; onSelect: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const { t } = useTranslation();
  const hasChildren = notebook.children && notebook.children.length > 0;
  const isCurrent = notebook.id === currentNotebookId;
  const isSelected = notebook.id === selectedId;

  return (
    <div>
      <button
        onClick={() => !isCurrent && onSelect(notebook.id)}
        disabled={isCurrent}
        className={cn(
          "w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm transition-colors",
          isCurrent
            ? "opacity-40 cursor-not-allowed"
            : isSelected
            ? "bg-accent-primary/10 text-accent-primary"
            : "text-tx-secondary hover:bg-app-hover hover:text-tx-primary"
        )}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
      >
        {hasChildren ? (
          <span
            onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
            className="w-4 h-4 flex items-center justify-center shrink-0 cursor-pointer"
          >
            {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </span>
        ) : (
          <span className="w-4 h-4 shrink-0" />
        )}
        <Folder size={14} className="shrink-0" />
        <span className="truncate flex-1 text-left">{notebook.name}</span>
        {isCurrent && <span className="text-[10px] text-tx-tertiary shrink-0">{t('common.current')}</span>}
        {isSelected && <Check size={14} className="text-accent-primary shrink-0" />}
      </button>
      {hasChildren && expanded && notebook.children!.map((child) => (
        <NotebookTreeItem
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

function MoveNoteModal({
  isOpen, noteTitle, currentNotebookId, notebooks, onMove, onClose,
}: {
  isOpen: boolean; noteTitle: string; currentNotebookId: string;
  notebooks: Notebook[]; onMove: (notebookId: string) => void; onClose: () => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { t } = useTranslation();
  const tree = buildNotebookTree(notebooks);

  useEffect(() => {
    if (isOpen) setSelectedId(null);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-[360px] max-h-[480px] bg-app-elevated border border-app-border rounded-xl shadow-2xl flex flex-col overflow-hidden"
        style={{ animation: "contextMenuIn 0.15s ease-out" }}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-app-border">
          <div className="flex items-center gap-2 min-w-0">
            <FolderInput size={16} className="text-accent-primary shrink-0" />
            <span className="text-sm font-medium text-tx-primary truncate">{t('noteList.moveNote')}</span>
          </div>
          <button onClick={onClose} className="p-1 rounded-md hover:bg-app-hover text-tx-tertiary">
            <X size={16} />
          </button>
        </div>
        <div className="px-4 py-2 text-xs text-tx-tertiary truncate border-b border-app-border">
          {noteTitle || t('common.untitledNote')}
        </div>
        <ScrollArea className="flex-1 max-h-[300px]">
          <div className="p-2">
            {tree.map((nb) => (
              <NotebookTreeItem
                key={nb.id}
                notebook={nb}
                depth={0}
                selectedId={selectedId}
                currentNotebookId={currentNotebookId}
                onSelect={setSelectedId}
              />
            ))}
            {tree.length === 0 && (
              <p className="text-xs text-tx-tertiary text-center py-4">{t('noteList.noNotebooks')}</p>
            )}
          </div>
        </ScrollArea>
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-app-border">
          <Button variant="ghost" size="sm" onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            size="sm"
            disabled={!selectedId || selectedId === currentNotebookId}
            onClick={() => selectedId && onMove(selectedId)}
            className="bg-accent-primary text-white hover:bg-accent-primary/90 disabled:opacity-40"
          >
            {t('noteList.moveButton')}
          </Button>
        </div>
      </div>
    </div>
  );
}

const NoteCard = React.forwardRef<HTMLDivElement, {
  note: NoteListItem; isActive: boolean; onClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  isContextTarget: boolean;
}>(function NoteCard({ note, isActive, onClick, onContextMenu, isContextTarget }, ref) {
  const preview = note.contentText?.slice(0, 100) || "";
  const { t } = useTranslation();
  const wordCount = note.contentText?.length || 0;

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      onClick={onClick}
      onContextMenu={onContextMenu}
      className={cn(
        "relative rounded-lg cursor-pointer border transition-all group overflow-hidden",
        isActive
          ? "bg-app-active border-accent-primary/30 shadow-sm"
          : isContextTarget
          ? "bg-app-hover border-accent-primary/20"
          : "bg-transparent border-transparent hover:bg-app-hover"
      )}
    >
      {/* 左侧彩色指示条 */}
      <div className={cn(
        "absolute left-0 top-0 bottom-0 w-[3px] rounded-l-lg transition-colors",
        isActive
          ? "bg-accent-primary"
          : note.isFavorite === 1
          ? "bg-amber-400"
          : note.isPinned === 1
          ? "bg-accent-primary/50"
          : "bg-transparent group-hover:bg-app-border"
      )} />

      <div className="pl-3.5 pr-3 py-2.5">
        {/* 标题行 + 状态图标 */}
        <div className="flex items-center justify-between gap-2">
          <h3 className={cn(
            "text-sm font-medium truncate flex-1",
            isActive ? "text-tx-primary" : "text-tx-secondary group-hover:text-tx-primary"
          )}>
            {note.title || t('common.untitledNote')}
          </h3>
          <div className="flex items-center gap-1 shrink-0">
            {note.isLocked === 1 && <Lock size={11} className="text-orange-500" />}
            {note.isPinned === 1 && <Pin size={11} className="text-accent-primary" />}
            {note.isFavorite === 1 && <Star size={11} className="text-amber-400 fill-amber-400" />}
          </div>
        </div>

        {/* 内容预览 */}
        {preview && (
          <p className="text-xs text-tx-tertiary mt-1.5 line-clamp-2 leading-relaxed">{preview}</p>
        )}

        {/* 底部元信息行 */}
        <div className="flex items-center justify-between mt-2 text-tx-tertiary">
          <div className="flex items-center gap-1.5">
            <Clock size={10} />
            <span className="text-[10px]">{formatTime(note.updatedAt, t)}</span>
          </div>
          {wordCount > 0 && (
            <span className="text-[10px] opacity-0 group-hover:opacity-100 transition-opacity tabular-nums">
              {wordCount > 999 ? `${(wordCount / 1000).toFixed(1)}k` : wordCount} {t('common.chars') || '字'}
            </span>
          )}
        </div>
      </div>
    </motion.div>
  );
});

export default function NoteList() {
  const { state } = useApp();
  const actions = useAppActions();
  const { menu, menuRef, openMenu, closeMenu } = useContextMenu();
  const [moveModal, setMoveModal] = useState<{ noteId: string; noteTitle: string; notebookId: string } | null>(null);
  const { t } = useTranslation();

  const fetchNotes = useCallback(async () => {
    actions.setLoading(true);
    let notes: NoteListItem[] = [];
    if (state.viewMode === "notebook" && state.selectedNotebookId) {
      notes = await api.getNotes({ notebookId: state.selectedNotebookId });
    } else if (state.viewMode === "favorites") {
      notes = await api.getNotes({ isFavorite: "1" });
    } else if (state.viewMode === "trash") {
      notes = await api.getNotes({ isTrashed: "1" });
    } else if (state.viewMode === "search" && state.searchQuery) {
      const results = await api.search(state.searchQuery);
      notes = results.map((r) => ({
        id: r.id,
        userId: "",
        notebookId: r.notebookId,
        title: r.title,
        contentText: r.snippet,
        isPinned: r.isPinned,
        isFavorite: r.isFavorite,
        isArchived: 0,
        isTrashed: 0,
        isLocked: 0,
        version: 0,
        createdAt: r.updatedAt,
        updatedAt: r.updatedAt,
      }));
    } else if (state.viewMode === "tag" && state.selectedTagId) {
      notes = await api.getNotesWithTag(state.selectedTagId);
    } else {
      notes = await api.getNotes();
    }
    actions.setNotes(notes);
    actions.setLoading(false);
  }, [state.viewMode, state.selectedNotebookId, state.searchQuery, state.selectedTagId]);

  useEffect(() => {
    fetchNotes().catch(console.error);
  }, [fetchNotes]);

  const handleSelectNote = async (noteId: string) => {
    const note = await api.getNote(noteId);
    actions.setActiveNote(note);
    actions.setMobileView("editor");
  };

  const handleCreateNote = async () => {
    const notebookId = state.selectedNotebookId || state.notebooks[0]?.id;
    if (!notebookId) return;
    const note = await api.createNote({ notebookId, title: t('common.untitledNote') });
    actions.setActiveNote(note);
    await fetchNotes();
    actions.refreshNotebooks();
  };

  // 根据当前视图和目标笔记动态构建菜单项
  const getMenuItems = (): ContextMenuItem[] => {
    const targetNote = state.notes.find((n) => n.id === menu.targetId);
    if (!targetNote) return [];

    const isTrashView = state.viewMode === "trash";

    if (isTrashView) {
      return [
        { id: "restore", label: t('noteList.restoreNote'), icon: <ArchiveRestore size={14} /> },
        { id: "sep1", label: "", separator: true },
        { id: "delete_permanent", label: t('noteList.permanentDelete'), icon: <Trash2 size={14} />, danger: true },
      ];
    }

    return [
      {
        id: "toggle_pin",
        label: targetNote.isPinned === 1 ? t('noteList.unpin') : t('noteList.pin'),
        icon: targetNote.isPinned === 1 ? <PinOff size={14} /> : <Pin size={14} />,
      },
      {
        id: "toggle_fav",
        label: targetNote.isFavorite === 1 ? t('noteList.unfavorite') : t('noteList.favorite'),
        icon: targetNote.isFavorite === 1 ? <StarOff size={14} /> : <Star size={14} />,
      },
      {
        id: "toggle_lock",
        label: targetNote.isLocked === 1 ? t('noteList.unlock') : t('noteList.lock'),
        icon: targetNote.isLocked === 1 ? <Unlock size={14} /> : <Lock size={14} />,
      },
      { id: "sep1", label: "", separator: true },
      {
        id: "move",
        label: t('noteList.moveTo'),
        icon: <FolderInput size={14} />,
        disabled: !!targetNote.isLocked,
      },
      { id: "sep2", label: "", separator: true },
      { id: "trash", label: t('noteList.moveToTrash'), icon: <Trash2 size={14} />, danger: true, disabled: !!targetNote.isLocked },
    ];
  };

  const handleMenuAction = async (actionId: string) => {
    const targetId = menu.targetId;
    closeMenu();
    if (!targetId) return;

    const targetNote = state.notes.find((n) => n.id === targetId);
    if (!targetNote) return;

    switch (actionId) {
      case "toggle_pin": {
        const newVal = targetNote.isPinned === 1 ? 0 : 1;
        await api.updateNote(targetId, { isPinned: newVal } as any);
        actions.updateNoteInList({ id: targetId, isPinned: newVal });
        break;
      }
      case "toggle_fav": {
        const newVal = targetNote.isFavorite === 1 ? 0 : 1;
        await api.updateNote(targetId, { isFavorite: newVal } as any);
        actions.updateNoteInList({ id: targetId, isFavorite: newVal });
        break;
      }
      case "toggle_lock": {
        const newVal = targetNote.isLocked === 1 ? 0 : 1;
        await api.updateNote(targetId, { isLocked: newVal } as any);
        actions.updateNoteInList({ id: targetId, isLocked: newVal });
        if (state.activeNote?.id === targetId) {
          actions.setActiveNote({ ...state.activeNote, isLocked: newVal });
        }
        break;
      }
      case "trash": {
        await api.updateNote(targetId, { isTrashed: 1 } as any);
        if (state.activeNote?.id === targetId) actions.setActiveNote(null);
        await fetchNotes();
        actions.refreshNotebooks();
        break;
      }
      case "move": {
        setMoveModal({
          noteId: targetId,
          noteTitle: targetNote.title,
          notebookId: targetNote.notebookId,
        });
        break;
      }
      case "restore": {
        await api.updateNote(targetId, { isTrashed: 0 } as any);
        await fetchNotes();
        actions.refreshNotebooks();
        break;
      }
      case "delete_permanent": {
        await api.deleteNote(targetId);
        if (state.activeNote?.id === targetId) actions.setActiveNote(null);
        await fetchNotes();
        actions.refreshNotebooks();
        break;
      }
    }
  };

  const handleMoveNote = async (targetNotebookId: string) => {
    if (!moveModal) return;
    await api.updateNote(moveModal.noteId, { notebookId: targetNotebookId } as any);
    if (state.activeNote?.id === moveModal.noteId) {
      actions.setActiveNote({ ...state.activeNote, notebookId: targetNotebookId });
    }
    setMoveModal(null);
    await fetchNotes();
    actions.refreshNotebooks();
  };

  const viewTitles: Record<string, string> = {
    all: t('noteList.allNotes'),
    notebook: state.notebooks.find((n) => n.id === state.selectedNotebookId)?.name || t('noteList.notebook'),
    favorites: t('noteList.favorite'),
    trash: t('sidebar.trash'),
    search: t('noteList.search', { query: state.searchQuery }),
    tag: `# ${state.tags.find((tg) => tg.id === state.selectedTagId)?.name || t('noteList.tag')}`,
  };

  return (
    <div className="w-full h-full bg-app-surface border-r border-app-border flex flex-col transition-colors relative">
      {/* Mobile Header */}
      <header className="flex items-center justify-between px-4 py-3 border-b border-app-border md:hidden">
        <button
          onClick={() => actions.setMobileSidebar(true)}
          className="p-1.5 -ml-1.5 rounded-md text-tx-secondary hover:bg-app-hover"
        >
          <Menu size={22} />
        </button>
        <h2 className="text-sm font-medium text-tx-primary">{viewTitles[state.viewMode]}</h2>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={handleCreateNote}>
          <Plus size={15} />
        </Button>
      </header>

      {/* Desktop Header */}
      <div className="hidden md:flex items-center justify-between px-4 py-3 border-b border-app-border">
        <div className="flex items-center gap-2">
          <FileText size={16} className="text-accent-primary" />
          <h2 className="text-sm font-medium text-tx-primary">{viewTitles[state.viewMode]}</h2>
        </div>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={handleCreateNote}>
          <Plus size={15} />
        </Button>
      </div>

      {/* Count */}
      <div className="px-4 py-1.5">
        <span className="text-[10px] text-tx-tertiary">{t('common.noteCount', { count: state.notes.length })}</span>
      </div>

      {/* List */}
      <ScrollArea className="flex-1">
        <div className="px-2 pb-2 space-y-1">
          <AnimatePresence mode="popLayout">
            {state.notes.map((note) => (
              <NoteCard
                key={note.id}
                note={note}
                isActive={state.activeNote?.id === note.id}
                isContextTarget={menu.isOpen && menu.targetId === note.id}
                onClick={() => handleSelectNote(note.id)}
                onContextMenu={(e) => openMenu(e, note.id, "note")}
              />
            ))}
          </AnimatePresence>
          {state.notes.length === 0 && !state.isLoading && (
            <div className="flex flex-col items-center justify-center py-16 px-6 text-center">
              <div className="w-16 h-16 rounded-2xl bg-accent-primary/10 flex items-center justify-center mb-4">
                <FileText size={28} className="text-accent-primary/40" />
              </div>
              <p className="text-sm font-medium text-tx-secondary mb-1">{t('common.noNotes')}</p>
              <p className="text-xs text-tx-tertiary mb-5 max-w-[200px] leading-relaxed">
                {t('common.noNotesHint') || '点击下方按钮创建你的第一篇笔记'}
              </p>
              <button
                onClick={handleCreateNote}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-accent-primary text-white text-xs font-medium hover:bg-accent-primary/90 active:scale-95 transition-all shadow-sm"
              >
                <Plus size={14} />
                {t('common.newNote') || '新建笔记'}
              </button>
            </div>
          )}
          {/* 骨架屏 Loading */}
          {state.isLoading && state.notes.length === 0 && (
            <div className="space-y-2 px-1">
              {[1, 2, 3, 4, 5].map((i) => (
                <div key={i} className="rounded-lg border border-transparent p-3 animate-pulse">
                  <div className="flex items-center gap-2">
                    <div className="h-4 bg-app-hover rounded w-3/5" />
                    <div className="h-3 bg-app-hover rounded w-4 ml-auto" />
                  </div>
                  <div className="h-3 bg-app-hover/70 rounded w-full mt-2.5" />
                  <div className="h-3 bg-app-hover/50 rounded w-4/5 mt-1.5" />
                  <div className="flex items-center gap-1.5 mt-2.5">
                    <div className="h-2.5 w-2.5 bg-app-hover/60 rounded-full" />
                    <div className="h-2.5 bg-app-hover/40 rounded w-16" />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </ScrollArea>

      {/* Mobile FAB - 新建笔记 */}
      <button
        onClick={handleCreateNote}
        className="md:hidden absolute bottom-6 right-6 w-14 h-14 bg-accent-primary rounded-2xl shadow-lg shadow-accent-primary/30 flex items-center justify-center text-white active:scale-95 transition-transform z-10"
      >
        <Plus size={24} />
      </button>

      {/* Note Context Menu */}
      <ContextMenu
        isOpen={menu.isOpen && menu.targetType === "note"}
        x={menu.x}
        y={menu.y}
        menuRef={menuRef}
        items={getMenuItems()}
        onAction={handleMenuAction}
        header={state.notes.find((n) => n.id === menu.targetId)?.title || t('noteList.note')}
      />

      {/* Move Note Modal */}
      <MoveNoteModal
        isOpen={!!moveModal}
        noteTitle={moveModal?.noteTitle || ""}
        currentNotebookId={moveModal?.notebookId || ""}
        notebooks={state.notebooks}
        onMove={handleMoveNote}
        onClose={() => setMoveModal(null)}
      />
    </div>
  );
}
