import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "@/lib/api";
import type { Task } from "@/types";
import { taskRemovalIds, type TaskRemovalMode } from "@/lib/taskRecurrenceRemoval";
import { getOfflineQueueStorageKey } from "@/lib/offlineScope";

export function TaskRecurrenceDeleteDialog({ task, onConfirm, onClose }: {
  task: Task; onConfirm: (mode: TaskRemovalMode) => Promise<void>; onClose: () => void;
}) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<TaskRemovalMode>("single");
  const [tasks, setTasks] = useState([task]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const scope = useRef(getOfflineQueueStorageKey());
  const dialog = useRef<HTMLDivElement>(null);
  const submitting = useRef(false);
  useEffect(() => {
    let active = true;
    const previous = document.activeElement as HTMLElement | null;
    api.getTasks("history").then(rows => { if (active) setTasks(rows); })
      .catch(() => { if (active) setError(t("taskRemoval.rangeFailed")); })
      .finally(() => { if (active) setLoading(false); });
    dialog.current?.querySelector<HTMLInputElement>("input")?.focus();
    return () => { active = false; previous?.focus(); };
  }, [task.id, t]);
  const confirm = async () => {
    if (submitting.current || loading) return;
    if (scope.current !== getOfflineQueueStorageKey()) { setError(t("tasks.lifecycle.scopeChanged")); return; }
    submitting.current = true; setBusy(true); setError("");
    try { await onConfirm(mode); onClose(); }
    catch (error) { setError((error as {code?:string})?.code === "TASK_RECURRENCE_UNSUPPORTED" ? t("taskRemoval.upgradeServer") : error instanceof Error ? error.message : t("tasks.toast.deleteFailed")); }
    finally { submitting.current = false; setBusy(false); }
  };
  const count = taskRemovalIds(tasks,task.id,mode,task.repeatGroupId || task.id).size;
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
    <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="task-removal-title" className="max-h-[calc(100dvh-2rem)] w-full max-w-md space-y-4 overflow-y-auto rounded-xl border border-app-border bg-app-surface p-5 shadow-xl"
      onKeyDown={event => {
        if (event.key === "Escape" && !busy) { event.stopPropagation(); onClose(); }
        if (event.key === "Tab") {
          const controls = dialog.current?.querySelectorAll<HTMLElement>("input:not(:disabled),button:not(:disabled)");
          if (!controls?.length) return;
          const first = controls[0], last = controls[controls.length - 1];
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        }
      }}>
      <h2 id="task-removal-title" className="font-semibold text-tx-primary">{t("taskRemoval.title")}</h2>
      <p className="truncate text-sm text-tx-secondary">{task.title}</p>
      {(["single","stop","series"] as const).map(value => <label key={value} className="flex cursor-pointer gap-3 rounded-md border border-app-border p-3">
        <input type="radio" name="task-removal-mode" value={value} checked={mode === value} onChange={() => setMode(value)} disabled={busy} />
        <span><span className="block text-sm font-medium text-tx-primary">{t(`taskRemoval.${value}`)}</span>
          <span className="block text-xs text-tx-secondary">{t(`taskRemoval.${value}Hint`)}</span></span>
      </label>)}
      <p className="text-sm text-tx-secondary">{t(loading ? "common.loading" : "taskRemoval.range",{count})}</p>
      {mode === "series" && <p className="text-sm text-accent-danger">{t("taskRemoval.seriesWarning")}</p>}
      {error && <p role="alert" className="text-sm text-accent-danger">{error}</p>}
      <div className="flex justify-end gap-2">
        <button disabled={busy} onClick={onClose} className="rounded-md px-3 py-2 text-sm text-tx-secondary">{t("common.cancel")}</button>
        <button disabled={busy || loading} onClick={confirm} className="rounded-md bg-accent-danger px-3 py-2 text-sm text-white disabled:opacity-50">{t(busy ? "common.loading" : mode === "stop" ? "taskRemoval.stop" : "common.delete")}</button>
      </div>
    </div>
  </div>;
}
