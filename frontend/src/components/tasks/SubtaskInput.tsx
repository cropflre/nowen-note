import React, { useState, useRef, useEffect } from "react";
import { Plus, Check, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type { Task } from "@/types";
import { buildDueAtFromDateAndTime } from "./taskDateUtils";

export type SubtaskSchedule = Pick<Task, "dueDate" | "dueAt">;

/**
 * 轻量 inline 子任务输入框。
 * 用于 TaskTreeRow / FlatTaskRow 中快速新增子任务。
 */
export function SubtaskInput({
  parentId,
  onSubmit,
  onCancel,
}: {
  parentId: string;
  onSubmit: (title: string, parentId: string, schedule?: SubtaskSchedule) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [dueTime, setDueTime] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSubmit = async () => {
    if (!value.trim() || submitting) return;
    setSubmitting(true);
    try {
      await onSubmit(value.trim(), parentId, dueDate ? {
        dueDate, dueAt: buildDueAtFromDateAndTime(dueDate, dueTime),
      } : undefined);
      setValue("");
      setDueDate("");
      setDueTime("");
      // 保持焦点，方便连续新增
      inputRef.current?.focus();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-1.5 pl-8 pr-4 py-1.5">
      <div className="flex items-center gap-2">
        <Plus size={14} className="text-tx-tertiary flex-shrink-0" />
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSubmit();
            if (e.key === "Escape") onCancel();
          }}
          placeholder={t('tasks.addChildPlaceholder')}
          disabled={submitting}
          className="flex-1 min-w-0 bg-transparent text-sm text-tx-primary placeholder:text-tx-tertiary focus:outline-none border-b border-app-border focus:border-accent-primary transition-colors py-1"
        />
        <button type="button" aria-label={t("tasks.add")} disabled={!value.trim() || submitting}
          onClick={handleSubmit} className="flex-shrink-0 p-0.5 text-accent-primary disabled:opacity-40">
          <Check size={14} />
        </button>
        <button
          type="button"
          aria-label={t("common.cancel")}
          onClick={onCancel}
          className="flex-shrink-0 p-0.5 rounded hover:bg-app-hover text-tx-tertiary transition-colors"
        >
          <X size={14} />
        </button>
      </div>
      <div className="flex gap-2 pl-5">
        <input type="date" aria-label={t("tasks.dueDate")} value={dueDate} disabled={submitting}
          onChange={(event) => { setDueDate(event.target.value); if (!event.target.value) setDueTime(""); }}
          className="min-w-0 w-full flex-1 rounded border border-app-border bg-app-bg px-1.5 py-1 text-xs text-tx-secondary" />
        <input type="time" aria-label={t("tasks.dueAt")} value={dueTime} disabled={!dueDate || submitting}
          onChange={(event) => setDueTime(event.target.value)}
          className="min-w-0 w-full flex-1 rounded border border-app-border bg-app-bg px-1.5 py-1 text-xs text-tx-secondary disabled:opacity-40" />
      </div>
    </div>
  );
}
