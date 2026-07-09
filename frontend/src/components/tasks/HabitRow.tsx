import React, { useState } from "react";
import { Archive, Check, CircleSlash, Minus } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Habit, HabitCheckinStatus } from "@/types";
import { cn } from "@/lib/utils";

export function HabitRow({
  habit,
  onCheckin,
  onArchive,
}: {
  habit: Habit;
  onCheckin: (habit: Habit, status: HabitCheckinStatus, note: string) => Promise<void> | void;
  onArchive: (habit: Habit) => Promise<void> | void;
}) {
  const { t } = useTranslation();
  const [note, setNote] = useState(habit.todayNote || "");
  const [submitting, setSubmitting] = useState(false);
  const statusLabel: Record<HabitCheckinStatus, string> = {
    success: t("habits.status.success"),
    partial: t("habits.status.partial"),
    failure: t("habits.status.failure"),
  };

  const runCheckin = async (status: HabitCheckinStatus) => {
    setSubmitting(true);
    try {
      await onCheckin(habit, status, note);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="rounded-xl border border-app-border bg-app-surface px-4 py-3 shadow-sm">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 h-3 w-3 rounded-full" style={{ backgroundColor: habit.color || "#10b981" }} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <div className="truncate text-sm font-medium text-tx-primary">{habit.title}</div>
            {habit.todayStatus && (
              <span className={cn(
                "rounded-full px-2 py-0.5 text-[10px]",
                habit.todayStatus === "success" && "bg-emerald-500/10 text-emerald-600",
                habit.todayStatus === "partial" && "bg-amber-500/10 text-amber-600",
                habit.todayStatus === "failure" && "bg-red-500/10 text-red-600",
              )}>
                {statusLabel[habit.todayStatus]}
              </span>
            )}
            {habit.creatorName && (
              <span className="text-[10px] text-tx-tertiary">{habit.creatorName}</span>
            )}
          </div>
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={t("habits.notePlaceholder")}
            className="mt-2 w-full rounded-md border border-app-border bg-app-bg px-2.5 py-2 text-xs text-tx-primary placeholder:text-tx-tertiary focus:outline-none focus:border-accent-primary"
          />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              onClick={() => runCheckin("success")}
              disabled={submitting}
              className="inline-flex items-center gap-1 rounded-md bg-emerald-500/10 px-2.5 py-1.5 text-xs text-emerald-600 transition-colors hover:bg-emerald-500/20 disabled:opacity-50"
            >
              <Check size={13} /> {t("habits.actions.success")}
            </button>
            <button
              onClick={() => runCheckin("partial")}
              disabled={submitting}
              className="inline-flex items-center gap-1 rounded-md bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-600 transition-colors hover:bg-amber-500/20 disabled:opacity-50"
            >
              <Minus size={13} /> {t("habits.actions.partial")}
            </button>
            <button
              onClick={() => runCheckin("failure")}
              disabled={submitting}
              className="inline-flex items-center gap-1 rounded-md bg-red-500/10 px-2.5 py-1.5 text-xs text-red-600 transition-colors hover:bg-red-500/20 disabled:opacity-50"
            >
              <CircleSlash size={13} /> {t("habits.actions.failure")}
            </button>
            <button
              onClick={() => onArchive(habit)}
              className="ml-auto inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-xs text-tx-tertiary transition-colors hover:bg-app-hover hover:text-tx-secondary"
            >
              <Archive size={13} /> {t("habits.actions.archive")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}