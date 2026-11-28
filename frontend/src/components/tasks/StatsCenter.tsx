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
type ProjectRow = [string, { label: string; total: number; done: number }];

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
  return <div className="inline-flex max-w-full flex-wrap gap-1 rounded-2xl border border-app-border/75 bg-app-surface/80 p-1 shadow-sm backdrop-blur-md">{values.map(([v, label]) => <button key={v} onClick={() => onChange(v)} className={cn("rounded-xl px-3.5 py-1.5 text-xs font-semibold transition-all duration-150", value === v ? "bg-app-elevated text-accent-primary shadow-[0_2px_0_rgba(15,23,42,0.06),0_6px_14px_-4px_rgba(99,102,241,0.22)] ring-1 ring-accent-primary/20 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.1)]" : "text-tx-tertiary hover:bg-app-hover/65 hover:text-tx-primary")}>{label}</button>)}</div>;
}
function Card({ icon, label, value, hint, tone = "blue" }: { icon: React.ReactNode; label: string; value: React.ReactNode; hint?: string; tone?: "blue" | "amber" | "emerald" | "rose" }) {
  const tones = {
    blue: "bg-indigo-500/12 text-indigo-600 ring-1 ring-inset ring-indigo-500/20 dark:text-indigo-300",
    amber: "bg-amber-500/12 text-amber-600 ring-1 ring-inset ring-amber-500/20 dark:text-amber-300",
    emerald: "bg-emerald-500/12 text-emerald-600 ring-1 ring-inset ring-emerald-500/20 dark:text-emerald-300",
    rose: "bg-rose-500/12 text-rose-600 ring-1 ring-inset ring-rose-500/20 dark:text-rose-300",
  };
  return <div className="rounded-2xl border border-app-border/75 bg-app-surface/85 p-4 shadow-sm backdrop-blur-md transition-all duration-200 hover:-translate-y-0.5 hover:border-accent-primary/35 hover:shadow-md"><div className="flex items-start justify-between gap-3"><div><div className="text-xs font-semibold text-tx-tertiary">{label}</div><div className="mt-2 font-mono text-2xl font-bold tracking-tight tabular-nums text-tx-primary">{value}</div>{hint && <div className="mt-1.5 text-xs text-tx-tertiary">{hint}</div>}</div><div className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl", tones[tone])}>{icon}</div></div></div>;
}
const Empty = ({ text }: { text: string }) => <div className="flex min-h-52 items-center justify-center rounded-2xl border border-dashed border-app-border/80 bg-app-surface/50 text-sm text-tx-tertiary">{text}</div>;

function SectionCard({ title, description, children, className }: { title: string; description?: string; children: React.ReactNode; className?: string }) {
  return <section className={cn("rounded-2xl border border-app-border/75 bg-app-surface/85 p-5 shadow-sm backdrop-blur-md", className)}><div className="mb-4"><h3 className="text-sm font-bold tracking-tight text-tx-primary">{title}</h3>{description && <p className="mt-1 text-xs text-tx-tertiary">{description}</p>}</div>{children}</section>;
}

function CompletionSummary({ rate, completed, total, label }: { rate: number; completed: number; total: number; label: string }) {
  return <div data-testid="stats-completion-summary" className="flex items-center gap-3 rounded-2xl border border-white/20 bg-white/10 px-3 py-2.5 backdrop-blur-sm"><div className="relative grid h-12 w-12 place-items-center rounded-full" style={{ background: `conic-gradient(rgb(var(--accent-primary-rgb, 59 130 246)) ${rate * 3.6}deg, rgba(255, 255, 255, 0.25) 0deg)` }}><div className="grid h-9 w-9 place-items-center rounded-full bg-app-surface text-xs font-bold text-tx-primary">{rate}%</div></div><div><div className="text-xs text-tx-secondary">{label}</div><div className="mt-0.5 text-sm font-semibold text-tx-primary">{completed} / {total}</div></div></div>;
}

function ActivityPanel({ title, description, emptyText, items }: { title: string; description: string; emptyText: string; items: Array<{ id: string; title: string; detail: string; date?: string; completed?: boolean }> }) {
  return <SectionCard title={title} description={description}>{items.length ? <div className="divide-y divide-app-border/70">{items.map((item) => <div key={item.id} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0"><div className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-xl", item.completed ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-300" : "bg-blue-500/10 text-blue-600 dark:text-blue-300")}>{item.completed ? <CheckCircle2 size={16} /> : <ListChecks size={16} />}</div><div className="min-w-0 flex-1"><div className="truncate text-sm font-medium text-tx-primary">{item.title}</div><div className="mt-0.5 truncate text-xs text-tx-tertiary">{item.detail}</div></div>{item.date && <time className="shrink-0 text-xs text-tx-tertiary">{item.date}</time>}</div>)}</div> : <div className="grid min-h-40 place-items-center rounded-xl bg-app-bg text-sm text-tx-tertiary">{emptyText}</div>}</SectionCard>;
}

function ProjectProgress({ rows }: { rows: ProjectRow[] }) {
  return <div data-testid="stats-project-progress" className="space-y-4">{rows.map(([id, row]) => { const rate = pct(row.done, row.total); return <div key={id}><div className="mb-1.5 flex items-center justify-between gap-3 text-sm"><span className="truncate font-medium text-tx-primary">{row.label}</span><span className="shrink-0 text-xs text-tx-tertiary">{row.done}/{row.total} · {rate}%</span></div><div className="h-2 overflow-hidden rounded-full bg-app-bg"><div className="h-full rounded-full bg-gradient-to-r from-accent-primary to-violet-400 transition-all" style={{ width: `${rate}%` }} /></div></div>; })}</div>;
}
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

  const overview = <div className="space-y-4"><div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4"><Card icon={<SquareCheckBig size={18} />} label={t("stats.overview.totalTasks")} value={taskStats?.total ?? tasks.length} hint={t("stats.overview.taskCompletion", { percent: completionRate })} /><Card icon={<Clock3 size={18} />} label={t("stats.overview.pendingTasks")} value={taskStats?.pending ?? tasks.filter((x) => !x.isCompleted).length} hint={t("stats.overview.overdueTasks", { count: overdue })} tone={overdue ? "rose" : "amber"} /><Card icon={<ListChecks size={18} />} label={t("stats.overview.activeHabits")} value={activeHabits.length} hint={t("stats.overview.archivedHabits", { count: archivedHabits.length })} tone="emerald" /><Card icon={<Flame size={18} />} label={t("stats.overview.currentHabitStreak")} value={habitStats?.currentStreak ?? 0} hint={t("stats.overview.totalCheckins", { count: habitStats?.totalCheckins ?? 0 })} tone="amber" /></div><div className="grid gap-4 xl:grid-cols-2"><ActivityPanel title={t("stats.overview.recentTaskActivity")} description={t("stats.overview.recentTaskActivityDesc")} emptyText={t("stats.task.noRecords")} items={recentEvents.slice(0, 6).map((e) => ({ id: e.id, title: e.taskTitle, detail: e.eventType === "completed" ? t("stats.task.recordCompleted") : t("stats.task.recordCreated"), date: format(parseDateValue(e.occurredAt)!, "MM/dd HH:mm", { locale }), completed: e.eventType === "completed" }))} /><ActivityPanel title={t("stats.overview.recentHabitActivity")} description={t("stats.overview.recentHabitActivityDesc")} emptyText={t("stats.habit.noLogs")} items={checkins.slice(0, 6).map((c) => ({ id: c.id, title: c.habitTitle, detail: c.note || t("stats.habit.emptyNote"), date: c.checkinDate, completed: c.status === "success" }))} /></div></div>;

  const taskOverview = <div className="space-y-4"><div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4"><Card icon={<SquareCheckBig size={18} />} label={t("stats.task.total")} value={taskStats?.total ?? tasks.length} /><Card icon={<TrendingUp size={18} />} label={t("stats.task.completionRate")} value={`${completionRate}%`} tone="emerald" /><Card icon={<Clock3 size={18} />} label={t("stats.task.overdue")} value={overdue} tone={overdue ? "rose" : "amber"} /><Card icon={<FolderOpen size={18} />} label={t("stats.task.projectCoverage")} value={`${pct(tasks.filter((x) => x.projectId).length, tasks.length)}%`} /></div><SectionCard title={t("stats.task.projectBreakdown")} description={t("stats.task.projectCoverageHint", { count: tasks.filter((x) => x.projectId).length })}>{projectRows.length ? <ProjectProgress rows={projectRows} /> : <div className="grid min-h-36 place-items-center rounded-xl bg-app-bg text-sm text-tx-tertiary">{t("stats.task.empty")}</div>}</SectionCard></div>;
  const details = tasks.length ? <div className="overflow-x-auto rounded-2xl border border-app-border/75 bg-app-surface/85 shadow-sm backdrop-blur-md"><table className="min-w-full text-sm"><thead className="border-b border-app-border/70 bg-app-hover/50 text-left text-xs font-semibold text-tx-secondary"><tr><th className="px-4 py-3">{t("tasks.taskTitle")}</th><th className="px-4 py-3">{t("tasks.status")}</th><th className="px-4 py-3">{t("stats.task.completedAt")}</th></tr></thead><tbody className="divide-y divide-app-border/55">{tasks.slice(0, 200).map((x) => <tr key={x.id} className="hover:bg-app-hover/40"><td className="px-4 py-2.5 font-medium text-tx-primary">{x.title}</td><td className="px-4 py-2.5 text-tx-secondary">{x.status}</td><td className="px-4 py-2.5 font-mono text-xs text-tx-tertiary">{x.completedAt || "-"}</td></tr>)}</tbody></table></div> : <Empty text={t("stats.task.empty")} />;
  const records = recentEvents.length ? <div className="space-y-2">{recentEvents.map((e) => <div key={e.id} className="flex items-center justify-between gap-3 rounded-2xl border border-app-border/75 bg-app-surface/85 p-3.5 shadow-sm backdrop-blur-sm"><div><div className="font-medium text-tx-primary">{e.taskTitle}</div><div className="mt-0.5 text-xs text-tx-tertiary">{e.eventType === "completed" ? t("stats.task.recordCompleted") : t("stats.task.recordCreated")}</div></div><span className="shrink-0 font-mono text-xs text-tx-tertiary">{format(parseDateValue(e.occurredAt)!, "yyyy-MM-dd HH:mm", { locale })}</span></div>)}</div> : <Empty text={t("stats.task.noRecords")} />;
  const trendView = <div className="rounded-2xl border border-app-border/75 bg-app-surface/85 p-5 shadow-sm backdrop-blur-md"><h3 className="text-sm font-bold text-tx-primary">{t("stats.task.trendTitle")}</h3><div className="mt-3 divide-y divide-app-border/55">{trends.map((row) => <div key={row.key} className="flex items-center justify-between py-2.5 text-sm"><span className="font-mono text-xs text-tx-secondary">{row.label}</span><span className="text-xs font-medium text-tx-primary">{t("stats.task.trendLegend", { created: row.created, completed: row.completed })}</span></div>)}</div></div>;
  const heatView = <div className="rounded-2xl border border-app-border/75 bg-app-surface/85 p-5 shadow-sm backdrop-blur-md"><h3 className="text-sm font-bold text-tx-primary">{t("stats.task.heatmapTitle")}</h3><div className="mt-4 flex gap-1 overflow-x-auto pb-1">{heatmap.map((week, i) => <div key={i} className="grid grid-rows-7 gap-1">{week.map((cell) => <div key={cell.date.toISOString()} title={`${keyOf(cell.date)} · ${cell.count}`} className={cn("h-3 w-3 rounded-[3px]", cell.date.getFullYear() === year ? heat(cell.count) : "bg-transparent")} />)}</div>)}</div></div>;

  const habitOverview = <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4"><Card icon={<ListChecks size={18} />} label={t("stats.habit.habitCount")} value={habits.length} /><Card icon={<Flame size={18} />} label={t("stats.habit.currentStreak")} value={habitStats?.currentStreak ?? 0} tone="amber" /><Card icon={<CheckCircle2 size={18} />} label={t("stats.habit.successRate")} value={`${pct((habitStats?.successCount || 0) + (habitStats?.partialCount || 0), habitStats?.totalCheckins || 0)}%`} tone="emerald" /><Card icon={<CalendarDays size={18} />} label={t("stats.habit.todayCheckins")} value={byDay.get(keyOf(today))?.length || 0} /></div>;
  const log = checkins.length ? <div className="space-y-2">{checkins.slice(0, 80).map((c) => <div key={c.id} className="flex items-center justify-between gap-3 rounded-2xl border border-app-border/75 bg-app-surface/85 p-3.5 shadow-sm backdrop-blur-sm"><div><div className="font-medium text-tx-primary">{c.habitTitle}</div><div className="mt-0.5 text-xs text-tx-tertiary">{c.note || t("stats.habit.emptyNote")}</div></div><span className={cn("shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold", statusClass(c.status))}>{t(`habits.status.${c.status}`)}</span></div>)}</div> : <Empty text={t("stats.habit.noLogs")} />;
  const weekView = activeHabits.length ? <div className="overflow-x-auto rounded-2xl border border-app-border/75 bg-app-surface/85 shadow-sm backdrop-blur-md"><table className="min-w-full text-sm"><thead className="border-b border-app-border/70 bg-app-hover/50 text-xs font-semibold text-tx-secondary"><tr><th className="px-4 py-3 text-left">{t("habits.title")}</th>{week.map((d) => <th key={d.toISOString()} className="px-3 py-3">{format(d, "EE dd", { locale })}</th>)}</tr></thead><tbody className="divide-y divide-app-border/55">{activeHabits.map((h) => <tr key={h.id} className="hover:bg-app-hover/40"><td className="px-4 py-2.5 font-medium text-tx-primary">{h.title}</td>{week.map((d) => { const c = (byDay.get(keyOf(d)) || []).find((x) => x.habitId === h.id); return <td key={d.toISOString()} className="px-3 py-2.5 text-center text-xs text-tx-secondary">{c ? t(`habits.status.${c.status}`) : t("stats.habit.noCheckin")}</td>; })}</tr>)}</tbody></table></div> : <Empty text={t("stats.habit.noActiveHabits")} />;
  const monthView = <div className="rounded-2xl border border-app-border/75 bg-app-surface/85 p-5 shadow-sm backdrop-blur-md"><h3 className="text-sm font-bold text-tx-primary">{t("stats.habit.monthTitle")}</h3><p className="mt-0.5 text-xs text-tx-tertiary">{format(today, "yyyy MMMM", { locale })}</p><div className="mt-3 grid grid-cols-7 gap-2">{month.map((d) => { const rows = byDay.get(keyOf(d)) || []; return <div key={d.toISOString()} title={`${keyOf(d)} · ${rows.length}`} className={cn("min-h-20 rounded-xl border border-app-border/70 bg-app-bg/75 p-2 transition-colors", !isSameMonth(d, today) && "opacity-40", isToday(d) && "border-accent-primary/50 bg-indigo-500/[0.06] ring-1 ring-accent-primary/30")}><div className="text-xs font-semibold text-tx-secondary">{format(d, "d")}</div><div className="mt-1 font-mono text-sm font-bold text-tx-primary">{rows.length}</div></div>; })}</div></div>;
  const yearView = <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">{months.map((m) => <div key={m.key} className="rounded-2xl border border-app-border/75 bg-app-surface/85 p-4 shadow-sm backdrop-blur-md transition-all hover:-translate-y-0.5 hover:shadow-md"><div className="text-xs font-semibold text-tx-tertiary">{m.label}</div><div className="mt-1 font-mono text-2xl font-bold tabular-nums text-tx-primary">{m.rows.length}</div><div className="mt-2 grid grid-cols-3 text-xs font-medium"><span className="text-emerald-600 dark:text-emerald-300">{m.rows.filter((x) => x.status === "success").length}</span><span className="text-amber-600 dark:text-amber-300">{m.rows.filter((x) => x.status === "partial").length}</span><span className="text-rose-600 dark:text-rose-300">{m.rows.filter((x) => x.status === "failure").length}</span></div></div>)}</div>;

  const refresh = () => { onRefresh(); void loadEvents(); };
  return <div className="flex-1 overflow-y-auto px-4 py-4 md:px-6 bg-gradient-to-br from-transparent via-transparent to-indigo-500/[0.025] dark:to-indigo-500/[0.05]"><div className="relative mb-5 overflow-hidden rounded-[24px] border border-app-border/75 bg-gradient-to-br from-indigo-500/12 via-app-surface/90 to-violet-500/12 p-5 shadow-[0_12px_36px_-20px_rgba(99,102,241,0.3)] backdrop-blur-xl"><div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between"><div><div className="mb-1.5 flex items-center gap-2.5"><span className="inline-flex h-9 w-9 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-600 to-violet-600 text-white shadow-md shadow-indigo-500/25"><TrendingUp size={17} /></span><h2 className="text-lg font-bold tracking-tight text-tx-primary">{t("stats.title")}</h2></div><p className="text-sm text-tx-secondary">{t("stats.subtitle")}</p></div><div className="flex items-center gap-3"><CompletionSummary rate={completionRate} completed={taskStats?.completed ?? tasks.filter((task) => task.isCompleted).length} total={taskStats?.total ?? tasks.length} label={t("stats.task.completionRate")} /><button onClick={refresh} disabled={loading || eventsLoading} className="inline-flex items-center gap-1.5 rounded-xl border border-app-border/80 bg-app-surface/90 px-3.5 py-2 text-sm font-semibold text-tx-secondary shadow-sm transition-all hover:-translate-y-[1px] hover:border-accent-primary/40 hover:text-accent-primary active:translate-y-[0.5px] disabled:cursor-not-allowed disabled:opacity-60"><RefreshCw size={15} className={eventsLoading ? "animate-spin" : ""} />{t("stats.refresh")}</button></div></div></div><div className="space-y-5"><Tabs value={primary} onChange={setPrimary} values={[["overview", t("stats.tabs.overview")], ["tasks", t("stats.tabs.tasks")], ["habits", t("stats.tabs.habits")]]} />{loading ? <Empty text={t("stats.loading")} /> : primary === "overview" ? overview : primary === "tasks" ? <div className="space-y-4"><Tabs value={taskTab} onChange={setTaskTab} values={[["overview", t("stats.task.tabs.overview")], ["details", t("stats.task.tabs.details")], ["records", t("stats.task.tabs.records")], ["trends", t("stats.task.tabs.trends")], ["heatmap", t("stats.task.tabs.heatmap")]]} />{taskTab === "overview" ? taskOverview : taskTab === "details" ? details : taskTab === "records" ? records : taskTab === "trends" ? trendView : heatView}</div> : <div className="space-y-4"><Tabs value={habitTab} onChange={setHabitTab} values={[["overview", t("stats.habit.tabs.overview")], ["log", t("stats.habit.tabs.log")], ["week", t("stats.habit.tabs.week")], ["month", t("stats.habit.tabs.month")], ["year", t("stats.habit.tabs.year")]]} />{habitTab === "overview" ? habitOverview : habitTab === "log" ? log : habitTab === "week" ? weekView : habitTab === "month" ? monthView : yearView}</div>}</div></div>;
}

export const statsCenterTestUtils = { parseDateValue, snapshotEvents };
