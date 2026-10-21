import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "@/lib/api";
import { sameAgentSnapshot, type AgentRun } from "@/lib/agentEdits";
import type { NoteEditorHandle } from "@/components/editors/types";
import type { Note } from "@/types";
import { Button } from "@/components/ui/button";

export default function EditorAgentPanel({ note, editor, onClose }: { note: Note; editor: () => NoteEditorHandle | null; onClose: () => void }) {
  const { t } = useTranslation();
  const [instruction, setInstruction] = useState("");
  const [run, setRun] = useState<AgentRun | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const alive = useRef(true), lock = useRef(false), runId = useRef<string | null>(null);
  const cancelled = useRef(false);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const canStart = !run || ["completed", "failed", "cancelled", "interrupted"].includes(run.status);
  const errorText = useCallback((value: unknown) => {
    const code = (value as { code?: string; message?: string }).code || (value as Error).message || "AGENT_REQUEST_FAILED";
    return t(`agent.errors.${code}`, { defaultValue: t("agent.errors.AGENT_REQUEST_FAILED") });
  }, [t]);
  useEffect(() => {
    alive.current = true; cancelled.current = false;
    void Promise.all([api.agent.capabilities(), api.agent.latest(note.id)]).then(([capabilities, latest]) => {
      if (alive.current) { setEnabled(capabilities.enabled); setRun(latest); runId.current = latest?.id || null; }
    }).catch(() => { if (alive.current) setError(t("agent.errors.AGENT_REQUEST_FAILED")); });
    return () => {
      alive.current = false; cancelled.current = true;
      if (pollTimer.current) clearTimeout(pollTimer.current);
      if (runId.current) void api.agent.action(runId.current, "cancel").catch(() => undefined);
    };
  }, [t, note.id]);
  useEffect(() => {
    if (!run || !["queued", "running"].includes(run.status)) return;
    const timer = setTimeout(() => { void api.agent.get(run.id).then(next => { if (alive.current) setRun(next); }).catch(e => { if (alive.current) setError(errorText(e)); }); }, 700);
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
      setRun(await api.agent.get(created.id));
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
  return <aside aria-label={t("agent.title")} className="fixed inset-0 z-50 flex flex-col border-l border-app-border bg-app-surface p-3 md:relative md:inset-auto md:z-auto md:w-96 md:min-w-72 md:max-w-[50%] md:resize-x overflow-auto pb-[max(12px,env(safe-area-inset-bottom))]">
    <div className="flex items-center justify-between gap-2"><strong>{t("agent.title")}</strong><Button variant="ghost" size="sm" onClick={onClose}>{t("agent.close")}</Button></div>
    <p className="my-2 text-xs text-tx-secondary">{t("agent.privacy")}</p>
    {!enabled && <p role="status">{t("agent.disabled")}</p>}
    <div className="flex-1 overflow-auto min-h-0 space-y-2">
      {run && <p role="status">{t(`agent.states.${run.status}`)}</p>}
      {run?.steps.filter(s => s.toolName !== "run").map(step => <div className="rounded border border-app-border p-2 text-sm" key={step.sequence}>{t(`agent.tools.${step.toolName}`, { defaultValue: t("agent.step") })} · {t(`agent.states.${step.status}`)}</div>)}
      {run?.proposal?.edits.map((edit, index) => <div className="rounded border border-app-border p-2 text-sm whitespace-pre-wrap break-words" key={index}>
        <div className="text-xs text-tx-secondary">{t("agent.before")}</div><del className="block bg-red-500/10">{edit.before}</del>
        <div className="text-xs text-tx-secondary">{t("agent.after")}</div><ins className="block bg-green-500/10 no-underline">{edit.after}</ins>
      </div>)}
      {(error || run?.errorCode) && <p role="alert" className="text-sm text-red-500">{error || errorText({ code: run?.errorCode })}</p>}
      {run?.status === "completed" && <p className="text-sm">{t("agent.saved")}</p>}
    </div>
    {run?.status === "waiting_approval" && <div className="flex gap-2 py-2"><Button disabled={busy} onClick={() => void approve()}>{t("agent.accept")}</Button><Button variant="outline" disabled={busy} onClick={() => void stop("reject")}>{t("agent.reject")}</Button></div>}
    <label className="text-sm mt-2" htmlFor="agent-instruction">{t("agent.request")}</label>
    <textarea id="agent-instruction" className="min-h-20 w-full rounded border border-app-border bg-app-bg p-2 text-sm" maxLength={4000} value={instruction} onChange={e => setInstruction(e.target.value)} placeholder={t("agent.placeholder")} />
    <div className="flex gap-2 pt-2"><Button disabled={!enabled || busy || !canStart || !instruction.trim()} onClick={() => void generate()}>{run ? t("agent.regenerate") : t("agent.generate")}</Button>{(!canStart || busy) && <Button variant="outline" onClick={() => void stop()}>{t("agent.stop")}</Button>}</div>
  </aside>;
}
