import React, { useCallback, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Star, Pin, Trash2, Cloud, CloudOff, RefreshCw, Check, Loader2, ChevronLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import TiptapEditor from "@/components/TiptapEditor";
import { useApp, useAppActions, SyncStatus } from "@/store/AppContext";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Tag } from "@/types";

export default function EditorPane() {
  const { state } = useApp();
  const actions = useAppActions();
  const { activeNote, syncStatus, lastSyncedAt } = state;
  const savedTimerRef = useRef<NodeJS.Timeout | null>(null);

  const handleUpdate = useCallback(async (data: { content: string; contentText: string; title: string }) => {
    if (!activeNote) return;
    actions.setSyncStatus("saving");
    try {
      const updated = await api.updateNote(activeNote.id, {
        title: data.title,
        content: data.content,
        contentText: data.contentText,
        version: activeNote.version,
      } as any);
      actions.setActiveNote(updated);
      actions.updateNoteInList({ id: updated.id, title: updated.title, contentText: updated.contentText, updatedAt: updated.updatedAt });
      actions.setSyncStatus("saved");
      actions.setLastSynced(new Date().toISOString());
      // 2秒后恢复 idle
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
      savedTimerRef.current = setTimeout(() => actions.setSyncStatus("idle"), 2000);
    } catch {
      actions.setSyncStatus("error");
    }
  }, [activeNote, actions]);

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

  const handleTagsChange = useCallback((tags: Tag[]) => {
    if (!activeNote) return;
    actions.setActiveNote({ ...activeNote, tags });
    // 刷新全局标签列表以更新计数
    api.getTags().then(actions.setTags).catch(console.error);
  }, [activeNote, actions]);

  if (!activeNote) {
    return (
      <div className="flex-1 flex items-center justify-center bg-app-bg transition-colors">
        <div className="text-center hidden md:block">
          <div className="text-6xl mb-4 opacity-10">✍️</div>
          <p className="text-tx-tertiary text-sm">选择一条笔记开始编辑</p>
          <p className="text-tx-tertiary text-xs mt-1">或创建新笔记</p>
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
      <header className="flex items-center gap-2 px-3 py-2 border-b border-app-border bg-app-surface/50 md:hidden">
        <button
          onClick={() => actions.setMobileView("list")}
          className="flex items-center text-accent-primary py-1 px-1 -ml-1 rounded-md"
        >
          <ChevronLeft size={22} />
          <span className="text-sm">返回</span>
        </button>
        <div className="ml-auto flex items-center gap-1">
          <SyncIndicator syncStatus={syncStatus} lastSyncedAt={lastSyncedAt} onManualSync={handleManualSync} />
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={togglePin}>
            <Pin size={14} className={cn(activeNote.isPinned && "text-accent-primary fill-accent-primary")} />
          </Button>
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={toggleFavorite}>
            <Star size={14} className={cn(activeNote.isFavorite && "text-amber-400 fill-amber-400")} />
          </Button>
        </div>
      </header>

      {/* Desktop Editor Header */}
      <div className="hidden md:flex items-center justify-between px-4 py-2 border-b border-app-border bg-app-surface/30 transition-colors">
        <div className="flex items-center gap-2">
          <span className="text-xs text-tx-tertiary">
            {state.notebooks.find((n) => n.id === activeNote.notebookId)?.icon}{" "}
            {state.notebooks.find((n) => n.id === activeNote.notebookId)?.name}
          </span>
        </div>

        {/* Sync Indicator + Actions */}
        <div className="flex items-center gap-1">
          {/* 同步状态指示器 */}
          <SyncIndicator
            syncStatus={syncStatus}
            lastSyncedAt={lastSyncedAt}
            onManualSync={handleManualSync}
          />

          <div className="w-px h-4 bg-app-border mx-1" />

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
            <Star size={14} className={cn(activeNote.isFavorite && "text-amber-400 fill-amber-400")} />
          </Button>
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={moveToTrash} title="移到回收站">
            <Trash2 size={14} />
          </Button>
        </div>
      </div>

      {/* Tiptap Editor */}
      <div className="flex-1 overflow-hidden">
        <TiptapEditor note={activeNote} onUpdate={handleUpdate} onTagsChange={handleTagsChange} />
      </div>
    </motion.div>
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
  const getTooltip = () => {
    switch (syncStatus) {
      case "saving": return "正在保存...";
      case "saved": return "所有更改已保存";
      case "error": return "保存失败，点击重试";
      default:
        if (lastSyncedAt) {
          const diff = Date.now() - new Date(lastSyncedAt).getTime();
          if (diff < 10_000) return "刚刚已保存";
          if (diff < 60_000) return `${Math.floor(diff / 1000)}秒前已保存`;
          if (diff < 3600_000) return `${Math.floor(diff / 60_000)}分钟前已保存`;
          return `${Math.floor(diff / 3600_000)}小时前已保存`;
        }
        return "点击同步";
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
        {syncStatus === "saving" && "保存中..."}
        {syncStatus === "saved" && "已保存"}
        {syncStatus === "error" && "保存失败"}
        {syncStatus === "idle" && (lastSyncedAt ? "已同步" : "同步")}
      </span>
    </button>
  );
}
