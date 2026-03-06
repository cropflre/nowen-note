import React, { useState, useEffect, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Send, Trash2, Edit2, Clock, Check, X, MessageCircle } from "lucide-react";
import { api } from "@/lib/api";
import { DiaryEntry } from "@/types";
import { cn } from "@/lib/utils";

function formatRelativeTime(dateStr: string, t: (key: string, opts?: any) => string): string {
  const date = new Date(dateStr.replace(" ", "T") + (dateStr.includes("Z") ? "" : "Z"));
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHour = Math.floor(diffMs / 3600000);
  const diffDay = Math.floor(diffMs / 86400000);

  if (diffMin < 1) return t("diary.justNow");
  if (diffMin < 60) return t("diary.minutesAgo", { count: diffMin });
  if (diffHour < 24) return t("diary.hoursAgo", { count: diffHour });
  if (diffDay < 30) return t("diary.daysAgo", { count: diffDay });

  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export default function DiaryCenter() {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<DiaryEntry[]>([]);
  const [content, setContent] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const editTextareaRef = useRef<HTMLTextAreaElement>(null);

  const fetchEntries = useCallback(async () => {
    try {
      const data = await api.getDiaryEntries();
      setEntries(data);
    } catch (err) {
      console.error("Failed to fetch diary entries:", err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchEntries();
  }, [fetchEntries]);

  const handlePost = async () => {
    if (!content.trim() || isSubmitting) return;
    setIsSubmitting(true);
    try {
      await api.createDiaryEntry(content);
      setContent("");
      if (textareaRef.current) {
        textareaRef.current.style.height = "auto";
      }
      await fetchEntries();
    } catch (err) {
      console.error("Failed to create diary entry:", err);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm(t("diary.confirmDelete"))) return;
    try {
      await api.deleteDiaryEntry(id);
      setEntries((prev) => prev.filter((e) => e.id !== id));
    } catch (err) {
      console.error("Failed to delete diary entry:", err);
    }
  };

  const handleStartEdit = (entry: DiaryEntry) => {
    setEditingId(entry.id);
    setEditContent(entry.content);
    setTimeout(() => editTextareaRef.current?.focus(), 50);
  };

  const handleSaveEdit = async () => {
    if (!editingId || !editContent.trim()) return;
    try {
      await api.updateDiaryEntry(editingId, editContent);
      setEditingId(null);
      setEditContent("");
      await fetchEntries();
    } catch (err) {
      console.error("Failed to update diary entry:", err);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      handlePost();
    }
  };

  const handleEditKeyDown = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      handleSaveEdit();
    }
    if (e.key === "Escape") {
      setEditingId(null);
    }
  };

  const autoResize = (el: HTMLTextAreaElement) => {
    el.style.height = "auto";
    el.style.height = el.scrollHeight + "px";
  };

  return (
    <div className="flex-1 h-full overflow-y-auto bg-app-bg">
      <div className="max-w-3xl mx-auto py-6 md:py-10 px-4 sm:px-6">
        {/* 标题区 */}
        <div className="mb-6 md:mb-8">
          <h1 className="text-xl md:text-2xl font-bold text-tx-primary flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-violet-500 to-indigo-500 flex items-center justify-center">
              <MessageCircle size={16} className="text-white" />
            </div>
            {t("diary.title")}
          </h1>
          <p className="text-xs md:text-sm text-tx-tertiary mt-1.5 ml-[42px]">{t("diary.subtitle")}</p>
        </div>

        {/* 发布框 */}
        <div className="bg-app-surface rounded-2xl border border-app-border p-4 mb-6 md:mb-8 transition-shadow focus-within:shadow-md focus-within:border-accent-primary/50">
          <textarea
            ref={textareaRef}
            className="w-full bg-transparent resize-none outline-none text-tx-primary placeholder-tx-tertiary text-sm md:text-base leading-relaxed"
            style={{ minHeight: "80px" }}
            placeholder={t("diary.placeholder")}
            value={content}
            onChange={(e) => {
              setContent(e.target.value);
              autoResize(e.target);
            }}
            onKeyDown={handleKeyDown}
          />
          <div className="flex justify-between items-center mt-3 pt-3 border-t border-app-border">
            <div className="flex items-center gap-3">
              <span className="text-[11px] text-tx-tertiary tabular-nums">
                {t("diary.charCount", { count: content.length })}
              </span>
              <span className="text-[11px] text-tx-tertiary hidden sm:inline">
                {t("diary.ctrlEnter")}
              </span>
            </div>
            <button
              onClick={handlePost}
              disabled={!content.trim() || isSubmitting}
              className={cn(
                "flex items-center gap-1.5 px-4 py-1.5 rounded-full text-sm font-medium transition-all",
                content.trim() && !isSubmitting
                  ? "bg-gradient-to-r from-violet-500 to-indigo-500 text-white hover:from-violet-600 hover:to-indigo-600 shadow-sm hover:shadow"
                  : "bg-app-hover text-tx-tertiary cursor-not-allowed"
              )}
            >
              <Send size={14} />
              {isSubmitting ? t("diary.publishing") : t("diary.publish")}
            </button>
          </div>
        </div>

        {/* 时间线 */}
        {isLoading ? (
          <div className="flex justify-center py-16">
            <div className="w-6 h-6 border-2 border-accent-primary border-t-transparent rounded-full animate-spin" />
          </div>
        ) : entries.length === 0 ? (
          <div className="text-center py-16">
            <div className="w-16 h-16 rounded-full bg-app-hover flex items-center justify-center mx-auto mb-4">
              <MessageCircle size={28} className="text-tx-tertiary" />
            </div>
            <p className="text-sm text-tx-tertiary">{t("diary.empty")}</p>
          </div>
        ) : (
          <div className="relative">
            {/* 时间轴竖线 */}
            <div className="absolute left-[19px] top-2 bottom-2 w-[2px] bg-gradient-to-b from-violet-300/60 via-app-border to-transparent dark:from-violet-600/40" />

            <div className="space-y-4">
              {entries.map((entry) => (
                <div key={entry.id} className="relative flex gap-4 group">
                  {/* 时间轴圆点 */}
                  <div className="relative z-10 mt-3 shrink-0">
                    <div className="w-[10px] h-[10px] rounded-full border-[2.5px] border-violet-400 dark:border-violet-500 bg-app-bg ring-4 ring-app-bg" />
                  </div>

                  {/* 卡片内容 */}
                  <div className="flex-1 min-w-0">
                    <div className="bg-app-surface rounded-xl border border-app-border p-4 hover:shadow-sm transition-all">
                      {/* 时间 + 操作 */}
                      <div className="flex items-center justify-between mb-2">
                        <span className="flex items-center gap-1.5 text-[11px] text-tx-tertiary">
                          <Clock size={12} />
                          {formatRelativeTime(entry.createdAt, t)}
                        </span>
                        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                          <button
                            onClick={() => handleStartEdit(entry)}
                            className="p-1 rounded hover:bg-app-hover text-tx-tertiary hover:text-tx-secondary transition-colors"
                            title={t("diary.edit")}
                          >
                            <Edit2 size={13} />
                          </button>
                          <button
                            onClick={() => handleDelete(entry.id)}
                            className="p-1 rounded hover:bg-red-500/10 text-tx-tertiary hover:text-red-500 transition-colors"
                            title={t("common.delete")}
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      </div>

                      {/* 内容区 */}
                      {editingId === entry.id ? (
                        <div>
                          <textarea
                            ref={editTextareaRef}
                            className="w-full bg-app-bg rounded-lg p-3 resize-none outline-none text-tx-primary text-sm leading-relaxed border border-app-border focus:border-accent-primary/50 transition-colors"
                            style={{ minHeight: "80px" }}
                            value={editContent}
                            onChange={(e) => {
                              setEditContent(e.target.value);
                              autoResize(e.target);
                            }}
                            onKeyDown={handleEditKeyDown}
                          />
                          <div className="flex items-center justify-end gap-2 mt-2">
                            <button
                              onClick={() => setEditingId(null)}
                              className="flex items-center gap-1 px-3 py-1 rounded-full text-xs text-tx-secondary hover:bg-app-hover transition-colors"
                            >
                              <X size={12} />
                              {t("diary.cancelEdit")}
                            </button>
                            <button
                              onClick={handleSaveEdit}
                              disabled={!editContent.trim()}
                              className="flex items-center gap-1 px-3 py-1 rounded-full text-xs bg-violet-500 text-white hover:bg-violet-600 disabled:opacity-50 transition-colors"
                            >
                              <Check size={12} />
                              {t("diary.saveEdit")}
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="text-sm text-tx-primary whitespace-pre-wrap leading-relaxed break-words">
                          {entry.content}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
