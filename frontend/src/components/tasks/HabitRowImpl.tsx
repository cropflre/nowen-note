import React, { useEffect, useState } from "react";
import { Archive, Check, CircleSlash, Minus, RotateCcw, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Habit, HabitCheckinStatus } from "@/types";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/toast";

export function HabitRow({
  habit,
  onCheckin,
  onArchiveToggle,
  onDelete,
}: {
  habit: Habit;
  onCheckin: (habit: Habit, status: HabitCheckinStatus, note: string) => Promise<void> | void;
  onArchiveToggle: (habit: Habit, archived: boolean) => Promise<void> | void;
  onDelete: (habit: Habit) => Promise<void> | void;
}) {
  const { t } = useTranslation();
  const [note, setNote] = useState(habit.todayNote || "");
  const [submitting, setSubmitting] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const canManage = (habit as Habit & { canManage?: boolean }).canManage !== false;
  const isArchived = !!habit.archivedAt;

  useEffect(() => {
    setNote(habit.todayNote || "");
  }, [habit.id, habit.todayNote]);

  const statusLabel: Record<HabitCheckinStatus, string> = {
    success: t("habits.status.success"),
    partial: t("habits.status.partial"),
    failure: t("habits.status.failure"),
  };

  const showActionError = (error: unknown) => {
    console.error("Habit action failed:", error);
    toast.error(error instanceof Error ? error.message : "操作失败，请稍后重试");
  };

  const runCheckin = async (status: HabitCheckinStatus) => {
    if (!canManage || submitting || isArchived) return;
    setSubmitting(true);
    try {
      await onCheckin(habit, status, note);
    } catch (error) {
      showActionError(error);
    } finally {
      setSubmitting(false);
    }
  };

  const runArchiveToggle = async (archived: boolean) => {
    if (!canManage || archiving) return;
    setArchiving(true);
    try {
      await onArchiveToggle(habit, archived);
    } catch (error) {
      showActionError(error);
      setArchiving(false);
    }
  };

  const runDelete = async () => {
    if (!canManage || deleting || archiving || submitting) return;
    setDeleting(true);
    try {
      await onDelete(habit);
    } catch (error) {
      showActionError(error);
      setDeleting(false);
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
            {isArchived && (
              <span className="rounded-full bg-app-hover px-2 py-0.5 text-[10px] text-tx-tertiary">
                {t("habits.status.archived")}
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
            disabled={!canManage || submitting || archiving || deleting || isArchived}
            placeholder={t("habits.notePlaceholder")}
            className="mt-2 w-full rounded-md border border-app-border bg-app-bg px-2.5 py-2 text-xs text-tx-primary placeholder:text-tx-tertiary focus:outline-none focus:border-accent-primary disabled:cursor-not-allowed disabled:opacity-60"
          />
          {canManage && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {!isArchived ? (
                <>
                  <button
                    onClick={() => runCheckin("success")}
                    disabled={submitting || archiving || deleting}
                    className="inline-flex items-center gap-1 rounded-md bg-emerald-500/10 px-2.5 py-1.5 text-xs text-emerald-600 transition-colors hover:bg-emerald-500/20 disabled:opacity-50"
                  >
                    <Check size={13} /> {t("habits.actions.success")}
                  </button>
                  <button
                    onClick={() => runCheckin("partial")}
                    disabled={submitting || archiving || deleting}
                    className="inline-flex items-center gap-1 rounded-md bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-600 transition-colors hover:bg-amber-500/20 disabled:opacity-50"
                  >
                    <Minus size={13} /> {t("habits.actions.partial")}
                  </button>
                  <button
                    onClick={() => runCheckin("failure")}
                    disabled={submitting || archiving || deleting}
                    className="inline-flex items-center gap-1 rounded-md bg-red-500/10 px-2.5 py-1.5 text-xs text-red-600 transition-colors hover:bg-red-500/20 disabled:opacity-50"
                  >
                    <CircleSlash size={13} /> {t("habits.actions.failure")}
                  </button>
                  <button
                    onClick={() => runArchiveToggle(true)}
                    disabled={submitting || archiving || deleting}
                    className="ml-auto inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-xs text-tx-tertiary transition-colors hover:bg-app-hover hover:text-tx-secondary disabled:opacity-50"
                  >
                    <Archive size={13} /> {t("habits.actions.archive")}
                  </button>
                </>
              ) : (
                <>
                  <button
                    onClick={() => runArchiveToggle(false)}
                    disabled={submitting || archiving || deleting}
                    className="inline-flex items-center gap-1 rounded-md bg-sky-500/10 px-2.5 py-1.5 text-xs text-sky-700 transition-colors hover:bg-sky-500/20 disabled:opacity-50"
                  >
                    <RotateCcw size={13} /> {t("habits.actions.unarchive")}
                  </button>
                </>
              )}
              <button
                onClick={runDelete}
                disabled={submitting || archiving || deleting}
                className="inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-xs text-rose-600 transition-colors hover:bg-rose-500/10 disabled:opacity-50"
              >
                <Trash2 size={13} /> {t("habits.actions.delete")}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
