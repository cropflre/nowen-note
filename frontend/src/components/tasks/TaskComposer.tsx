import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2, Plus, Sparkles, Trash2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Capacitor } from "@capacitor/core";
import { Button } from "../ui/button";
import { confirm } from "../ui/confirm";
import type { TaskProject } from "@/types";
import { newLocalId } from "@/lib/localRepository";
import {
  confirmedCandidates, confirmTaskComposition, DEFAULT_COMPOSER_OPTIONS, getTaskComposerContext,
  isTaskComposerContextCurrent, loadTaskComposerProjects, previewTaskComposition, TaskComposerApiError,
  type TaskCandidate, type TaskComposerBatch, type TaskComposerOptions,
} from "@/lib/taskComposerApi";

const fieldClass = "w-full min-w-0 rounded-md border border-app-border bg-app-bg px-2 py-1.5 text-sm text-tx-primary focus:outline-none focus:ring-1 focus:ring-accent-primary";
interface ComposerDraft { text: string; options: TaskComposerOptions; candidates: TaskCandidate[]; previewId: string; timezone: string; pending: TaskComposerBatch | null; dirty: boolean }
function readDraft(key: string, projectId: string | null): ComposerDraft {
  const empty: ComposerDraft = { text: "", options: { ...DEFAULT_COMPOSER_OPTIONS, projectId }, candidates: [], previewId: "", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, pending: null, dirty: false };
  try {
    const value = JSON.parse(sessionStorage.getItem(key) || "null");
    if (value && typeof value.text === "string" && Array.isArray(value.candidates) && value.candidates.length <= 30 && value.candidates.every((task: TaskCandidate) => typeof task.clientId === "string" && typeof task.title === "string" && Array.isArray(task.warnings))) return { ...empty, ...value };
  } catch { /* A corrupt/unavailable session cache must not prevent composition. */ }
  return empty;
}

export default function TaskComposer({ projects, initialProjectId, onClose, onCreated, onView }: {
  projects: TaskProject[]; initialProjectId: string | null; onClose: () => void;
  onCreated: () => void; onView: (filter: "all" | "today") => void;
}) {
  const { t, i18n } = useTranslation();
  const [context] = useState(getTaskComposerContext);
  const [availableProjects, setAvailableProjects] = useState(projects);
  const [initial] = useState(() => readDraft(context.scopeKey, initialProjectId));
  const [text, setText] = useState(initial.text);
  const [options, setOptions] = useState(initial.options);
  const [candidates, setCandidates] = useState(initial.candidates);
  const [previewId, setPreviewId] = useState(initial.previewId);
  const [timezone, setTimezone] = useState(initial.timezone);
  const [pending, setPending] = useState(initial.pending);
  const [dirty, setDirty] = useState(initial.dirty);
  const [view, setView] = useState<"input" | "preview" | "success">(initial.candidates.length ? "preview" : "input");
  const [generating, setGenerating] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [createdCount, setCreatedCount] = useState(0);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const generationGate = useRef(false);
  const creationGate = useRef(false);
  const mounted = useRef(true);
  const panel = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  const locked = creating || Boolean(pending);
  const selectedCount = candidates.filter(task => task.selected).length;
  const draft: ComposerDraft = useMemo(() => ({ text, options, candidates, previewId, timezone, pending, dirty }), [text, options, candidates, previewId, timezone, pending, dirty]);
  const draftRef = useRef(draft); draftRef.current = draft;
  const report = (failure: unknown) => {
    const code = failure instanceof TaskComposerApiError ? failure.code : (failure as Error)?.name === "TimeoutError" ? "AI_TIMEOUT" : "REQUEST_FAILED";
    return t(`taskComposer.errors.${code}`, { defaultValue: t("taskComposer.errors.REQUEST_FAILED") });
  };

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    const abort = new AbortController();
    void loadTaskComposerProjects(context, abort.signal).then(rows => { if (!abort.signal.aborted) setAvailableProjects(rows); }).catch(() => { if (!abort.signal.aborted) setAvailableProjects([]); });
    return () => abort.abort();
  }, [context]);
  useEffect(() => {
    if (view === "success") return;
    try { sessionStorage.setItem(context.scopeKey, JSON.stringify(draft)); } catch { /* Keep the in-memory draft when browser storage is unavailable. */ }
  }, [draft, context.scopeKey, view]);
  useEffect(() => {
    mounted.current = true;
    const previousFocus = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    const invalidate = () => {
      if (!isTaskComposerContextCurrent(context)) { controller.current?.abort(); closeRef.current(); }
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !creationGate.current) { event.preventDefault(); controller.current?.abort(); closeRef.current(); }
      if (event.key !== "Tab" || !panel.current?.contains(document.activeElement)) return;
      const elements = Array.from(panel.current.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary"));
      const first = elements[0], last = elements.at(-1);
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    window.addEventListener("keydown", keydown);
    const events = ["nowen:token-changed", "nowen:server-url-changed", "nowen:workspace-changed", "storage"];
    events.forEach(event => window.addEventListener(event, invalidate));
    return () => {
      mounted.current = false; controller.current?.abort();
      window.removeEventListener("keydown", keydown);
      events.forEach(event => window.removeEventListener(event, invalidate));
      previousFocus?.focus();
    };
  }, [context]);

  async function generate() {
    if (generationGate.current || creationGate.current || pending || !text.trim()) return;
    generationGate.current = true;
    try {
      if (dirty && candidates.length && !await confirm({ title: t("taskComposer.regenerate"), description: t("taskComposer.replaceWarning"), confirmText: t("taskComposer.regenerate") })) return;
      if (!mounted.current || !isTaskComposerContextCurrent(context)) return;
      const abort = new AbortController(); controller.current = abort;
      setGenerating(true); setError("");
      try {
        const result = await previewTaskComposition(context, { ...options, text, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, lang: i18n.language.startsWith("zh") ? "zh-CN" : "en" }, abort.signal);
        if (abort.signal.aborted || !mounted.current) return;
        setCandidates(result.tasks.map(task => ({ ...task, selected: !task.duplicateOf?.length, allowDuplicate: false })));
        setPreviewId(result.previewId); setTimezone(result.timezone); setWarnings(result.warnings);
        setDirty(false); setView("preview");
      } catch (failure) { if (!abort.signal.aborted && mounted.current) setError(report(failure)); }
      finally { if (controller.current === abort) controller.current = null; if (mounted.current) setGenerating(false); }
    } finally { generationGate.current = false; }
  }
  function cancelGeneration() { controller.current?.abort(); setGenerating(false); }
  function update(id: string, patch: Partial<TaskCandidate>) {
    if (locked || generating) return;
    const changesIdentity = ["title", "startDate", "dueDate", "dueAt", "projectId", "repeatRule", "repeatInterval"].some(field => field in patch);
    setDirty(true); setCandidates(previous => previous.map(task => task.clientId === id ? {
      ...task, ...patch,
      ...(changesIdentity ? { duplicateOf: [], allowDuplicate: false, warnings: task.warnings.filter(warning => warning !== "POSSIBLE_DUPLICATE") } : {}),
    } : task));
  }
  async function create() {
    if (creationGate.current || generating || (!pending && !selectedCount)) return;
    creationGate.current = true; setCreating(true); setError("");
    const batch = pending || { requestId: newLocalId(), previewId, timezone, tasks: confirmedCandidates(candidates) };
    // Save the exact payload before sending; a lost response must retry the same request.
    setPending(batch);
    try { sessionStorage.setItem(context.scopeKey, JSON.stringify({ ...draftRef.current, pending: batch })); } catch { /* The open panel still retains the retry payload. */ }
    try {
      const result = await confirmTaskComposition(context, batch);
      if (!mounted.current || !isTaskComposerContextCurrent(context)) return;
      setCreatedCount(result.createdCount); setRefreshFailed(Boolean(result.refreshFailed)); setPending(null); setView("success");
      try { sessionStorage.removeItem(context.scopeKey); } catch { /* ignore */ }
      onCreated();
    } catch (failure) {
      if (!mounted.current) return;
      if (failure instanceof TaskComposerApiError && failure.status && failure.status >= 400 && failure.status < 500) {
        setPending(null);
        if (failure.code === "TASK_DUPLICATE" && failure.details?.clientId) {
          const detail = failure.details;
          setCandidates(previous => previous.map(task => task.clientId === detail.clientId ? { ...task, duplicateOf: detail.duplicateOf || [], selected: false, warnings: [...task.warnings, "POSSIBLE_DUPLICATE"] } : task));
        }
      }
      if (failure instanceof TaskComposerApiError && ["OFFLINE", "LOCAL_MODE_UNAVAILABLE"].includes(failure.code)) setPending(null);
      setError(report(failure));
    } finally { creationGate.current = false; if (mounted.current) setCreating(false); }
  }
  function addManual() {
    if (locked || generating || candidates.length >= 30) return;
    setCandidates(previous => [...previous, { clientId: newLocalId(), title: "", description: "", priority: 2, startDate: null, dueDate: null, dueAt: null, projectId: options.projectId, repeatRule: "none", repeatInterval: 1, repeatEndDate: null, repeatEndCount: null, reason: "", warnings: [], duplicateOf: [], selected: true, allowDuplicate: false }]);
    setDirty(true);
  }
  const label = (key: string) => t(`taskComposer.${key}`);
  const projectSelect = (value: string | null, change: (id: string | null) => void, aria: string) => <select aria-label={aria} className={fieldClass} value={value || ""} onChange={event => change(event.target.value || null)}><option value="">{t("tasks.noProject")}</option>{value && !availableProjects.some(project => project.id === value) && <option value={value} disabled>{label("projectUnavailable")}</option>}{availableProjects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select>;
  const warningLabel = (warning: string) => t(`taskComposer.warnings.${warning}`, { defaultValue: warning });

  return createPortal(
    <div className="fixed inset-0 z-[100] bg-black/30" onMouseDown={event => { if (event.target === event.currentTarget && !creationGate.current) { controller.current?.abort(); onClose(); } }}>
      <div ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="task-composer-title" className="absolute inset-y-0 right-0 flex w-full max-w-2xl flex-col bg-app-bg text-tx-primary shadow-xl outline-none md:border-l md:border-app-border">
        <header className="flex shrink-0 items-start gap-3 border-b border-app-border p-4 pt-[max(1rem,env(safe-area-inset-top))]">
          <Sparkles size={20} className="mt-1 shrink-0 text-accent-primary" />
          <div className="min-w-0 flex-1"><h2 id="task-composer-title" className="font-semibold">{label("title")}</h2><p className="mt-1 text-xs text-tx-secondary">{label("subtitle")}</p></div>
          <Button variant="ghost" size="icon" aria-label={label("close")} disabled={creating} onClick={() => { controller.current?.abort(); onClose(); }}><X size={18} /></Button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4">
          {error && <p role="alert" className="mb-3 break-words rounded-md border border-accent-danger/30 bg-accent-danger/5 p-3 text-sm text-accent-danger">{error}</p>}
          {pending && <p role="status" className="mb-3 rounded-md bg-app-elevated p-3 text-sm text-tx-secondary">{label("retryNotice")}</p>}
          {generating && <p role="status" className="mb-3 flex items-center gap-2 text-sm"><Loader2 size={16} className="animate-spin" />{label("generating")}</p>}
          {view === "input" && <fieldset disabled={generating || locked} className="min-w-0 space-y-4">
            <label className="block space-y-2 text-sm"><span>{label("input")}</span><textarea aria-label={label("input")} className={`${fieldClass} min-h-36 resize-y`} maxLength={12000} value={text} placeholder={label("placeholder")} onChange={event => setText(event.target.value)} /></label>
            <div className="flex flex-wrap gap-2">{["today", "study", "extract"].map(example => <Button key={example} variant="secondary" size="sm" onClick={() => setText(label(`examples.${example}.text`))}>{label(`examples.${example}.label`)}</Button>)}</div>
            <details className="rounded-md border border-app-border p-3"><summary className="cursor-pointer text-sm text-tx-secondary">{label("advanced")}</summary><div className="mt-3 grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="min-w-0 space-y-1 text-xs">{label("fromDate")}<input className={fieldClass} type="date" value={options.fromDate || ""} onChange={event => setOptions({ ...options, fromDate: event.target.value || null })} /></label>
              <label className="min-w-0 space-y-1 text-xs">{label("toDate")}<input className={fieldClass} type="date" value={options.toDate || ""} onChange={event => setOptions({ ...options, toDate: event.target.value || null })} /></label>
              <label className="min-w-0 space-y-1 text-xs">{label("project")}{projectSelect(options.projectId, projectId => setOptions({ ...options, projectId }), label("project"))}</label>
              <label className="min-w-0 space-y-1 text-xs">{label("maxTasks")}<input className={fieldClass} type="number" min={1} max={30} value={options.maxTasks} onChange={event => setOptions({ ...options, maxTasks: Number(event.target.value) })} /></label>
              <label className="min-w-0 space-y-1 text-xs">{label("focusCount")}<input className={fieldClass} type="number" min={0} max={3} value={options.focusCount} onChange={event => setOptions({ ...options, focusCount: Number(event.target.value) })} /></label>
              <p className="self-end text-xs text-tx-tertiary">{label("focusHint")}</p>
              <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={options.recognizeRepeat} onChange={event => setOptions({ ...options, recognizeRepeat: event.target.checked })} />{label("recognizeRepeat")}</label>
              <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={options.recognizeTime} onChange={event => setOptions({ ...options, recognizeTime: event.target.checked })} />{label("recognizeTime")}</label>
            </div></details>
            <p className="text-xs text-tx-tertiary">{label("draftNotice")}</p>
          </fieldset>}
          {view === "preview" && <div className="space-y-3">
            <p className="text-xs text-tx-tertiary">{label("timezone")} {timezone} · {label("draftNotice")}</p>
            {warnings.map(warning => <p key={warning} className="text-xs text-tx-secondary">{warningLabel(warning)}</p>)}
            <div className="flex flex-wrap gap-2"><Button variant="ghost" size="sm" disabled={locked || generating} onClick={() => { setCandidates(previous => previous.map(task => ({ ...task, selected: true }))); setDirty(true); }}>{label("selectAll")}</Button><Button variant="ghost" size="sm" disabled={locked || generating} onClick={() => { setCandidates(previous => previous.map(task => ({ ...task, selected: false }))); setDirty(true); }}>{label("deselectAll")}</Button><Button variant="outline" size="sm" disabled={locked || generating || candidates.length >= 30} onClick={addManual}><Plus size={14} className="mr-1" />{label("addManual")}</Button></div>
            {!candidates.length && <p className="py-6 text-center text-sm text-tx-tertiary">{label("empty")}</p>}
            {candidates.map((task, index) => <fieldset key={task.clientId} disabled={locked || generating} className="min-w-0 space-y-3 rounded-lg border border-app-border bg-app-elevated/30 p-3" aria-label={label("candidate") + ` ${index + 1}`}>
              <div className="flex min-w-0 items-center gap-2"><input aria-label={label("select") + ` ${index + 1}`} type="checkbox" checked={task.selected} onChange={event => update(task.clientId, { selected: event.target.checked })} className="shrink-0 accent-accent-primary" /><input aria-label={label("taskTitle") + ` ${index + 1}`} className={fieldClass} maxLength={200} value={task.title} onChange={event => update(task.clientId, { title: event.target.value })} /><Button variant="ghost" size="icon" aria-label={label("remove") + ` ${index + 1}`} onClick={() => { setCandidates(previous => previous.filter(candidate => candidate.clientId !== task.clientId)); setDirty(true); }}><Trash2 size={14} /></Button></div>
              <textarea aria-label={label("description") + ` ${index + 1}`} className={`${fieldClass} resize-y`} rows={2} maxLength={4000} placeholder={label("description")} value={task.description} onChange={event => update(task.clientId, { description: event.target.value })} />
              <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
                <label className="min-w-0 space-y-1 text-xs">{label("priority")}<select aria-label={label("priority") + ` ${index + 1}`} className={fieldClass} value={task.priority} onChange={event => update(task.clientId, { priority: Number(event.target.value) as 1 | 2 | 3 })}>{[1, 2, 3].map(priority => <option key={priority} value={priority}>{t(`tasks.${["", "low", "medium", "high"][priority]}`)}</option>)}</select></label>
                <label className="min-w-0 space-y-1 text-xs">{label("project")}{projectSelect(task.projectId, projectId => update(task.clientId, { projectId }), label("project") + ` ${index + 1}`)}</label>
                <label className="min-w-0 space-y-1 text-xs">{label("startDate")}<input aria-label={label("startDate") + ` ${index + 1}`} className={fieldClass} type="date" value={task.startDate?.slice(0, 10) || ""} onChange={event => update(task.clientId, { startDate: event.target.value ? event.target.value + (task.startDate?.includes("T") ? task.startDate.slice(10) : "") : null })} /></label>
                <label className="min-w-0 space-y-1 text-xs">{label("startTime")}<input aria-label={label("startTime") + ` ${index + 1}`} className={fieldClass} type="time" disabled={!task.startDate || locked || generating} value={task.startDate?.split("T")[1] || ""} onChange={event => update(task.clientId, { startDate: `${task.startDate!.slice(0, 10)}${event.target.value ? "T" + event.target.value : ""}` })} /></label>
                <label className="min-w-0 space-y-1 text-xs">{label("dueDate")}<input aria-label={label("dueDate") + ` ${index + 1}`} className={fieldClass} type="date" value={task.dueDate || ""} onChange={event => update(task.clientId, { dueDate: event.target.value || null, dueAt: event.target.value && task.dueAt ? event.target.value + task.dueAt.slice(10) : null })} /></label>
                <label className="min-w-0 space-y-1 text-xs">{label("dueTime")}<input aria-label={label("dueTime") + ` ${index + 1}`} className={fieldClass} type="time" disabled={!task.dueDate || locked || generating} value={task.dueAt?.split("T")[1] || ""} onChange={event => update(task.clientId, { dueAt: event.target.value ? `${task.dueDate}T${event.target.value}` : null })} /></label>
                <label className="min-w-0 space-y-1 text-xs">{label("repeatRule")}<select aria-label={label("repeatRule") + ` ${index + 1}`} className={fieldClass} value={task.repeatRule} onChange={event => update(task.clientId, { repeatRule: event.target.value as TaskCandidate["repeatRule"], ...(event.target.value === "none" ? { repeatEndDate: null, repeatEndCount: null } : {}) })}>{["none", "daily", "weekly", "monthly", "yearly"].map(rule => <option key={rule} value={rule}>{label(`repeat.${rule}`)}</option>)}</select></label>
                {task.repeatRule !== "none" && <><label className="min-w-0 space-y-1 text-xs">{label("repeatInterval")}<input aria-label={label("repeatInterval") + ` ${index + 1}`} className={fieldClass} type="number" min={1} max={365} value={task.repeatInterval} onChange={event => update(task.clientId, { repeatInterval: Number(event.target.value) })} /></label><label className="min-w-0 space-y-1 text-xs">{label("repeatEndDate")}<input aria-label={label("repeatEndDate") + ` ${index + 1}`} className={fieldClass} type="date" value={task.repeatEndDate || ""} onChange={event => update(task.clientId, { repeatEndDate: event.target.value || null })} /></label><label className="min-w-0 space-y-1 text-xs">{label("repeatEndCount")}<input aria-label={label("repeatEndCount") + ` ${index + 1}`} className={fieldClass} type="number" min={1} max={999} value={task.repeatEndCount || ""} onChange={event => update(task.clientId, { repeatEndCount: event.target.value ? Number(event.target.value) : null })} /></label></>}
              </div>
              {task.reason && <details className="text-xs text-tx-secondary"><summary className="cursor-pointer">{label("reason")}</summary><p className="mt-1 break-words whitespace-pre-wrap">{task.reason}</p></details>}
              {task.warnings.map((warning, warningIndex) => <p key={warningIndex} className="break-words text-xs text-amber-600 dark:text-amber-400">{warningLabel(warning)}</p>)}
              {task.duplicateOf.length > 0 && <label className="flex items-center gap-2 text-xs text-tx-secondary"><input aria-label={label("allowDuplicate") + ` ${index + 1}`} type="checkbox" checked={task.allowDuplicate} onChange={event => update(task.clientId, { allowDuplicate: event.target.checked, selected: event.target.checked })} />{label("allowDuplicate")}</label>}
            </fieldset>)}
          </div>}
          {view === "success" && <div className="space-y-4 py-8 text-center"><p role="status" className="text-lg font-medium">{t("taskComposer.success", { count: createdCount })}</p>{refreshFailed && <p role="alert" className="text-sm text-tx-secondary">{label("refreshFailed")}</p>}<div className="flex flex-wrap justify-center gap-2"><Button variant="outline" onClick={() => { onView("all"); onClose(); }}>{label("viewAll")}</Button><Button variant="outline" onClick={() => { onView("today"); onClose(); }}>{label("viewToday")}</Button><Button onClick={() => { setText(""); setCandidates([]); setPreviewId(""); setDirty(false); setError(""); setView("input"); }}>{label("continue")}</Button></div></div>}
        </div>
        {view !== "success" && <footer className="shrink-0 space-y-2 border-t border-app-border p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
          {view === "preview" && <p className="text-xs text-tx-secondary">{t("taskComposer.count", { total: candidates.length, selected: selectedCount })}</p>}
          <div className="flex flex-wrap justify-end gap-2">
            {generating ? <Button variant="outline" onClick={cancelGeneration}>{label("cancelGeneration")}</Button> : view === "input" ? <Button disabled={!text.trim() || creating || Boolean(pending)} onClick={generate}><Sparkles size={14} className="mr-1" />{label("generate")}</Button> : <>
              <Button variant="ghost" disabled={locked} onClick={() => setView("input")}>{label("back")}</Button>
              <Button variant="outline" disabled={locked} onClick={generate}>{label("regenerate")}</Button>
              <Button disabled={creating || (!pending && (!selectedCount || candidates.some(task => task.selected && (!task.title.trim() || (task.duplicateOf.length > 0 && !task.allowDuplicate)))))} onClick={create}>{creating && <Loader2 size={14} className="mr-1 animate-spin" />}{pending ? label("retry") : t("taskComposer.confirm", { count: selectedCount })}</Button>
            </>}
          </div>
        </footer>}
      </div>
    </div>, document.body,
  );
}
