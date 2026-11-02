import { useTranslation } from "react-i18next";
import type { AgentTaskDraft } from "@/lib/agentWorkflow";

export default function AgentTaskDrafts({ tasks, timezone, disabled, onChange }: { tasks: AgentTaskDraft[]; timezone: string; disabled: boolean; onChange: (tasks: AgentTaskDraft[]) => void }) {
  const { t } = useTranslation();
  const field = "mt-1 w-full min-w-0 rounded border border-app-border bg-app-bg p-2 text-sm disabled:opacity-60";
  const update = (id: string, patch: Partial<AgentTaskDraft>) => onChange(tasks.map(task => task.clientId === id ? { ...task, ...patch } : task));
  return <div className="space-y-3">
    <p className="text-sm" role="status">{t("taskComposer.count", { selected: tasks.filter(task => task.selected).length, total: tasks.length })}</p>
    {!tasks.some(task => task.selected) && <p className="text-xs text-tx-secondary">{t("agent.workflow.noTasksSelected")}</p>}
    {tasks.map((task, index) => {
      const label = (key: string) => `${t(`taskComposer.${key}`)} ${index + 1}`;
      return <fieldset key={task.clientId} aria-label={label("candidate")} disabled={disabled} className="min-w-0 space-y-2 rounded border border-app-border p-3">
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" aria-label={label("select")} checked={task.selected} onChange={e => update(task.clientId, { selected: e.target.checked })} />{t("taskComposer.select")} {index + 1}</label>
        <fieldset disabled={!task.selected} className="min-w-0 space-y-2">
          <label className="block text-xs">{t("taskComposer.taskTitle")}<input className={field} aria-label={label("taskTitle")} maxLength={200} value={task.title} onChange={e => update(task.clientId, { title: e.target.value })} /></label>
          <label className="block text-xs">{t("taskComposer.description")}<textarea className={field} aria-label={label("description")} rows={2} maxLength={4000} value={task.description} onChange={e => update(task.clientId, { description: e.target.value })} /></label>
          <label className="block text-xs">{t("taskComposer.priority")}<select className={field} aria-label={label("priority")} value={task.priority} onChange={e => update(task.clientId, { priority: Number(e.target.value) as 1 | 2 | 3 })}>{([1, 2, 3] as const).map(value => <option key={value} value={value}>{t(`tasks.${["", "low", "medium", "high"][value]}`)}</option>)}</select></label>
          <p className="text-xs text-tx-secondary">{t("agent.workflow.taskDetails", { priority: task.priority, start: task.startDate || "—", due: task.dueAt || task.dueDate || "—", repeat: t(`taskComposer.repeat.${task.repeatRule}`) })}</p>
          <p className="text-xs text-tx-secondary">{t("agent.workflow.repeatDetails", { timezone, interval: task.repeatInterval, end: task.repeatEndDate || "—", repeatCount: task.repeatEndCount || "—" })}</p>
          <details><summary className="cursor-pointer text-xs">{t("agent.workflow.taskSchedule")}</summary><div className="mt-2 grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
            <label className="min-w-0 text-xs">{t("taskComposer.startDate")}<input className={field} type="date" aria-label={label("startDate")} value={task.startDate?.slice(0, 10) || ""} onChange={e => update(task.clientId, { startDate: e.target.value ? e.target.value + (task.startDate?.includes("T") ? task.startDate.slice(10) : "") : null })} /></label>
            <label className="min-w-0 text-xs">{t("taskComposer.startTime")}<input className={field} type="time" aria-label={label("startTime")} disabled={!task.startDate} value={task.startDate?.split("T")[1] || ""} onChange={e => update(task.clientId, { startDate: `${task.startDate!.slice(0, 10)}${e.target.value ? "T" + e.target.value : ""}` })} /></label>
            <label className="min-w-0 text-xs">{t("taskComposer.dueDate")}<input className={field} type="date" aria-label={label("dueDate")} value={task.dueDate || ""} onChange={e => update(task.clientId, { dueDate: e.target.value || null, dueAt: e.target.value && task.dueAt ? e.target.value + task.dueAt.slice(10) : null })} /></label>
            <label className="min-w-0 text-xs">{t("taskComposer.dueTime")}<input className={field} type="time" aria-label={label("dueTime")} disabled={!task.dueDate} value={task.dueAt?.split("T")[1] || ""} onChange={e => update(task.clientId, { dueAt: e.target.value ? `${task.dueDate}T${e.target.value}` : null })} /></label>
            <label className="min-w-0 text-xs">{t("taskComposer.repeatRule")}<select className={field} aria-label={label("repeatRule")} value={task.repeatRule} onChange={e => update(task.clientId, { repeatRule: e.target.value as AgentTaskDraft["repeatRule"], ...(e.target.value === "none" ? { repeatEndDate: null, repeatEndCount: null } : {}) })}>{["none", "daily", "weekly", "monthly", "yearly"].map(rule => <option key={rule} value={rule}>{t(`taskComposer.repeat.${rule}`)}</option>)}</select></label>
            {task.repeatRule !== "none" && <>
              <label className="min-w-0 text-xs">{t("taskComposer.repeatInterval")}<input className={field} type="number" min={1} max={365} aria-label={label("repeatInterval")} value={task.repeatInterval} onChange={e => update(task.clientId, { repeatInterval: Number(e.target.value) })} /></label>
              <label className="min-w-0 text-xs">{t("taskComposer.repeatEndDate")}<input className={field} type="date" aria-label={label("repeatEndDate")} value={task.repeatEndDate || ""} onChange={e => update(task.clientId, { repeatEndDate: e.target.value || null })} /></label>
              <label className="min-w-0 text-xs">{t("taskComposer.repeatEndCount")}<input className={field} type="number" min={1} max={999} aria-label={label("repeatEndCount")} value={task.repeatEndCount || ""} onChange={e => update(task.clientId, { repeatEndCount: e.target.value ? Number(e.target.value) : null })} /></label>
            </>}
          </div></details>
        </fieldset>
      </fieldset>;
    })}
  </div>;
}
