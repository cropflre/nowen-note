import React, { useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Plus, Pin, PinOff, Star, StarOff, Clock, FileText, Trash2, ArchiveRestore, Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import ContextMenu, { ContextMenuItem } from "@/components/ContextMenu";
import { useContextMenu } from "@/hooks/useContextMenu";
import { useApp, useAppActions } from "@/store/AppContext";
import { api } from "@/lib/api";
import { NoteListItem } from "@/types";
import { cn } from "@/lib/utils";

function formatTime(dateStr: string) {
  const d = new Date(dateStr + "Z");
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "刚刚";
  if (diffMin < 60) return `${diffMin} 分钟前`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr} 小时前`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay} 天前`;
  return d.toLocaleDateString("zh-CN");
}

const NoteCard = React.forwardRef<HTMLDivElement, {
  note: NoteListItem; isActive: boolean; onClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  isContextTarget: boolean;
}>(function NoteCard({ note, isActive, onClick, onContextMenu, isContextTarget }, ref) {
  const preview = note.contentText?.slice(0, 80) || "";

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      onClick={onClick}
      onContextMenu={onContextMenu}
      className={cn(
        "px-3 py-2.5 rounded-lg cursor-pointer border transition-all group",
        isActive
          ? "bg-app-active border-accent-primary/30 shadow-sm"
          : isContextTarget
          ? "bg-app-hover border-accent-primary/20"
          : "bg-transparent border-transparent hover:bg-app-hover"
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className={cn(
          "text-sm font-medium truncate flex-1",
          isActive ? "text-tx-primary" : "text-tx-secondary"
        )}>
          {note.title || "无标题笔记"}
        </h3>
        <div className="flex items-center gap-1 shrink-0">
          {note.isPinned === 1 && <Pin size={12} className="text-accent-primary" />}
          {note.isFavorite === 1 && <Star size={12} className="text-amber-400 fill-amber-400" />}
        </div>
      </div>
      {preview && (
        <p className="text-xs text-tx-tertiary mt-1 line-clamp-2 leading-relaxed">{preview}</p>
      )}
      <div className="flex items-center gap-1.5 mt-1.5 text-tx-tertiary">
        <Clock size={10} />
        <span className="text-[10px]">{formatTime(note.updatedAt)}</span>
      </div>
    </motion.div>
  );
});

export default function NoteList() {
  const { state } = useApp();
  const actions = useAppActions();
  const { menu, menuRef, openMenu, closeMenu } = useContextMenu();

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
    const note = await api.createNote({ notebookId, title: "无标题笔记" });
    actions.setActiveNote(note);
    await fetchNotes();
  };

  // 根据当前视图和目标笔记动态构建菜单项
  const getMenuItems = (): ContextMenuItem[] => {
    const targetNote = state.notes.find((n) => n.id === menu.targetId);
    if (!targetNote) return [];

    const isTrashView = state.viewMode === "trash";

    if (isTrashView) {
      return [
        { id: "restore", label: "恢复笔记", icon: <ArchiveRestore size={14} /> },
        { id: "sep1", label: "", separator: true },
        { id: "delete_permanent", label: "永久删除", icon: <Trash2 size={14} />, danger: true },
      ];
    }

    return [
      {
        id: "toggle_pin",
        label: targetNote.isPinned === 1 ? "取消置顶" : "置顶",
        icon: targetNote.isPinned === 1 ? <PinOff size={14} /> : <Pin size={14} />,
      },
      {
        id: "toggle_fav",
        label: targetNote.isFavorite === 1 ? "取消收藏" : "收藏",
        icon: targetNote.isFavorite === 1 ? <StarOff size={14} /> : <Star size={14} />,
      },
      { id: "sep1", label: "", separator: true },
      { id: "trash", label: "移入回收站", icon: <Trash2 size={14} />, danger: true },
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
      case "trash": {
        await api.updateNote(targetId, { isTrashed: 1 } as any);
        if (state.activeNote?.id === targetId) actions.setActiveNote(null);
        await fetchNotes();
        break;
      }
      case "restore": {
        await api.updateNote(targetId, { isTrashed: 0 } as any);
        await fetchNotes();
        break;
      }
      case "delete_permanent": {
        await api.deleteNote(targetId);
        if (state.activeNote?.id === targetId) actions.setActiveNote(null);
        await fetchNotes();
        break;
      }
    }
  };

  const viewTitles: Record<string, string> = {
    all: "所有笔记",
    notebook: state.notebooks.find((n) => n.id === state.selectedNotebookId)?.name || "笔记本",
    favorites: "收藏",
    trash: "回收站",
    search: `搜索: ${state.searchQuery}`,
    tag: `# ${state.tags.find((t) => t.id === state.selectedTagId)?.name || "标签"}`,
  };

  return (
    <div className="w-full md:w-[300px] md:min-w-[300px] h-full bg-app-surface border-r border-app-border flex flex-col shrink-0 transition-colors relative">
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
        <span className="text-[10px] text-tx-tertiary">{state.notes.length} 条笔记</span>
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
            <div className="flex flex-col items-center justify-center py-12 text-tx-tertiary">
              <FileText size={32} className="mb-2 opacity-30" />
              <p className="text-xs">暂无笔记</p>
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
        header={state.notes.find((n) => n.id === menu.targetId)?.title || "笔记"}
      />
    </div>
  );
}
