import React, { useCallback, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Star, Pin, Trash2, Cloud, CloudOff, RefreshCw, Check, Loader2, ChevronLeft, FolderInput, ChevronRight, ChevronDown, Folder, X, ListTree, Lock, Unlock, Sparkles, Tag as TagIcon, Type } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import TiptapEditor, { HeadingItem } from "@/components/TiptapEditor";
import { useApp, useAppActions, SyncStatus } from "@/store/AppContext";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Tag, Notebook } from "@/types";
import { useTranslation } from "react-i18next";

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

  const handleUpdate = useCallback(async (data: { content: string; contentText: string; title: string }) => {
    if (!activeNote || activeNote.isLocked) return;
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

  const toggleLock = useCallback(async () => {
    if (!activeNote) return;
    const updated = await api.updateNote(activeNote.id, { isLocked: activeNote.isLocked ? 0 : 1 } as any);
    actions.setActiveNote(updated);
    actions.updateNoteInList({ id: updated.id, isLocked: updated.isLocked });
  }, [activeNote, actions]);

  const moveToTrash = useCallback(async () => {
    if (!activeNote || activeNote.isLocked) return;
    await api.updateNote(activeNote.id, { isTrashed: 1 } as any);
    actions.setActiveNote(null);
    actions.refreshNotebooks();
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
      const title = await api.aiChat("title", activeNote.contentText.slice(0, 2000));
      const cleaned = title.replace(/^["'"""'']+|["'"""'']+$/g, "").trim();
      if (cleaned) {
        const updated = await api.updateNote(activeNote.id, { title: cleaned, version: activeNote.version } as any);
        actions.setActiveNote(updated);
        actions.updateNoteInList({ id: updated.id, title: updated.title, updatedAt: updated.updatedAt });
      }
    } catch (e) { console.error("AI title error:", e); }
    setAiTitleLoading(false);
  }, [activeNote, actions, aiTitleLoading]);

  // AI 推荐标签
  const [aiTagsLoading, setAiTagsLoading] = useState(false);
  const handleAITags = useCallback(async () => {
    if (!activeNote || !activeNote.contentText || aiTagsLoading) return;
    setAiTagsLoading(true);
    try {
      const result = await api.aiChat("tags", activeNote.contentText.slice(0, 2000));
      const tagNames = result.split(/[,，、\s]+/).map(s => s.replace(/^#/, "").trim()).filter(Boolean);
      const userId = activeNote.userId;
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

  if (!activeNote) {
    return (
      <div className="flex-1 flex items-center justify-center bg-app-bg transition-colors">
        <div className="text-center hidden md:block">
          <div className="text-6xl mb-4 opacity-10">✍️</div>
          <p className="text-tx-tertiary text-sm">{t('editor.selectNote')}</p>
          <p className="text-tx-tertiary text-xs mt-1">{t('editor.orCreateNew')}</p>
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
          <span className="text-sm">{t('editor.back')}</span>
        </button>
        <div className="ml-auto flex items-center gap-1">
          <SyncIndicator syncStatus={syncStatus} lastSyncedAt={lastSyncedAt} onManualSync={handleManualSync} />
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={toggleLock}
            title={activeNote.isLocked ? t('editor.unlockTooltip') : t('editor.lockTooltip')}>
            {activeNote.isLocked
              ? <Lock size={14} className="text-orange-500" />
              : <Unlock size={14} />}
          </Button>
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
        <div className="relative">
          <button
            onClick={() => setShowMoveDropdown(!showMoveDropdown)}
            className="flex items-center gap-1.5 text-xs text-tx-tertiary hover:text-tx-secondary transition-colors rounded-md px-1.5 py-1 hover:bg-app-hover"
            title={t('editor.moveToNotebook')}
          >
            <span>
              {state.notebooks.find((n) => n.id === activeNote.notebookId)?.icon}{" "}
              {state.notebooks.find((n) => n.id === activeNote.notebookId)?.name}
            </span>
            <ChevronDown size={12} />
          </button>
          {showMoveDropdown && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setShowMoveDropdown(false)} />
              <div
                ref={moveDropdownRef}
                className="absolute top-full left-0 mt-1 w-56 bg-app-elevated border border-app-border rounded-lg shadow-xl z-50 py-1 max-h-64 overflow-auto"
                style={{ animation: "contextMenuIn 0.12s ease-out" }}
              >
                <div className="px-3 py-1.5 text-[10px] font-medium text-tx-tertiary border-b border-app-border mb-1">
                  {t('editor.moveToLabel')}
                </div>
                {state.notebooks.map((nb) => (
                  <button
                    key={nb.id}
                    disabled={nb.id === activeNote.notebookId}
                    onClick={() => handleMoveToNotebook(nb.id)}
                    className={cn(
                      "w-full flex items-center gap-2 px-3 py-1.5 text-sm transition-colors",
                      nb.id === activeNote.notebookId
                        ? "opacity-40 cursor-not-allowed text-tx-tertiary"
                        : "text-tx-secondary hover:bg-app-hover hover:text-tx-primary"
                    )}
                  >
                    <span>{nb.icon || "📁"}</span>
                    <span className="truncate">{nb.name}</span>
                    {nb.id === activeNote.notebookId && (
                      <span className="ml-auto text-[10px] text-tx-tertiary">{t('common.current')}</span>
                    )}
                  </button>
                ))}
              </div>
            </>
          )}
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
            onClick={toggleLock}
            title={activeNote.isLocked ? t('editor.unlockTooltip') : t('editor.lockTooltip')}
          >
            {activeNote.isLocked
              ? <Lock size={14} className="text-orange-500" />
              : <Unlock size={14} />}
          </Button>
          <Button
            variant="ghost" size="icon" className="h-7 w-7"
            onClick={togglePin}
            title={activeNote.isPinned ? t('editor.unpinTooltip') : t('editor.pinTooltip')}
          >
            <Pin size={14} className={cn(activeNote.isPinned && "text-accent-primary fill-accent-primary")} />
          </Button>
          <Button
            variant="ghost" size="icon" className="h-7 w-7"
            onClick={toggleFavorite}
            title={activeNote.isFavorite ? t('editor.unfavoriteTooltip') : t('editor.favoriteTooltip')}
          >
            <Star size={14} className={cn(activeNote.isFavorite && "text-amber-400 fill-amber-400")} />
          </Button>
          <Button
            variant="ghost" size="icon" className="h-7 w-7"
            onClick={moveToTrash}
            title={t('editor.trashTooltip')}
            disabled={!!activeNote.isLocked}
          >
            <Trash2 size={14} className={cn(activeNote.isLocked && "opacity-30")} />
          </Button>
          <div className="w-px h-4 bg-app-border mx-1" />
          <Button
            variant="ghost" size="icon" className="h-7 w-7"
            onClick={() => setShowOutline(!showOutline)}
            title={showOutline ? t('editor.hideOutline') : t('editor.showOutline')}
          >
            <ListTree size={14} className={cn(showOutline && "text-accent-primary")} />
          </Button>
          <div className="w-px h-4 bg-app-border mx-1" />
          <Button
            variant="ghost" size="icon" className="h-7 w-7"
            onClick={handleAITitle}
            disabled={aiTitleLoading || !activeNote.contentText || !!activeNote.isLocked}
            title={t('editor.aiGenerateTitle')}
          >
            {aiTitleLoading ? <Loader2 size={14} className="animate-spin text-violet-500" /> : <Type size={14} className="text-violet-500" />}
          </Button>
          <Button
            variant="ghost" size="icon" className="h-7 w-7"
            onClick={handleAITags}
            disabled={aiTagsLoading || !activeNote.contentText || !!activeNote.isLocked}
            title={t('editor.aiSuggestTags')}
          >
            {aiTagsLoading ? <Loader2 size={14} className="animate-spin text-violet-500" /> : <TagIcon size={14} className="text-violet-500" />}
          </Button>
        </div>
      </div>

      {/* Tiptap Editor + Outline */}
      <div className="flex-1 flex overflow-hidden">
        <div className="flex-1 overflow-hidden">
          <TiptapEditor
            note={activeNote}
            onUpdate={handleUpdate}
            onTagsChange={handleTagsChange}
            onHeadingsChange={setHeadings}
            onEditorReady={(fn) => { scrollToRef.current = fn; }}
            editable={!activeNote.isLocked}
          />
        </div>
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
