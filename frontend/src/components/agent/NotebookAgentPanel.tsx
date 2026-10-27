import AgentTemplates from "./AgentTemplates";
import AgentTaskDrafts from "./AgentTaskDrafts";
import type { AgentTemplate } from "@/lib/agentTemplates";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "@/lib/api";
import { workflowActive, type AgentWorkflow, type AgentTaskDraft } from "@/lib/agentWorkflow";
import { getTaskComposerContext, isTaskComposerContextCurrent, refreshAgentTaskResults } from "@/lib/taskComposerApi";
import { queueTaskNavigation } from "@/lib/taskNotifications";
import { useApp, useAppActions } from "@/store/AppContext";
import type { Notebook } from "@/types";
import { Button } from "@/components/ui/button";

export default function NotebookAgentPanel({ workspaceId, onNavigateToNote }: { workspaceId: string; onNavigateToNote?: (id: string) => void }) {
  const { t, i18n } = useTranslation();
  const { state } = useApp(), actions = useAppActions();
  const [context] = useState(getTaskComposerContext);
  const [books, setBooks] = useState<Notebook[]>([]), [bookId, setBookId] = useState("");
  const [instruction, setInstruction] = useState(""), [includeChildren, setIncludeChildren] = useState(true), [linkCurrent, setLinkCurrent] = useState(false);
  const [run, setRun] = useState<AgentWorkflow | null>(null), [history, setHistory] = useState<AgentWorkflow[]>([]);
  const [busy, setBusy] = useState(false), [enabled, setEnabled] = useState(false), [error, setError] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const [taskDrafts, setTaskDrafts] = useState<AgentTaskDraft[] | null>(null);
  const [showLibrary, setShowLibrary] = useState(false), [template, setTemplate] = useState<AgentTemplate | null>(null);
  const alive = useRef(true), lock = useRef(false), stopped = useRef(false), pendingId = useRef<string | null>(null), currentRun = useRef<AgentWorkflow | null>(null);
  const current = useCallback(() => alive.current && isTaskComposerContextCurrent(context), [context]);
  const errorText = useCallback((value: unknown) => {
    const code = (value as { code?: string; message?: string }).code || (value as Error).message || "AGENT_REQUEST_FAILED";
    return t(`agent.errors.${code}`, { defaultValue: t(`taskComposer.errors.${code}`, { defaultValue: t("agent.errors.AGENT_REQUEST_FAILED") }) });
  }, [t]);
  const update = useCallback((value: AgentWorkflow) => { if (current()) { currentRun.current = value; setRun(value); setTaskDrafts(null); } }, [current]);
  const reloadHistory = useCallback(async () => { const list = await api.agentWorkflows.list(workspaceId); if (current()) setHistory(list); }, [current, workspaceId]);

  useEffect(() => {
    alive.current = true;
    void Promise.all([api.getNotebooks(workspaceId), api.agent.capabilities(), api.agentWorkflows.list(workspaceId)]).then(async ([notebooks, capabilities, list]) => {
      if (!current()) return;
      setBooks(notebooks); setBookId(notebooks.find(b => b.id === state.selectedNotebookId)?.id || notebooks[0]?.id || "");
      setHistory(list);
      if (list[0]) try { update(await api.agentWorkflows.get(workspaceId, list[0].id)); } catch (e) { if (current()) setError(errorText(e)); }
      if (current()) setEnabled(capabilities.enabled);
    }).catch(e => { if (current()) setError(errorText(e)); });
    return () => {
      alive.current = false;
      const previous = currentRun.current;
      if (workflowActive(previous) && isTaskComposerContextCurrent(context)) void api.agentWorkflows.action(workspaceId, previous!.id, "cancel").catch(() => undefined);
    };
    // The shell remounts this component on workspace changes. Initial selection is only a default.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, context]);

  useEffect(() => {
    if (!run || !["queued", "running", "applying"].includes(run.status)) return;
    const timer = setTimeout(() => { void api.agentWorkflows.get(workspaceId, run.id).then(update).catch(e => { if (current()) setError(errorText(e)); }); }, 700);
    return () => clearTimeout(timer);
  }, [run, workspaceId, current, update, errorText]);

  useEffect(() => {
    if (busy || workflowActive(run)) return;
    const timer = setInterval(() => { void reloadHistory().catch(() => undefined); }, 5000);
    return () => clearInterval(timer);
  }, [busy, run, reloadHistory]);

  async function openHistory(id: string) {
    if (lock.current || !current()) return;
    lock.current = true; setBusy(true); setError("");
    try { update(await api.agentWorkflows.get(workspaceId, id)); if (current()) setUncertain(false); }
    catch (e) { if (current()) setError(errorText(e)); }
    finally { lock.current = false; if (current()) setBusy(false); }
  }

  async function generate() {
    if (lock.current || !current()) return;
    lock.current = true; stopped.current = false; pendingId.current = null; setBusy(true); setError("");
    try {
      const created = await api.agentWorkflows.create(workspaceId, {
        ...(template ? { templateId: template.id, templateRevision: template.revision } : {}), notebookId: bookId, includeChildren, instruction, lang: i18n.language.startsWith("zh") ? "zh-CN" : "en",
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        ...(linkCurrent && state.activeNote ? { linkNoteId: state.activeNote.id } : {}),
      });
      pendingId.current = created.id;
      if (!current() || stopped.current) {
        if (isTaskComposerContextCurrent(context)) await api.agentWorkflows.action(workspaceId, created.id, "cancel");
        return;
      }
      const next = await api.agentWorkflows.get(workspaceId, created.id);
      if (!current() || stopped.current) {
        if (isTaskComposerContextCurrent(context)) await api.agentWorkflows.action(workspaceId, created.id, "cancel");
        return;
      }
      update(next); await reloadHistory();
    } catch (e) { if (current()) setError(errorText(e)); }
    finally { lock.current = false; if (current()) setBusy(false); }
  }
  async function refreshResults(next: AgentWorkflow) {
    if (!current()) return;
    actions.refreshNotebooks(); actions.refreshNotes();
    const ids = next.actions.find(a => a.kind === "tasks" && a.status === "completed")?.resourceIds || [];
    if (ids.length) try { await refreshAgentTaskResults(context, ids); } catch { if (current()) setError(t("agent.workflow.refreshWarning")); }
  }
  async function openTask(id: string) {
    if (!current() || lock.current) return;
    lock.current = true; setBusy(true);
    try {
      await refreshAgentTaskResults(context, [id]);
      if (current()) { queueTaskNavigation(id); actions.setViewMode("tasks"); }
    } catch { if (current()) setError(t("agent.workflow.refreshWarning")); }
    finally { lock.current = false; if (current()) setBusy(false); }
  }
  async function act(action: "approve" | "retry" | "cancel" | "reject") {
    if (!current()) return;
    if (action === "approve" && (taskDrafts || uncertain)) return;
    if (action === "cancel" || action === "reject") stopped.current = true;
    const id = action === "cancel" ? pendingId.current || run?.id : run?.id;
    if (!id || (lock.current && action !== "cancel")) return;
    lock.current = true; setBusy(true); setError("");
    try {
      const next = await api.agentWorkflows.action(workspaceId, id, action, action === "approve" ? run?.preview?.token : undefined);
      if (!current()) return;
      update(next); setUncertain(false); await reloadHistory();
      if (action === "approve") await refreshResults(next);
    } catch (e) {
      if (current()) {
        setError(errorText(e));
        if (action === "approve") {
          // A lost response may follow a committed write. Reconcile by GET only.
          setUncertain(true);
          try {
            const verified = await api.agentWorkflows.get(workspaceId, id);
            update(verified);
            if (current()) { setUncertain(false); if (verified.status !== "waiting_approval") setError(""); }
            await refreshResults(verified);
          } catch { /* Keep approval disabled until a read-only status refresh succeeds. */ }
        }
      }
    }
    finally { lock.current = false; if (current()) setBusy(false); }
  }

  async function reviewTasks() {
    const token = run?.preview?.token;
    if (!run || !token || !taskDrafts || lock.current || !current() || uncertain) return;
    const id = run.id;
    lock.current = true; setBusy(true); setError("");
    try { update(await api.agentWorkflows.reviseTasks(workspaceId, id, { token, tasks: taskDrafts })); }
    catch (e) {
      if (!current()) return;
      setError(errorText(e));
      // A lost review response can have rotated the approval. Never replay the mutation.
      try {
        const verified = await api.agentWorkflows.get(workspaceId, id);
        if (verified.preview?.token !== token || verified.status !== "waiting_approval") { update(verified); if (current()) setError(""); }
      } catch { if (current()) setUncertain(true); }
    } finally { lock.current = false; if (current()) setBusy(false); }
  }

  const reviewedTasks: AgentTaskDraft[] = run?.preview?.tasks?.tasks.map(({ projectId, reason, warnings, duplicateOf, ...task }) => {
    void projectId; void reason; void warnings; void duplicateOf;
    return { ...task, selected: task.selected !== false };
  }) || [];
  const canEditTasks = run?.status === "waiting_approval" && run.actions.some(action => action.kind === "tasks" && action.status !== "completed");

  return <section aria-label={t("agent.workflow.title")} className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-3 md:p-5">
    <h2 className="font-semibold">{t("agent.workflow.title")}</h2>
    <p className="text-xs text-tx-secondary">{t("agent.workflow.privacy")}</p>
    <Button variant="outline" disabled={busy || workflowActive(run)} onClick={() => setShowLibrary(!showLibrary)}>{t("agent.templates.title")}</Button>
    {showLibrary && <AgentTemplates workspaceId={workspaceId} books={books} onUse={value => { setTemplate(value); setBookId(value.config.input.notebookId); setInstruction(value.config.input.instruction); setIncludeChildren(value.config.input.includeChildren); setLinkCurrent(false); setShowLibrary(false); }} />}
    {template && <div className="flex items-center gap-2 text-sm"><span>{template.name}</span><Button variant="outline" size="sm" disabled={busy || workflowActive(run)} onClick={() => setTemplate(null)}>{t("agent.templates.custom")}</Button></div>}
    <label className="text-sm">{t("agent.workflow.notebook")}<select aria-label={t("agent.workflow.notebook")} className="mt-1 block w-full rounded border border-app-border bg-app-bg p-2" value={bookId} disabled={busy || workflowActive(run) || !!template} onChange={e => setBookId(e.target.value)}><option value="">{t("agent.workflow.choose")}</option>{books.map(book => <option key={book.id} value={book.id}>{book.name}</option>)}</select></label>
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={includeChildren} disabled={busy || workflowActive(run) || !!template} onChange={e => setIncludeChildren(e.target.checked)} />{t("agent.workflow.children")}</label>
    {state.activeNote && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={linkCurrent} disabled={busy || workflowActive(run) || !!template} onChange={e => setLinkCurrent(e.target.checked)} />{t("agent.workflow.linkCurrent", { title: state.activeNote.title })}</label>}
    <label className="text-sm" htmlFor="notebook-agent-request">{t("agent.request")}</label>
    <textarea id="notebook-agent-request" disabled={!!template} className="min-h-24 w-full rounded border border-app-border bg-app-bg p-2 text-sm" value={instruction} maxLength={4000} placeholder={t("agent.workflow.placeholder")} onChange={e => setInstruction(e.target.value)} />
    <div className="flex flex-wrap gap-2"><Button disabled={!enabled || busy || workflowActive(run) || !bookId || !instruction.trim()} onClick={() => void generate()}>{t("agent.generate")}</Button>{(busy || workflowActive(run)) && <Button variant="outline" onClick={() => void act("cancel")}>{t("agent.stop")}</Button>}</div>
    {(!enabled || !books.length) && <p className="text-sm text-tx-secondary">{t("agent.workflow.unavailable")}</p>}
    {history.length > 0 && <label className="text-sm">{t("agent.workflow.history")}<select aria-label={t("agent.workflow.history")} value={run?.id || ""} disabled={busy || workflowActive(run)} className="mt-1 block w-full rounded border border-app-border bg-app-bg p-2" onChange={e => { if (e.target.value) void openHistory(e.target.value); }}><option value="">{t("agent.workflow.choose")}</option>{history.map(item => <option value={item.id} key={item.id}>{new Date(item.createdAt).toLocaleString()} · {t(`agent.states.${item.status}`)}</option>)}</select></label>}
    {run && <p role="status" className="text-sm">{t(`agent.states.${run.status}`)}</p>}
    {run?.steps.map(step => <div key={step.sequence} className="rounded border border-app-border px-3 py-2 text-xs">{t(`agent.tools.${step.toolName}`, { defaultValue: t("agent.step") })} · {t(`agent.states.${step.status}`)}</div>)}
    {(error || run?.errorCode) && <p role="alert" className="text-sm text-red-500">{error || errorText({ code: run?.errorCode })}</p>}
    {run?.preview && <>
      <h3 className="font-medium">{t("agent.workflow.summary")}</h3><p className="whitespace-pre-wrap break-words text-sm">{run.preview.summary}</p>
      {run.preview.contextTruncated && <p className="text-xs text-amber-600">{t("agent.workflow.truncated")}</p>}
      <div className="flex flex-wrap gap-2">{run.preview.sources.map(source => <Button variant="outline" size="sm" key={source.id} onClick={() => onNavigateToNote?.(source.id)}>{source.title}</Button>)}</div>
      {run.preview.note && <div className="rounded border border-app-border p-3"><h3 className="font-medium">{t("agent.workflow.newNote")}: {run.preview.note.title}</h3><pre className="mt-2 whitespace-pre-wrap break-words text-sm">{run.preview.note.content}</pre></div>}
      {run.preview.tasks && <div className="space-y-2">
        <h3 className="font-medium">{t("agent.workflow.tasks", { count: run.preview.tasks.tasks.length })}</h3>
        <p className="text-xs text-tx-secondary">{t("agent.workflow.linkPreview")} · {t("taskComposer.timezone")} {run.preview.tasks.timezone}</p>
        <AgentTaskDrafts tasks={taskDrafts || reviewedTasks} timezone={run.preview.tasks.timezone} disabled={!canEditTasks || busy || uncertain} onChange={setTaskDrafts} />
        {!taskDrafts && run.preview.tasks.tasks.map(task => (task.reason || task.warnings.length > 0) && <p key={task.clientId} className="break-words text-xs text-tx-secondary">{task.title}: {task.reason} {task.warnings.map(warning => t(`taskComposer.warnings.${warning}`, { defaultValue: t("agent.workflow.reviewWarning") })).join(" · ")}</p>)}
        {taskDrafts && <div className="space-y-2"><p className="text-xs text-tx-secondary">{t("agent.workflow.taskChangesPending")}</p><div className="flex flex-wrap gap-2"><Button disabled={busy || uncertain} onClick={() => void reviewTasks()}>{t("agent.workflow.reviewTasks")}</Button><Button variant="outline" disabled={busy || uncertain} onClick={() => setTaskDrafts(null)}>{t("agent.workflow.discardTaskChanges")}</Button></div></div>}
      </div>}
    </>}
    {run?.preview?.extensionCalls?.map((call, index) => <div key={index} className="rounded border border-app-border p-3 text-sm"><h3 className="font-medium">{t("agent.templates.externalApproval")}</h3><p className="break-all">{call.tool?.name || call.toolId} · {call.tool?.destination}</p><pre className="whitespace-pre-wrap break-all">{JSON.stringify(call.input, null, 2)}</pre></div>)}
    {run?.preview?.extensionResults?.map((result, index) => <pre key={index} className="whitespace-pre-wrap break-all rounded border border-app-border p-3 text-xs">{JSON.stringify(result, null, 2)}</pre>)}
    {run?.extensionReceipts?.map(receipt => <p className="break-all text-xs" key={receipt.callIndex}>{receipt.toolId} · {t(`agent.states.${receipt.status}`, { defaultValue: receipt.status })}</p>)}
    {uncertain && run && <div role="alert" className="space-y-2 text-sm"><p>{t("agent.workflow.uncertain")}</p><Button variant="outline" disabled={busy} onClick={() => void openHistory(run.id)}>{t("agent.workflow.checkResults")}</Button></div>}
    {run?.status === "waiting_approval" && <div className="sticky bottom-0 flex flex-wrap gap-2 border-t border-app-border bg-app-surface py-3"><Button disabled={busy || uncertain || !!taskDrafts} onClick={() => void act("approve")}>{t("agent.workflow.approve")}</Button><Button variant="outline" disabled={busy} onClick={() => void act("reject")}>{t("agent.reject")}</Button></div>}
    {run?.actions.map(action => <div key={action.kind} className="rounded border border-app-border p-3 text-sm"><p>{t(`agent.workflow.action.${action.kind}`)} · {t(`agent.states.${action.status}`)}</p><div className="mt-2 flex flex-wrap gap-2">{action.resourceIds.map((id, index) => <Button variant="outline" size="sm" disabled={busy} key={id} onClick={() => { if (action.kind === "note") onNavigateToNote?.(id); else void openTask(id); }}>{t(action.kind === "note" ? "agent.workflow.openNote" : "agent.workflow.openTask", { count: index + 1 })}</Button>)}</div></div>)}
    {run && ["partial", "failed"].includes(run.status) && run.preview && run.actions.some(action => action.status !== "completed") && <Button variant="outline" disabled={busy || uncertain} onClick={() => void act("retry")}>{t("agent.workflow.retry")}</Button>}
    {run?.status === "completed" && <p className="text-sm">{t("agent.workflow.saved")}</p>}
    {run && !run.preview && !workflowActive(run) && <p className="text-xs text-tx-secondary">{t("agent.workflow.expired")}</p>}
    {!run?.preview && run?.sources?.length ? <div className="flex flex-wrap gap-2">{run.sources.map(source => <Button variant="outline" size="sm" key={source.id} onClick={() => onNavigateToNote?.(source.id)}>{source.title} · {t("agent.workflow.sourceVersion", { version: source.version })}</Button>)}</div> : null}
  </section>;
}
