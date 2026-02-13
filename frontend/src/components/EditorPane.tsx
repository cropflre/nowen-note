import React, { useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Star, Pin, Trash2, MoreVertical, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import TiptapEditor from "@/components/TiptapEditor";
import { useApp, useAppActions } from "@/store/AppContext";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

export default function EditorPane() {
  const { state } = useApp();
  const actions = useAppActions();
  const { activeNote } = state;

  const handleUpdate = useCallback(async (data: { content: string; contentText: string; title: string }) => {
    if (!activeNote) return;
    const updated = await api.updateNote(activeNote.id, {
      title: data.title,
      content: data.content,
      contentText: data.contentText,
      version: activeNote.version,
    } as any);
    actions.setActiveNote(updated);
    actions.updateNoteInList({ id: updated.id, title: updated.title, contentText: updated.contentText, updatedAt: updated.updatedAt });
  }, [activeNote, actions]);

  const toggleFavorite = useCallback(async () => {
    if (!activeNote) return;
    const updated = await api.updateNote(activeNote.id, { isFavorite: activeNote.isFavorite ? 0 : 1 } as any);
    actions.setActiveNote(updated);
    actions.updateNoteInList({ id: updated.id, isFavorite: updated.isFavorite });
  }, [activeNote, actions]);

  const togglePin = useCallback(async () => {
    if (!activeNote) return;
    const updated = await api.updateNote(activeNote.id, { isPinned: activeNote.isPinned ? 0 : 1 } as any);
    actions.setActiveNote(updated);
    actions.updateNoteInList({ id: updated.id, isPinned: updated.isPinned });
  }, [activeNote, actions]);

  const moveToTrash = useCallback(async () => {
    if (!activeNote) return;
    await api.updateNote(activeNote.id, { isTrashed: 1 } as any);
    actions.setActiveNote(null);
  }, [activeNote, actions]);

  if (!activeNote) {
    return (
      <div className="flex-1 flex items-center justify-center bg-dark-bg">
        <div className="text-center">
          <div className="text-6xl mb-4 opacity-10">✍️</div>
          <p className="text-text-tertiary text-sm">选择一条笔记开始编辑</p>
          <p className="text-text-tertiary text-xs mt-1">或创建新笔记</p>
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
      className="flex-1 flex flex-col bg-dark-bg overflow-hidden"
    >
      {/* Editor Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-dark-border bg-dark-surface/30">
        <div className="flex items-center gap-2">
          <span className="text-xs text-text-tertiary">
            {state.notebooks.find((n) => n.id === activeNote.notebookId)?.icon}{" "}
            {state.notebooks.find((n) => n.id === activeNote.notebookId)?.name}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost" size="icon" className="h-7 w-7"
            onClick={togglePin}
            title={activeNote.isPinned ? "取消置顶" : "置顶"}
          >
            <Pin size={14} className={cn(activeNote.isPinned && "text-accent-primary fill-accent-primary")} />
          </Button>
          <Button
            variant="ghost" size="icon" className="h-7 w-7"
            onClick={toggleFavorite}
            title={activeNote.isFavorite ? "取消收藏" : "收藏"}
          >
            <Star size={14} className={cn(activeNote.isFavorite && "text-yellow-400 fill-yellow-400")} />
          </Button>
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={moveToTrash} title="移到回收站">
            <Trash2 size={14} />
          </Button>
        </div>
      </div>

      {/* Tiptap Editor */}
      <div className="flex-1 overflow-hidden">
        <TiptapEditor note={activeNote} onUpdate={handleUpdate} />
      </div>
    </motion.div>
  );
}
