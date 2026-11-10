import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api, getCurrentWorkspace } from "@/lib/api";
import { pushAppPathState } from "@/lib/appPathNavigation";
import { parseServerTime } from "@/lib/dateTime";
import { noteLocalDayKey } from "@/lib/noteListTime";
import type { BuiltinWidgetKind } from "@/lib/pluginDashboard";
import { useApp, useAppActions } from "@/store/AppContext";
import type { NoteListItem, Task, TaskStats, ViewMode } from "@/types";
import { cn } from "@/lib/utils";

type Load<T> = { status: "loading" } | { status: "ready"; data: T } | { status: "error"; message: string };

/** Loads once per refresh key; late responses from an older key or an unmounted card are dropped. */
function useCardData<T>(load: () => Promise<T>, refreshKey: string): [Load<T>, () => void] {
  const [state, setState] = useState<Load<T>>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const loadRef = useRef(load); loadRef.current = load;
  useEffect(() => {
    let active = true;
    setState({ status: "loading" });
    loadRef.current()
      .then((data) => { if (active) setState({ status: "ready", data }); })
      .catch((error: unknown) => { if (active) setState({ status: "error", message: error instanceof Error ? error.message : String(error) }); });
    return () => { active = false; };
  }, [refreshKey, attempt]);
  return [state, useCallback(() => setAttempt((value) => value + 1), [])];
}

function useOpenInApp() {
  const actions = useAppActions();
  const openView = useCallback((view: ViewMode) => {
    pushAppPathState("/");
    actions.setViewMode(view);
    actions.setMobileView("list");
  }, [actions]);
  const openNote = useCallback((noteId: string) => {
    // Same hand-off the V3 navigation bridge uses to open a note from /apps.
    openView("all");
    window.dispatchEvent(new CustomEvent("nowen:open-note-link", { detail: { noteId, blockId: null, href: `nowen://note/${noteId}` } }));
  }, [openView]);
  return { openView, openNote };
}

function CardStatus<T>({ state, retry, children }: { state: Load<T>; retry: () => void; children: (data: T) => React.ReactNode }) {
  const { t } = useTranslation();
  if (state.status === "loading") return <div role="status" aria-label={t("extensionCenter.workbench.loading")} className="space-y-2 py-1">
    {[0, 1, 2].map((index) => <div key={index} className="h-3 rounded bg-app-hover motion-safe:animate-pulse" style={{ width: `${85 - index * 15}%` }} />)}
  </div>;
  if (state.status === "error") return <div role="alert" className="space-y-2 text-sm text-red-700 dark:text-red-300">
    <span className="block">{t("extensionCenter.workbench.loadFailed", { message: state.message })}</span>
    <Button size="sm" variant="outline" className="min-h-11 md:min-h-8" onClick={retry}>{t("extensionCenter.discover.retry")}</Button>
  </div>;
  return <>{children(state.data)}</>;
}

function sortRecent(notes: NoteListItem[]): NoteListItem[] {
  // The offline fallback returns the whole cached list, so sort and trim on the client as well.
  const time = (note: NoteListItem) => parseServerTime(note.updatedAt)?.getTime() ?? 0;
  return [...notes].sort((a, b) => time(b) - time(a)).slice(0, 5);
}

function NoteListCard({ favorites, refreshKey }: { favorites: boolean; refreshKey: string }) {
  const { t, i18n } = useTranslation();
  const { openNote, openView } = useOpenInApp();
  const [state, retry] = useCardData(
    async () => sortRecent(await api.getNotes(favorites ? { isFavorite: "1", sortBy: "recent", limit: "5" } : { sortBy: "recent", limit: "5" })),
    refreshKey,
  );
  const format = useMemo(() => new Intl.DateTimeFormat(i18n.language, { month: "short", day: "numeric" }), [i18n.language]);
  return <CardStatus state={state} retry={retry}>{(notes) => notes.length
    ? <ul className="-mx-1 space-y-0.5">{notes.map((note) => <li key={note.id}>
      <button type="button" onClick={() => openNote(note.id)} className="flex min-h-11 w-full items-center gap-2 rounded-md px-1 text-left text-sm hover:bg-app-hover md:min-h-9">
        <span className="min-w-0 flex-1 truncate text-tx-primary">{note.title || t("extensionCenter.workbench.untitled")}</span>
        <span className="shrink-0 text-xs text-tx-tertiary">{(() => { const updated = parseServerTime(note.updatedAt); return updated ? format.format(updated) : ""; })()}</span>
      </button>
    </li>)}</ul>
    : <div className="space-y-2 text-sm text-tx-secondary">
      <span className="block">{t(favorites ? "extensionCenter.workbench.noFavorites" : "extensionCenter.workbench.noNotes")}</span>
      <Button size="sm" variant="outline" className="min-h-11 md:min-h-8" onClick={() => openView(favorites ? "favorites" : "all")}>{t("extensionCenter.workbench.openNotes")}</Button>
    </div>}
  </CardStatus>;
}

function QuickNoteCard({ onCreated }: { onCreated: () => void }) {
  const { t } = useTranslation();
  const { state } = useApp();
  const actions = useAppActions();
  const { openNote } = useOpenInApp();
  const [text, setText] = useState("");
  const [status, setStatus] = useState<{ kind: "idle" } | { kind: "saving" } | { kind: "saved"; noteId: string; notebook: string } | { kind: "error"; message: string }>({ kind: "idle" });
  const workspace = getCurrentWorkspace();
  const notebooks = state.notebooks.filter((notebook) => (workspace === "personal" ? !notebook.workspaceId : notebook.workspaceId === workspace));
  const [chosenId, setChosenId] = useState<string | null>(null);
  const target = notebooks.find((notebook) => notebook.id === chosenId)
    || notebooks.find((notebook) => notebook.id === state.selectedNotebookId) || notebooks[0];
  const save = async () => {
    const body = text.trim();
    if (!body || status.kind === "saving") return;
    if (!target) { setStatus({ kind: "error", message: t("extensionCenter.workbench.needNotebook") }); return; }
    setStatus({ kind: "saving" });
    const title = body.split(/\r?\n/)[0].replace(/^#+\s*/, "").trim().slice(0, 80) || t("extensionCenter.workbench.untitled");
    try {
      // Same write path as Alt+N / "open file": the regular note API, never a dashboard-only store.
      const note = await api.createNote({ notebookId: target.id, title, content: body, contentText: body, contentFormat: "markdown" });
      setText("");
      setStatus({ kind: "saved", noteId: note.id, notebook: target.name });
      actions.refreshNotes();
      actions.refreshNotebooks();
      onCreated();
    } catch (error) {
      // Keep the draft so nothing typed is lost.
      setStatus({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  };
  return <div className="space-y-2">
    <textarea value={text} maxLength={20_000} onChange={(event) => { setText(event.target.value); if (status.kind !== "saving") setStatus({ kind: "idle" }); }}
      onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); void save(); } }}
      aria-label={t("extensionCenter.workbench.quickNoteLabel")} placeholder={t("extensionCenter.workbench.quickNotePlaceholder")}
      className="min-h-24 w-full resize-y rounded-lg border border-app-border bg-app-bg px-3 py-2 text-sm text-tx-primary outline-none placeholder:text-tx-tertiary focus-visible:ring-1 focus-visible:ring-accent-primary" />
    <div className="flex flex-wrap items-center justify-between gap-2">
      {target ? <label className="flex min-w-0 items-center gap-1.5 text-xs text-tx-tertiary">
        <span className="shrink-0">{t("extensionCenter.workbench.quickNoteTarget")}</span>
        <select value={target.id} onChange={(event) => setChosenId(event.target.value)}
          className="min-h-11 min-w-0 max-w-48 truncate rounded-md border border-app-border bg-app-surface px-1.5 text-xs text-tx-primary md:min-h-8">
          {notebooks.map((notebook) => <option key={notebook.id} value={notebook.id}>{notebook.name}</option>)}
        </select>
      </label> : <span className="text-xs text-tx-tertiary">{t("extensionCenter.workbench.needNotebook")}</span>}
      <Button size="sm" className="min-h-11 md:min-h-8" disabled={!text.trim() || status.kind === "saving"} onClick={() => void save()}>
        {status.kind === "saving" && <Loader2 size={13} className="mr-1.5 animate-spin" />}{t("extensionCenter.workbench.quickNoteSave")}
      </Button>
    </div>
    {status.kind === "saved" && <div role="status" className="flex flex-wrap items-center gap-2 text-sm text-emerald-700 dark:text-emerald-300">
      <span>{t("extensionCenter.workbench.quickNoteSaved", { notebook: status.notebook })}</span>
      <button type="button" className="underline-offset-2 hover:underline" onClick={() => openNote(status.noteId)}>{t("extensionCenter.workbench.openNote")}</button>
    </div>}
    {status.kind === "error" && <span role="alert" className="block text-sm text-red-700 dark:text-red-300">{t("extensionCenter.workbench.quickNoteFailed", { message: status.message })}</span>}
  </div>;
}

function TodayTasksCard({ refreshKey }: { refreshKey: string }) {
  const { t } = useTranslation();
  const { openView } = useOpenInApp();
  const [state, retry] = useCardData(async () => (await api.getTasks("today")).filter((task) => !task.archivedAt).slice(0, 6), refreshKey);
  const [pending, setPending] = useState<Record<string, number>>({});
  const toggle = async (task: Task) => {
    setPending((current) => ({ ...current, [task.id]: task.isCompleted ? 0 : 1 }));
    try { await api.toggleTask(task.id); }
    catch { /* The reload below shows the server's state. */ }
    finally { setPending((current) => { const next = { ...current }; delete next[task.id]; return next; }); retry(); }
  };
  return <CardStatus state={state} retry={retry}>{(tasks) => <div className="space-y-2">
    {tasks.length ? <ul className="space-y-0.5">{tasks.map((task) => {
      const done = Boolean(pending[task.id] ?? task.isCompleted);
      return <li key={task.id}><label className="flex min-h-11 cursor-pointer items-center gap-2 rounded-md px-1 text-sm hover:bg-app-hover md:min-h-9">
        <input type="checkbox" checked={done} disabled={task.id in pending} onChange={() => void toggle(task)} className="h-4 w-4 shrink-0 accent-[var(--color-accent-primary)]" />
        <span className={cn("min-w-0 flex-1 truncate", done ? "text-tx-tertiary line-through" : "text-tx-primary")}>{task.title}</span>
      </label></li>;
    })}</ul> : <span className="block text-sm text-tx-secondary">{t("extensionCenter.workbench.noTasks")}</span>}
    <Button size="sm" variant="outline" className="min-h-11 md:min-h-8" onClick={() => openView("tasks")}>{t("extensionCenter.workbench.openTasks")}</Button>
  </div>}</CardStatus>;
}

function TaskStatsCard({ refreshKey }: { refreshKey: string }) {
  const { t } = useTranslation();
  const [state, retry] = useCardData<TaskStats>(() => api.getTaskStats(), refreshKey);
  return <CardStatus state={state} retry={retry}>{(stats) => <dl className="grid grid-cols-2 gap-2">
    {([["pending", stats.pending], ["today", stats.today], ["overdue", stats.overdue], ["completedToday", stats.completedToday ?? 0]] as const).map(([key, value]) =>
      <div key={key} className="rounded-lg bg-app-hover/70 px-3 py-2">
        <dt className="text-xs text-tx-tertiary">{t(`extensionCenter.workbench.stats.${key}`)}</dt>
        <dd className={cn("text-xl font-semibold", key === "overdue" && value > 0 ? "text-red-600 dark:text-red-300" : "text-tx-primary")}>{value}</dd>
      </div>)}
  </dl>}</CardStatus>;
}

function dateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function DiaryCalendarCard({ refreshKey }: { refreshKey: string }) {
  const { t, i18n } = useTranslation();
  const { openView } = useOpenInApp();
  const [month, setMonth] = useState(() => { const now = new Date(); return new Date(now.getFullYear(), now.getMonth(), 1); });
  const first = month, last = new Date(month.getFullYear(), month.getMonth() + 1, 0);
  const [state, retry] = useCardData(async () => {
    // Local month boundaries as UTC instants, so entries near midnight land on the right day.
    const end = new Date(last.getFullYear(), last.getMonth(), last.getDate(), 23, 59, 59, 999);
    const timeline = await api.getDiaryTimeline(undefined, 100, { from: first.toISOString(), to: end.toISOString() });
    const counts: Record<string, number> = {};
    for (const item of timeline.items) { const key = noteLocalDayKey(item.createdAt); if (key) counts[key] = (counts[key] || 0) + 1; }
    return counts;
  }, `${refreshKey}:${dateKey(first)}`);
  const locale = i18n.language;
  const monthLabel = new Intl.DateTimeFormat(locale, { year: "numeric", month: "long" }).format(month);
  const weekdays = Array.from({ length: 7 }, (_, index) => new Intl.DateTimeFormat(locale, { weekday: "narrow" }).format(new Date(2024, 0, 1 + index)));
  const leading = (first.getDay() + 6) % 7;
  const today = dateKey(new Date());
  const cells = [...Array.from({ length: leading }, () => null), ...Array.from({ length: last.getDate() }, (_, index) => new Date(month.getFullYear(), month.getMonth(), index + 1))];
  const shift = (delta: number) => setMonth(new Date(month.getFullYear(), month.getMonth() + delta, 1));
  return <div className="space-y-2">
    <div className="flex items-center justify-between">
      <span className="text-sm font-medium text-tx-primary">{monthLabel}</span>
      <div className="flex gap-1">
        <button type="button" aria-label={t("extensionCenter.workbench.previousMonth")} onClick={() => shift(-1)} className="inline-flex h-11 w-11 items-center justify-center rounded-md hover:bg-app-hover md:h-7 md:w-7"><ChevronLeft size={14} /></button>
        <button type="button" aria-label={t("extensionCenter.workbench.nextMonth")} onClick={() => shift(1)} className="inline-flex h-11 w-11 items-center justify-center rounded-md hover:bg-app-hover md:h-7 md:w-7"><ChevronRight size={14} /></button>
      </div>
    </div>
    <div className="grid grid-cols-7 text-center text-[11px] text-tx-tertiary" aria-hidden>{weekdays.map((day, index) => <span key={index}>{day}</span>)}</div>
    <CardStatus state={state} retry={retry}>{(counts) => <div className="grid grid-cols-7 gap-0.5">
      {cells.map((day, index) => {
        if (!day) return <span key={`blank-${index}`} />;
        const key = dateKey(day), count = counts[key] || 0;
        return <button key={key} type="button" onClick={() => openView("diary")}
          aria-label={t("extensionCenter.workbench.diaryDay", { date: new Intl.DateTimeFormat(locale, { month: "long", day: "numeric" }).format(day), count })}
          className={cn("relative flex aspect-square items-center justify-center rounded-md text-xs hover:bg-app-hover",
            key === today ? "bg-accent-primary/15 font-semibold text-accent-primary" : "text-tx-secondary")}>
          {day.getDate()}
          {count > 0 && <span aria-hidden className="absolute bottom-1 h-1 w-1 rounded-full bg-accent-primary" />}
        </button>;
      })}
    </div>}</CardStatus>
  </div>;
}

/** Renders the body of a built-in card. Titles and chrome come from the dashboard. */
export function BuiltinCardBody({ kind, refreshKey, onDataChanged }: { kind: BuiltinWidgetKind; refreshKey: string; onDataChanged: () => void }) {
  switch (kind) {
    case "quick-note": return <QuickNoteCard onCreated={onDataChanged} />;
    case "recent-notes": return <NoteListCard favorites={false} refreshKey={refreshKey} />;
    case "favorites": return <NoteListCard favorites refreshKey={refreshKey} />;
    case "today-tasks": return <TodayTasksCard refreshKey={refreshKey} />;
    case "task-stats": return <TaskStatsCard refreshKey={refreshKey} />;
    case "diary-calendar": return <DiaryCalendarCard refreshKey={refreshKey} />;
  }
}
