import React, { useState, useCallback } from "react";
import { Sparkles, Loader2, Check, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import type { Task } from "@/types";
import { buildDueAtFromDateAndTime, getDueTimeValue } from "./taskDateUtils";

interface SubtaskSuggestion {
  title: string;
  priority: number;
  dueDate: string | null;
  dueAt?: string | null;
  reason: string;
  selected: boolean;
}

export function TaskAIBreakdown({
  task,
  onCreated,
}: {
  task: Task;
  onCreated: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<SubtaskSuggestion[]>([]);
  const [creating, setCreating] = useState(false);

  const handleBreakdown = useCallback(async () => {
    if (!task.title?.trim()) {
      setError(t("tasks.aiBreakdown.needTitle"));
      return;
    }
    setLoading(true);
    setError(null);
    setSuggestions([]);
    setOpen(true);
    try {
      const lang = i18n.resolvedLanguage || i18n.language;
      const res = await api.aiBreakdownTask(task.id, lang);
      setSuggestions((res.subtasks || []).map((s) => ({ ...s, selected: true })));
    } catch (err: any) {
      setError(err.message || t("tasks.aiBreakdown.failed"));
    } finally {
      setLoading(false);
    }
  }, [task.id, task.title, t, i18n]);

  const toggleSelect = (idx: number) => {
    setSuggestions((prev) => prev.map((s, i) => (i === idx ? { ...s, selected: !s.selected } : s)));
  };

  const updateSuggestion = (idx: number, field: string, value: any) => {
    setSuggestions((prev) => prev.map((s, i) => (i === idx ? { ...s, [field]: value } : s)));
  };

  const handleCreate = async () => {
    const selected = suggestions.filter((s) => s.selected && s.title?.trim());
    if (selected.length === 0) return;
    setCreating(true);
    try {
      for (const s of selected) {
        await api.createTask({
          title: s.title,
          priority: s.priority as 1 | 2 | 3,
          dueDate: s.dueDate || undefined,
          dueAt: s.dueAt || undefined,
          parentId: task.id,
          projectId: task.projectId || undefined,
          status: "todo",
          isCompleted: 0,
        });
      }
      setOpen(false);
      setSuggestions([]);
      onCreated();
    } catch (err: any) {
      setError(err.message || t("tasks.aiBreakdown.failed"));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="space-y-2">
      <button
        onClick={handleBreakdown}
        disabled={loading || !task.title?.trim()}
        className={cn(
          "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all",
          "bg-accent-primary/10 text-accent-primary hover:bg-accent-primary/20",
          "disabled:opacity-50 disabled:cursor-not-allowed"
        )}
      >
        {loading ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
        {t("tasks.aiBreakdown.button")}
      </button>

      {error && (
        <div className="text-xs text-red-500 bg-red-50 dark:bg-red-950/30 px-3 py-2 rounded-lg">
          {error}
        </div>
      )}

      {open && !loading && suggestions.length > 0 && (
        <div className="rounded-lg border border-app-border bg-app-elevated/50 p-3 space-y-2">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs font-medium text-tx-primary">{t("tasks.aiBreakdown.title")}</span>
            <button onClick={() => setOpen(false)} className="text-tx-tertiary hover:text-tx-primary">
              <X size={14} />
            </button>
          </div>

          <div className="space-y-2 max-h-[300px] overflow-y-auto">
            {suggestions.map((s, idx) => (
              <div
                key={idx}
                className={cn(
                  "rounded-md border p-2 space-y-1 transition-colors",
                  s.selected
                    ? "border-accent-primary/30 bg-accent-primary/5"
                    : "border-app-border/50 bg-app-bg opacity-60"
                )}
              >
                <div className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={s.selected}
                    onChange={() => toggleSelect(idx)}
                    className="mt-0.5 accent-accent-primary"
                  />
                  <div className="flex-1 min-w-0 space-y-1">
                    <input
                      type="text"
                      value={s.title}
                      onChange={(e) => updateSuggestion(idx, "title", e.target.value)}
                      className="w-full bg-transparent text-xs text-tx-primary border-b border-app-border/50 focus:border-accent-primary outline-none py-0.5"
                    />
                    <div className="flex items-center gap-2 flex-wrap">
                      <select
                        value={s.priority}
                        onChange={(e) => updateSuggestion(idx, "priority", parseInt(e.target.value))}
                        className="text-[10px] px-1.5 py-0.5 rounded bg-app-bg border border-app-border text-tx-secondary"
                      >
                        <option value={1}>{t("tasks.low")}</option>
                        <option value={2}>{t("tasks.medium")}</option>
                        <option value={3}>{t("tasks.high")}</option>
                      </select>
                      <input
                        type="date"
                        aria-label={t("tasks.dueDate")}
                        value={s.dueDate || ""}
                        onChange={(e) => {
                          updateSuggestion(idx, "dueDate", e.target.value || null);
                          updateSuggestion(idx, "dueAt", buildDueAtFromDateAndTime(e.target.value, getDueTimeValue(s.dueAt)));
                        }}
                        className="text-[10px] px-1.5 py-0.5 rounded bg-app-bg border border-app-border text-tx-secondary"
                      />
                      <input
                        type="time"
                        aria-label={t("tasks.dueAt")}
                        value={getDueTimeValue(s.dueAt)}
                        disabled={!s.dueDate}
                        onChange={(e) => updateSuggestion(idx, "dueAt", buildDueAtFromDateAndTime(s.dueDate, e.target.value))}
                        className="text-[10px] px-1.5 py-0.5 rounded bg-app-bg border border-app-border text-tx-secondary disabled:opacity-40"
                      />
                    </div>
                    {s.reason && <p className="text-[10px] text-tx-tertiary">{s.reason}</p>}
                  </div>
                </div>
              </div>
            ))}
          </div>

          <button
            onClick={handleCreate}
            disabled={creating || !suggestions.some((s) => s.selected)}
            className={cn(
              "w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium transition-all",
              "bg-accent-primary text-white hover:opacity-90",
              "disabled:opacity-50 disabled:cursor-not-allowed"
            )}
          >
            {creating ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
            {t("tasks.aiBreakdown.createSelected")} ({suggestions.filter((s) => s.selected).length})
          </button>
        </div>
      )}

      {open && !loading && suggestions.length === 0 && !error && (
        <div className="text-xs text-tx-tertiary text-center py-2">
          {t("tasks.aiBreakdown.noSuggestions")}
        </div>
      )}
    </div>
  );
}
