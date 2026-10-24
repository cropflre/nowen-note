import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "@/lib/api";
import { sameAgentSnapshot, type AgentRun } from "@/lib/agentEdits";
import type { NoteEditorHandle } from "@/components/editors/types";
import type { Note } from "@/types";
import { Button } from "@/components/ui/button";
import { Sparkles, X } from "lucide-react";

export default function EditorAgentPanel({ note, editor, onClose }: { note: Note; editor: () => NoteEditorHandle | null; onClose: () => void }) {
  const { t } = useTranslation();
  const [instruction, setInstruction] = useState("");
  const [run, setRun] = useState<AgentRun | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  function readContext() {
    const handle = editor(), snapshot = handle?.getSnapshot?.();
    const selection = handle?.getAgentSelection?.().trim() || "";
    let empty = snapshot?.content === "";
    if (snapshot && note.contentFormat === "tiptap-json") {
      try {
        const doc = JSON.parse(snapshot.content);
        empty = doc.type === "doc" && doc.content?.length === 1 && doc.content[0].type === "paragraph" && !doc.content[0].content?.length;
      } catch { empty = false; }
    }
    return { kind: selection ? "selection" : empty ? "empty" : "note", selection };
  }
  const [context, setContext] = useState(readContext);
  const shortcuts = context.kind === "empty" ? ["draft", "outline"] : context.kind === "selection" ? ["polish", "shorten"] : ["polish", "summarize", "structure"];
  const alive = useRef(true), lock = useRef(false), runId = useRef<string | null>(null);
  const cancelled = useRef(false);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const steps = (run?.steps || []).filter((step, index, all) => step.toolName !== "run"
    && !all.slice(index + 1).some(next => next.toolName === step.toolName));
  const canStart = !run || ["completed", "failed", "cancelled", "interrupted"].includes(run.status);
  const errorText = useCallback((value: unknown) => {
    const code = (value as { code?: string; message?: string }).code || (value as Error).message || "AGENT_REQUEST_FAILED";
    return t(`agent.errors.${code}`, { defaultValue: t("agent.errors.AGENT_REQUEST_FAILED") });
  }, [t]);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    return () => { if (opener?.isConnected) opener.focus(); };
  }, []);
  useEffect(() => {
    alive.current = true; cancelled.current = false;
    void api.agent.capabilities().then(async capabilities => {
      const latest = capabilities.enabled ? await api.agent.latest(note.id) : null;
      if (alive.current) { setEnabled(capabilities.enabled); setLoaded(true); setRun(latest); runId.current = latest?.id || null; }
    }).catch(e => { if (alive.current) { setLoaded(true); setError(errorText(e)); } });
    return () => {
      alive.current = false; cancelled.current = true;
      if (pollTimer.current) clearTimeout(pollTimer.current);
      if (runId.current) void api.agent.action(runId.current, "cancel").catch(() => undefined);
    };
  }, [errorText, note.id]);
  useEffect(() => {
    if (!run || !["queued", "running"].includes(run.status)) return;
    const timer = setTimeout(() => { void api.agent.get(run.id).then(next => { if (alive.current && !cancelled.current && runId.current === run.id) setRun(next); }).catch(e => { if (alive.current) setError(errorText(e)); }); }, 700);
    return () => clearTimeout(timer);
  }, [run, errorText]); // Each authoritative state response schedules the next bounded poll.

  async function generate() {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(""); cancelled.current = false;
    try {
      const persisted = await api.getNote(note.id);
      const handle = editor(), snapshot = handle?.getSnapshot?.();
      if (!alive.current || cancelled.current) return;
      if (!snapshot || !handle?.applyAgentEdits || !["markdown", "tiptap-json"].includes(note.contentFormat || "")) throw new Error("UNSAFE_DOCUMENT");
      const created = await api.agent.create({ noteId: note.id, instruction, selectedText: handle.getAgentSelection?.(), content: snapshot.content, format: note.contentFormat!, version: persisted.version });
      runId.current = created.id;
      if (!alive.current || cancelled.current) { await api.agent.action(created.id, "cancel"); return; }
      const latest = await api.agent.get(created.id);
      if (alive.current && !cancelled.current) setRun(latest);
    } catch (e) { if (alive.current) setError(errorText(e)); }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  }
  async function stop(action: "cancel" | "reject" = "cancel") {
    cancelled.current = true;
    if (pollTimer.current) clearTimeout(pollTimer.current);
    if (runId.current) {
      try { const next = await api.agent.action(runId.current, action); if (alive.current) setRun(next); }
      catch (e) { if (alive.current) setError(errorText(e)); }
    }
  }
  async function approve() {
    if (!run?.proposal || lock.current) return;
    lock.current = true; setBusy(true); setError("");
    try {
      const snapshot = editor()?.getSnapshot?.();
      if (!snapshot || !sameAgentSnapshot(snapshot.content, run.proposal.original, run.proposal.format)) throw new Error("VERSION_CONFLICT");
      const approved = await api.agent.approve(run.id, run.proposal.token, snapshot.content);
      if (!alive.current || cancelled.current) return;
      // Revalidate after the network round trip; the editor may have changed meanwhile.
      const handle = editor();
      if (!handle?.applyAgentEdits?.(approved.original, approved.edits)) { await stop(); throw new Error("VERSION_CONFLICT"); }
      handle.flushSave();
      setRun({ ...run, status: "applying", proposal: undefined });
      const deadline = Date.now() + 20000;
      const verify = async () => {
        if (!alive.current || cancelled.current) return;
        try {
          // Existing note GET flushes Yjs; the receipt endpoint checks persisted body and version.
          await api.getNote(note.id);
          try {
            const confirmed = await api.agent.action(run.id, "receipt");
            if (alive.current) setRun(confirmed);
            return;
          } catch (receiptError) {
            if (!(receiptError as Error).message.includes("SAVE_NOT_CONFIRMED")) throw receiptError;
          }
          if (Date.now() >= deadline) { setError(t("agent.errors.SAVE_NOT_CONFIRMED")); return; }
          pollTimer.current = setTimeout(() => { void verify(); }, 800);
        } catch (e) { if (alive.current) setError(errorText(e)); }
      };
      await verify();
    } catch (e) { if (alive.current) setError(errorText(e)); }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  }
  return <aside id="editor-ai-assistant" aria-label={t("agent.title")} onKeyDown={event => {
    if (event.key === "Escape") { event.stopPropagation(); onClose(); }
    if (event.key === "Tab" && window.matchMedia?.("(max-width: 767px)").matches) {
      const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), textarea, summary')];
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  }} className="fixed inset-0 z-50 flex flex-col overflow-hidden border-l border-app-border bg-app-surface text-tx-primary md:relative md:inset-auto md:z-auto md:w-96 md:shrink-0 md:max-w-[50%] pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
    <div className="flex shrink-0 items-center justify-between gap-2 border-b border-app-border px-4 py-3">
      <div className="flex items-center gap-2 font-medium"><Sparkles size={16} className="text-accent-primary" />{t("agent.title")}</div>
      <Button variant="ghost" size="icon" className="h-11 w-11 md:h-8 md:w-8" aria-label={t("agent.close")} title={t("agent.close")} onClick={onClose}><X size={16} /></Button>
    </div>
    <div className="shrink-0 border-b border-app-border px-4 py-3">
      <div className="flex items-center gap-2 text-xs text-tx-secondary"><span>{t("agent.scope.note")}</span>{context.selection && <span className="rounded bg-accent-primary/10 px-1.5 py-0.5 text-accent-primary">{t("agent.scope.selection")}</span>}</div>
      <p className="mt-1 truncate text-sm font-medium" title={note.title}>{note.title || t("editor.untitled")}</p>
      {context.selection && <p className="mt-2 line-clamp-2 break-words border-l-2 border-accent-primary/30 pl-2 text-xs text-tx-secondary">{context.selection}</p>}
    </div>
    <div className="flex-1 overflow-auto min-h-0 space-y-3 p-4">
      {canStart && !busy && <div className="py-4">
        <h3 className="text-base font-medium">{t(`agent.guidance.${context.kind}.title`)}</h3>
        <p className="mt-2 text-sm leading-relaxed text-tx-secondary">{t(`agent.guidance.${context.kind}.description`)}</p>
        <div className="mt-4 flex flex-wrap gap-2">{shortcuts.map(action => <Button key={action} variant="outline" size="sm" className="min-h-10 whitespace-normal text-left" disabled={busy || !enabled} onClick={() => {
          setInstruction(t(`agent.guidance.${context.kind}.prompts.${action}`)); inputRef.current?.focus();
        }}>{t(`agent.guidance.${context.kind}.actions.${action}`)}</Button>)}</div>
      </div>}
      {!loaded && <p role="status" className="text-sm text-tx-secondary">{t("agent.loading")}</p>}
      {loaded && !enabled && !error && <p role="status" className="text-sm text-tx-secondary">{t("agent.disabled")}</p>}
      {run && <p role="status">{t(`agent.states.${run.status}`)}</p>}
      {steps.map(step => <div className="rounded border border-app-border p-2 text-sm" key={step.sequence}>{t(`agent.tools.${step.toolName}`, { defaultValue: t("agent.step") })} · {t(`agent.states.${step.status === "running" && run && ["failed", "cancelled", "interrupted"].includes(run.status) ? run.status : step.status}`)}</div>)}
      {run?.proposal?.edits.map((edit, index) => <div className="rounded border border-app-border p-2 text-sm whitespace-pre-wrap break-words" key={index}>
        <div className="text-xs text-tx-secondary">{t("agent.before")}</div><del className="block bg-red-500/10">{edit.before || t("agent.emptyNote")}</del>
        <div className="text-xs text-tx-secondary">{t("agent.after")}</div><ins className="block bg-green-500/10 no-underline">{edit.after}</ins>
      </div>)}
      {(error || run?.errorCode) && <p role="alert" className="text-sm text-red-500">{error || errorText({ code: run?.errorCode })}</p>}
      {run?.status === "completed" && <p className="text-sm">{t("agent.saved")}</p>}
    </div>
    <div className="shrink-0 border-t border-app-border p-4">
    {run?.status === "waiting_approval" && <div className="flex gap-2 pb-3"><Button disabled={busy} onClick={() => void approve()}>{t("agent.accept")}</Button><Button variant="outline" disabled={busy} onClick={() => void stop("reject")}>{t("agent.reject")}</Button></div>}
    <label className="text-sm mt-2" htmlFor="agent-instruction">{t("agent.request")}</label>
    <textarea ref={inputRef} id="agent-instruction" className="mt-2 min-h-24 max-h-48 w-full resize-y rounded-lg border border-app-border bg-app-bg p-3 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-primary" maxLength={4000} value={instruction} onFocus={() => { if (canStart) setContext(readContext()); }} onChange={e => setInstruction(e.target.value)} placeholder={t(`agent.guidance.${context.kind}.placeholder`)} />
    <div className="flex gap-2 pt-2"><Button disabled={!enabled || busy || !canStart || !instruction.trim()} onClick={() => void generate()}>{run ? t("agent.regenerate") : t("agent.generate")}</Button>{(!canStart || busy) && <Button variant="outline" onClick={() => void stop()}>{t("agent.stop")}</Button>}</div>
    <details className="mt-3 text-xs leading-relaxed text-tx-secondary"><summary className="cursor-pointer rounded focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-primary">{t("agent.privacySummary")}</summary><p className="pt-2">{t("agent.privacy")}</p></details>
    </div>
  </aside>;
}
