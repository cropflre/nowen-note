import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { addDays, eachDayOfInterval, endOfMonth, endOfWeek, endOfYear, format, isSameMonth, isToday, startOfMonth, startOfWeek, startOfYear, subWeeks } from "date-fns";
import { enUS, zhCN } from "date-fns/locale";
import { CalendarDays, CheckCircle2, Clock3, Flame, FolderOpen, ListChecks, RefreshCw, SquareCheckBig, TrendingUp } from "lucide-react";
import { api, type TaskActivityEvent } from "@/lib/api";
import type { Habit, HabitCheckinListItem, HabitStats, Task, TaskProject, TaskStats } from "@/types";
import { cn } from "@/lib/utils";

type Primary = "overview" | "tasks" | "habits";
type TaskTab = "overview" | "details" | "records" | "trends" | "heatmap";
type HabitTab = "overview" | "log" | "week" | "month" | "year";
type Props = { tasks: Task[]; projects: TaskProject[]; taskStats: TaskStats | null; habits: Habit[]; habitStats: HabitStats | null; checkins: HabitCheckinListItem[]; loading: boolean; onRefresh: () => void };

function parseDateValue(value?: string | null): Date | null {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const date = new Date(`${value}T00:00:00`);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const normalized = value.replace(" ", "T");
  const date = new Date(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized) ? normalized : `${normalized}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}
const keyOf = (date: Date) => format(date, "yyyy-MM-dd");
const pct = (part: number, total: number) => total ? Math.round(part / total * 100) : 0;
const heat = (n: number) => n <= 0 ? "bg-app-border/60" : n === 1 ? "bg-emerald-200" : n === 2 ? "bg-emerald-300" : n === 3 ? "bg-emerald-400" : "bg-emerald-600";
const statusClass = (s?: string | null) => s === "success" ? "bg-emerald-500/15 text-emerald-700" : s === "partial" ? "bg-amber-500/15 text-amber-700" : s === "failure" ? "bg-rose-500/15 text-rose-700" : "bg-app-hover text-tx-tertiary";

function Tabs<T extends string>({ value, values, onChange }: { value: T; values: Array<[T, string]>; onChange: (v: T) => void }) {
  return <div className="flex flex-wrap gap-2">{values.map(([v, label]) => <button key={v} onClick={() => onChange(v)} className={cn("rounded-full px-3 py-1.5 text-xs", value === v ? "bg-accent-primary text-white" : "bg-app-hover text-tx-secondary")}>{label}</button>)}</div>;
}
function Card({ icon, label, value, hint }: { icon: React.ReactNode; label: string; value: React.ReactNode; hint?: string }) {
  return <div className="rounded-xl border border-app-border bg-app-surface p-4 shadow-sm"><div className="flex justify-between gap-3"><div><div className="text-xs text-tx-tertiary">{label}</div><div className="mt-1 text-2xl font-semibold text-tx-primary">{value}</div>{hint && <div className="mt-1 text-xs text-tx-tertiary">{hint}</div>}</div><div className="text-accent-primary">{icon}</div></div></div>;
}
const Empty = ({ text }: { text: string }) => <div className="flex min-h-52 items-center justify-center rounded-xl border border-dashed border-app-border text-sm text-tx-tertiary">{text}</div>;
function snapshotEvents(tasks: Task[]): TaskActivityEvent[] {
  return tasks.flatMap((task) => [
    task.createdAt ? { id: `created-${task.id}`, taskId: task.id, taskTitle: task.title, eventType: "created" as const, userId: task.userId, workspaceId: task.workspaceId, projectId: task.projectId, occurredAt: task.createdAt, createdAt: task.createdAt } : null,
    task.completedAt ? { id: `completed-${task.id}`, taskId: task.id, taskTitle: task.title, eventType: "completed" as const, userId: task.userId, workspaceId: task.workspaceId, projectId: task.projectId, occurredAt: task.completedAt, createdAt: task.completedAt } : null,
  ].filter(Boolean) as TaskActivityEvent[]);
}

export function StatsCenter({ tasks, projects, taskStats, habits, habitStats, checkins, loading, onRefresh }: Props) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language === "zh-CN" ? zhCN : enUS;
  const [primary, setPrimary] = useState<Primary>("overview");
  const [taskTab, setTaskTab] = useState<TaskTab>("overview");
  const [habitTab, setHabitTab] = useState<HabitTab>("overview");
  const [remoteEvents, setRemoteEvents] = useState<TaskActivityEvent[]>([]);
  const [eventsLoading, setEventsLoading] = useState(false);
  const requestId = useRef(0);
  const today = new Date();
  const year = today.getFullYear();

  const loadEvents = useCallback(async () => {
    const id = ++requestId.current;
    setEventsLoading(true);
    try {
      const rows = await api.getTaskActivityEvents({ from: `${year}-01-01`, to: `${year}-12-31`, limit: 10000 });
      if (id === requestId.current) setRemoteEvents(rows);
    } catch (error) {
      if (id === requestId.current) setRemoteEvents([]);
      console.warn("[stats] activity history fallback", error);
    } finally {
      if (id === requestId.current) setEventsLoading(false);
    }
  }, [year]);
  useEffect(() => { void loadEvents(); return () => { requestId.current += 1; }; }, [loadEvents]);

  const events = useMemo(() => {
    const rows = [...remoteEvents];
    const seen = new Set(rows.map((e) => `${e.taskId}\u001f${e.eventType}`));
    snapshotEvents(tasks).forEach((e) => { if (!seen.has(`${e.taskId}\u001f${e.eventType}`)) rows.push(e); });
    return rows.filter((e) => parseDateValue(e.occurredAt)).sort((a, b) => parseDateValue(b.occurredAt)!.getTime() - parseDateValue(a.occurredAt)!.getTime());
  }, [remoteEvents, tasks]);
  const recentEvents = events.slice(0, 80);
  const activeHabits = habits.filter((h) => !h.archivedAt);
  const archivedHabits = habits.filter((h) => h.archivedAt);
  const byDay = useMemo(() => { const map = new Map<string, HabitCheckinListItem[]>(); checkins.forEach((c) => map.set(c.checkinDate, [...(map.get(c.checkinDate) || []), c])); return map; }, [checkins]);
  const overdue = tasks.filter((task) => { const due = parseDateValue(task.dueAt || (task.dueDate ? `${task.dueDate}T23:59:59` : null)); return !task.isCompleted && !!due && due < today; }).length;
  const completionRate = pct(taskStats?.completed || 0, taskStats?.total || 0);
  const projectRows = useMemo(() => { const names = new Map(projects.map((p) => [p.id, p.name])); const groups = new Map<string, { label: string; total: number; done: number }>(); tasks.forEach((task) => { const id = task.projectId || "none"; const row = groups.get(id) || { label: task.projectId ? names.get(task.projectId) || t("stats.task.projectAssigned", { defaultValue: "已归类项目" }) : t("tasks.noProject"), total: 0, done: 0 }; row.total++; if (task.isCompleted) row.done++; groups.set(id, row); }); return [...groups.entries()]; }, [projects, tasks, t]);
  const trends = useMemo(() => Array.from({ length: 12 }, (_, i) => { const start = startOfWeek(subWeeks(today, 11 - i), { weekStartsOn: 1 }); const end = endOfWeek(start, { weekStartsOn: 1 }); const rows = events.filter((e) => { const d = parseDateValue(e.occurredAt); return d && d >= start && d <= end; }); return { key: keyOf(start), label: format(start, "MM/dd", { locale }), created: rows.filter((e) => e.eventType === "created").length, completed: rows.filter((e) => e.eventType === "completed").length }; }), [events, locale, year]);
  const heatmap = useMemo(() => { const counts = new Map<string, number>(); events.filter((e) => e.eventType === "completed").forEach((e) => { const d = parseDateValue(e.occurredAt); if (d?.getFullYear() === year) counts.set(keyOf(d), (counts.get(keyOf(d)) || 0) + 1); }); const days = eachDayOfInterval({ start: startOfWeek(startOfYear(today), { weekStartsOn: 1 }), end: endOfWeek(endOfYear(today), { weekStartsOn: 1 }) }); return Array.from({ length: Math.ceil(days.length / 7) }, (_, i) => days.slice(i * 7, i * 7 + 7).map((date) => ({ date, count: counts.get(keyOf(date)) || 0 }))); }, [events, year]);
  const week = Array.from({ length: 7 }, (_, i) => addDays(startOfWeek(today, { weekStartsOn: 1 }), i));
  const month = eachDayOfInterval({ start: startOfWeek(startOfMonth(today), { weekStartsOn: 1 }), end: endOfWeek(endOfMonth(today), { weekStartsOn: 1 }) });
  const months = Array.from({ length: 12 }, (_, i) => { const d = new Date(year, i, 1); const key = format(d, "yyyy-MM"); const rows = checkins.filter((c) => c.checkinDate.startsWith(key)); return { key, label: format(d, "MMM", { locale }), rows }; });

  const overview = <div className="space-y-4"><div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4"><Card icon={<SquareCheckBig />} label={t("stats.overview.totalTasks")} value={taskStats?.total ?? tasks.length} hint={t("stats.overview.taskCompletion", { percent: completionRate })} /><Card icon={<Clock3 />} label={t("stats.overview.pendingTasks")} value={taskStats?.pending ?? tasks.filter((x) => !x.isCompleted).length} hint={t("stats.overview.overdueTasks", { count: overdue })} /><Card icon={<ListChecks />} label={t("stats.overview.activeHabits")} value={activeHabits.length} hint={t("stats.overview.archivedHabits", { count: archivedHabits.length })} /><Card icon={<Flame />} label={t("stats.overview.currentHabitStreak")} value={habitStats?.currentStreak ?? 0} hint={t("stats.overview.totalCheckins", { count: habitStats?.totalCheckins ?? 0 })} /></div><div className="grid gap-4 xl:grid-cols-2"><div className="rounded-xl border border-app-border p-4"><h3>{t("stats.overview.recentTaskActivity")}</h3>{recentEvents.slice(0, 6).map((e) => <div key={e.id} className="mt-2 flex justify-between rounded-lg bg-app-bg p-2"><span>{e.taskTitle}</span><span className="text-xs text-tx-tertiary">{e.eventType === "completed" ? t("stats.task.recordCompleted") : t("stats.task.recordCreated")}</span></div>)}</div><div className="rounded-xl border border-app-border p-4"><h3>{t("stats.overview.recentHabitActivity")}</h3>{checkins.slice(0, 6).map((c) => <div key={c.id} className="mt-2 flex justify-between rounded-lg bg-app-bg p-2"><span>{c.habitTitle}</span><span>{c.checkinDate}</span></div>)}</div></div></div>;

  const taskOverview = <div className="space-y-4"><div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4"><Card icon={<SquareCheckBig />} label={t("stats.task.total")} value={taskStats?.total ?? tasks.length} /><Card icon={<TrendingUp />} label={t("stats.task.completionRate")} value={`${completionRate}%`} /><Card icon={<Clock3 />} label={t("stats.task.overdue")} value={overdue} /><Card icon={<FolderOpen />} label={t("stats.task.projectCoverage")} value={`${pct(tasks.filter((x) => x.projectId).length, tasks.length)}%`} /></div><div className="rounded-xl border border-app-border p-4"><h3>{t("stats.task.projectBreakdown")}</h3>{projectRows.map(([id, row]) => <div key={id} className="mt-2 flex justify-between rounded-lg bg-app-bg p-2"><span>{row.label}</span><span>{row.done}/{row.total}</span></div>)}</div></div>;
  const details = tasks.length ? <div className="overflow-x-auto rounded-xl border"><table className="min-w-full text-sm"><thead><tr><th>{t("tasks.taskTitle")}</th><th>{t("tasks.status")}</th><th>{t("stats.task.completedAt")}</th></tr></thead><tbody>{tasks.slice(0, 200).map((x) => <tr key={x.id}><td>{x.title}</td><td>{x.status}</td><td>{x.completedAt || "-"}</td></tr>)}</tbody></table></div> : <Empty text={t("stats.task.empty")} />;
  const records = recentEvents.length ? <div className="space-y-2">{recentEvents.map((e) => <div key={e.id} className="flex justify-between rounded-xl border p-3"><div><div>{e.taskTitle}</div><div className="text-xs text-tx-tertiary">{e.eventType === "completed" ? t("stats.task.recordCompleted") : t("stats.task.recordCreated")}</div></div><span className="text-xs">{format(parseDateValue(e.occurredAt)!, "yyyy-MM-dd HH:mm", { locale })}</span></div>)}</div> : <Empty text={t("stats.task.noRecords")} />;
  const trendView = <div className="rounded-xl border p-4"><h3>{t("stats.task.trendTitle")}</h3>{trends.map((row) => <div key={row.key} className="mt-3 flex justify-between"><span>{row.label}</span><span>{t("stats.task.trendLegend", { created: row.created, completed: row.completed })}</span></div>)}</div>;
  const heatView = <div className="rounded-xl border p-4"><h3>{t("stats.task.heatmapTitle")}</h3><div className="mt-4 flex gap-1 overflow-x-auto">{heatmap.map((week, i) => <div key={i} className="grid grid-rows-7 gap-1">{week.map((cell) => <div key={cell.date.toISOString()} title={`${keyOf(cell.date)} · ${cell.count}`} className={cn("h-3 w-3 rounded", cell.date.getFullYear() === year ? heat(cell.count) : "bg-transparent")} />)}</div>)}</div></div>;

  const habitOverview = <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4"><Card icon={<ListChecks />} label={t("stats.habit.habitCount")} value={habits.length} /><Card icon={<Flame />} label={t("stats.habit.currentStreak")} value={habitStats?.currentStreak ?? 0} /><Card icon={<CheckCircle2 />} label={t("stats.habit.successRate")} value={`${pct((habitStats?.successCount || 0) + (habitStats?.partialCount || 0), habitStats?.totalCheckins || 0)}%`} /><Card icon={<CalendarDays />} label={t("stats.habit.todayCheckins")} value={byDay.get(keyOf(today))?.length || 0} /></div>;
  const log = checkins.length ? <div className="space-y-2">{checkins.slice(0, 80).map((c) => <div key={c.id} className="flex justify-between rounded-xl border p-3"><div><div>{c.habitTitle}</div><div className="text-xs">{c.note || t("stats.habit.emptyNote")}</div></div><span className={cn("rounded-full px-2 py-1 text-xs", statusClass(c.status))}>{t(`habits.status.${c.status}`)}</span></div>)}</div> : <Empty text={t("stats.habit.noLogs")} />;
  const weekView = activeHabits.length ? <div className="overflow-x-auto"><table className="min-w-full"><thead><tr><th>{t("habits.title")}</th>{week.map((d) => <th key={d.toISOString()}>{format(d, "EE dd", { locale })}</th>)}</tr></thead><tbody>{activeHabits.map((h) => <tr key={h.id}><td>{h.title}</td>{week.map((d) => { const c = (byDay.get(keyOf(d)) || []).find((x) => x.habitId === h.id); return <td key={d.toISOString()}>{c ? t(`habits.status.${c.status}`) : t("stats.habit.noCheckin")}</td>; })}</tr>)}</tbody></table></div> : <Empty text={t("stats.habit.noActiveHabits")} />;
  const monthView = <div className="rounded-xl border p-4"><h3>{t("stats.habit.monthTitle")}</h3><p>{format(today, "yyyy MMMM", { locale })}</p><div className="mt-3 grid grid-cols-7 gap-2">{month.map((d) => { const rows = byDay.get(keyOf(d)) || []; return <div key={d.toISOString()} title={`${keyOf(d)} · ${rows.length}`} className={cn("min-h-20 rounded-lg border p-2", !isSameMonth(d, today) && "opacity-40", isToday(d) && "ring-1 ring-accent-primary")}><div>{format(d, "d")}</div><div>{rows.length}</div></div>; })}</div></div>;
  const yearView = <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">{months.map((m) => <div key={m.key} className="rounded-xl border p-4"><div>{m.label}</div><div className="text-2xl">{m.rows.length}</div><div className="grid grid-cols-3 text-xs"><span>{m.rows.filter((x) => x.status === "success").length}</span><span>{m.rows.filter((x) => x.status === "partial").length}</span><span>{m.rows.filter((x) => x.status === "failure").length}</span></div></div>)}</div>;

  const refresh = () => { onRefresh(); void loadEvents(); };
  return <div className="flex-1 overflow-y-auto px-4 py-3 md:px-5"><div className="mb-4 flex justify-between rounded-xl border p-4"><div><h2 className="text-lg font-bold">{t("stats.title")}</h2><p className="text-xs text-tx-tertiary">{t("stats.subtitle")}</p></div><button onClick={refresh} disabled={loading || eventsLoading}><RefreshCw className={eventsLoading ? "animate-spin" : ""} />{t("stats.refresh")}</button></div><div className="space-y-4"><Tabs value={primary} onChange={setPrimary} values={[["overview", t("stats.tabs.overview")], ["tasks", t("stats.tabs.tasks")], ["habits", t("stats.tabs.habits")]]} />{loading ? <Empty text={t("stats.loading")} /> : primary === "overview" ? overview : primary === "tasks" ? <div className="space-y-4"><Tabs value={taskTab} onChange={setTaskTab} values={[["overview", t("stats.task.tabs.overview")], ["details", t("stats.task.tabs.details")], ["records", t("stats.task.tabs.records")], ["trends", t("stats.task.tabs.trends")], ["heatmap", t("stats.task.tabs.heatmap")]]} />{taskTab === "overview" ? taskOverview : taskTab === "details" ? details : taskTab === "records" ? records : taskTab === "trends" ? trendView : heatView}</div> : <div className="space-y-4"><Tabs value={habitTab} onChange={setHabitTab} values={[["overview", t("stats.habit.tabs.overview")], ["log", t("stats.habit.tabs.log")], ["week", t("stats.habit.tabs.week")], ["month", t("stats.habit.tabs.month")], ["year", t("stats.habit.tabs.year")]]} />{habitTab === "overview" ? habitOverview : habitTab === "log" ? log : habitTab === "week" ? weekView : habitTab === "month" ? monthView : yearView}</div>}</div></div>;
}

export const statsCenterTestUtils = { parseDateValue, snapshotEvents };
