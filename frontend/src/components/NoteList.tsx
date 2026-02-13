import React, { useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Plus, Pin, Star, Clock, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
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
}>(function NoteCard({ note, isActive, onClick }, ref) {
  const preview = note.contentText?.slice(0, 80) || "";

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      onClick={onClick}
      className={cn(
        "px-3 py-2.5 rounded-lg cursor-pointer border transition-all group",
        isActive
          ? "bg-app-active border-accent-primary/30 shadow-sm"
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
    } else {
      notes = await api.getNotes();
    }
    actions.setNotes(notes);
    actions.setLoading(false);
  }, [state.viewMode, state.selectedNotebookId, state.searchQuery]);

  useEffect(() => {
    fetchNotes().catch(console.error);
  }, [fetchNotes]);

  const handleSelectNote = async (noteId: string) => {
    const note = await api.getNote(noteId);
    actions.setActiveNote(note);
  };

  const handleCreateNote = async () => {
    const notebookId = state.selectedNotebookId || state.notebooks[0]?.id;
    if (!notebookId) return;
    const note = await api.createNote({ notebookId, title: "无标题笔记" });
    actions.setActiveNote(note);
    await fetchNotes();
  };

  const viewTitles: Record<string, string> = {
    all: "所有笔记",
    notebook: state.notebooks.find((n) => n.id === state.selectedNotebookId)?.name || "笔记本",
    favorites: "收藏",
    trash: "回收站",
    search: `搜索: ${state.searchQuery}`,
  };

  return (
    <div className="w-[300px] min-w-[300px] h-full bg-app-surface border-r border-app-border flex flex-col shrink-0 transition-colors">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-app-border">
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
                onClick={() => handleSelectNote(note.id)}
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
    </div>
  );
}
