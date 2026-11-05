import { useCallback, useEffect, useRef, useState } from "react";
import { Archive, Download, FileUp, Loader2, RefreshCw, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api, setCurrentWorkspace } from "@/lib/api";
import { aiMemoryApi, type AIConversation, type AIConversationMessage, type AIImportJob, type AIMemorySource } from "@/lib/aiMemory";
import { getOfflineQueueStorageKey } from "@/lib/offlineScope";
import { isMobileLocalMode } from "@/lib/mobileLocalMode";
import { pushNoteAppPath } from "@/lib/noteDeepLink";
import { scheduleObjectUrlRevocation } from "@/lib/reliableExportDownloadBridge";
import { confirm } from "./ui/confirm";
import type { Notebook } from "@/types";

type Tab = "archive" | "memories" | "connections";
const surface = "rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4";
const button = "inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-[var(--color-border)] px-3 py-2 text-xs font-medium hover:bg-[var(--color-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent-primary)] disabled:cursor-not-allowed disabled:opacity-50";
const input = "min-h-10 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-accent-primary)]";
function downloadJson(filename: string, data: unknown): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = filename; anchor.click(); scheduleObjectUrlRevocation(url);
}

export default function AIMemoryHub({ scope, onClose, initialTab = "archive" }: { scope: string; onClose?: () => void; initialTab?: Tab }) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>(initialTab), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const [sources, setSources] = useState<AIMemorySource[]>([]), [notebooks, setNotebooks] = useState<Notebook[]>([]);
  const [conversations, setConversations] = useState<AIConversation[]>([]), [total, setTotal] = useState(0), [offset, setOffset] = useState(0);
  const [query, setQuery] = useState(""), [submittedQuery, setSubmittedQuery] = useState(""), [filter, setFilter] = useState(""), [deleted, setDeleted] = useState(false);
  const [selected, setSelected] = useState<string | null>(null), [messages, setMessages] = useState<AIConversationMessage[]>([]);
  const [sourceId, setSourceId] = useState(""), [provider, setProvider] = useState("chatgpt"), [name, setName] = useState(""), [notebookId, setNotebookId] = useState(""), [consent, setConsent] = useState(false);
  const [jobs, setJobs] = useState<AIImportJob[]>([]), [job, setJob] = useState<AIImportJob | null>(null), [reviewed, setReviewed] = useState(false);
  const [uploading, setUploading] = useState(false);
  const upload = useRef<AbortController | null>(null), fileInput = useRef<HTMLInputElement>(null), mounted = useRef(true), activeOperation = useRef(false), archiveRequest = useRef(0);
  const localOnly = isMobileLocalMode();
  const current = useCallback(() => mounted.current && scope === getOfflineQueueStorageKey(), [scope]);
  const errorText = (cause: unknown) => {
    const text = cause instanceof Error ? cause.message : "";
    return text === "AI_MEMORY_ACCOUNT_CHANGED" ? t("aiMemory.accountChanged") : text === "AI_MEMORY_INVALID_RESPONSE" ? t("aiMemory.invalidResponse")
      : text === "AI_IMPORT_UPLOAD_LIMIT" ? t("aiMemory.uploadLimit") : text || t("aiMemory.error");
  };
  const receive = (next: AIImportJob) => {
    if (!next?.id || !next.counts || !Array.isArray(next.items) || !Array.isArray(next.warnings)) throw new Error("AI_MEMORY_INVALID_RESPONSE");
    if (!current()) return;
    setJob(next); setJobs(previous => [next, ...previous.filter(item => item.id !== next.id)]);
  };
  const perform = async (action: () => Promise<void>) => {
    if (activeOperation.current || !current()) return;
    activeOperation.current = true; setBusy(true); setError("");
    try { await action(); } catch (cause) { if (current()) setError(errorText(cause)); }
    finally { activeOperation.current = false; if (current()) setBusy(false); }
  };
  const refreshSources = useCallback(async () => {
    const list = await aiMemoryApi.sources(); if (current()) setSources(list); return list;
  }, [current]);
  const refreshArchive = useCallback(async () => {
    const sequence = ++archiveRequest.current;
    const result = await aiMemoryApi.conversations({ sourceId: filter, q: submittedQuery, offset, includeDeleted: deleted });
    if (!Array.isArray(result.items) || !Number.isFinite(result.total)) throw new Error("AI_MEMORY_INVALID_RESPONSE");
    if (current() && sequence === archiveRequest.current) { setConversations(result.items); setTotal(result.total); }
  }, [current, filter, submittedQuery, offset, deleted]);
  useEffect(() => {
    mounted.current = true;
    if (!localOnly) {
      void refreshSources().catch(cause => { if (current()) setError(errorText(cause)); });
      void api.getNotebooks("personal").then(list => { if (current()) setNotebooks(list.filter(item => !item.workspaceId)); }).catch(cause => { if (current()) setError(errorText(cause)); });
      void aiMemoryApi.imports().then(list => { if (current()) setJobs(list); }).catch(cause => { if (current()) setError(errorText(cause)); });
    }
    return () => { mounted.current = false; upload.current?.abort(); };
  }, [scope, localOnly, current, refreshSources]);
  useEffect(() => {
    if (!localOnly && tab === "archive") void refreshArchive().catch(cause => { if (current()) setError(errorText(cause)); });
  }, [tab, localOnly, refreshArchive, current]);
  useEffect(() => {
    if (job?.status !== "IMPORTING") return;
    let inFlight = false;
    const timer = setInterval(() => {
      if (inFlight || !current()) return; inFlight = true;
      void aiMemoryApi.importJob(job.id).then(next => { if (current()) { receive(next); if (next.status !== "IMPORTING") void refreshSources(); } })
        .catch(cause => { if (current()) setError(errorText(cause)); }).finally(() => { inFlight = false; });
    }, 1500);
    return () => clearInterval(timer);
  }, [job?.id, job?.status, current, refreshSources]);
  const chooseJob = (next: AIImportJob) => { setReviewed(false); setSourceId(next.sourceId); receive(next); };
  const completeness = (value: string) => t(`aiMemory.${["complete", "partial"].includes(value) ? value : "unknown"}`);
  const openNote = (id: string) => {
    if (!current()) return;
    setCurrentWorkspace("personal"); window.dispatchEvent(new CustomEvent("nowen:workspace-changed", { detail: { workspaceId: "personal" } }));
    pushNoteAppPath(id); onClose?.();
  };
  const downloadReport = () => {
    if (!job) return;
    downloadJson(`nowen-ai-import-${job.id}.json`, job);
  };
  const exportConversation = async (conversation: AIConversation) => {
    const exported = await aiMemoryApi.exportConversation(conversation.id);
    if (!current()) return;
    downloadJson(`nowen-ai-conversation-${conversation.id}.json`, exported);
  };
  return <section className="flex min-h-0 flex-1 flex-col text-[var(--color-text-primary)]" aria-label={t("aiMemory.title")}>
    <header className="flex shrink-0 items-start justify-between gap-3 border-b border-[var(--color-border)] p-4 sm:p-5">
      <div className="min-w-0"><h2 className="flex items-center gap-2 text-lg font-semibold"><Archive size={20}/>{t("aiMemory.title")}</h2><p className="mt-1 text-xs leading-5 text-[var(--color-text-secondary)]">{t("aiMemory.description")}</p></div>
      {onClose && <button type="button" onClick={onClose} aria-label={t("aiMemory.close")} className={`${button} shrink-0`}><X size={17}/></button>}
    </header>
    <nav className="flex shrink-0 gap-1 overflow-x-auto border-b border-[var(--color-border)] p-2" aria-label={t("aiMemory.title")}>
      {(["archive", "memories", "connections"] as const).map(value => <button type="button" key={value} aria-pressed={tab === value} onClick={() => setTab(value)} className={`${button} whitespace-nowrap ${tab === value ? "bg-[var(--color-hover)] text-[var(--color-accent-primary)]" : ""}`}>{t(`aiMemory.${value}`)}</button>)}
    </nav>
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:p-5">
      <p className="text-xs leading-5 text-[var(--color-text-secondary)]">{t("aiMemory.scope")}</p>
      {error && <p role="alert" className="break-words rounded-lg border border-red-300 p-3 text-sm text-red-700 dark:border-red-900 dark:text-red-300">{error}</p>}
      {localOnly ? <p className={surface}>{t("aiMemory.deviceOnly")}</p> : tab === "memories" ? <p className={`${surface} text-sm leading-6`}>{t("aiMemory.planned")}</p> : tab === "archive" ? <>
        <form className="flex flex-wrap gap-2" onSubmit={event => { event.preventDefault(); setOffset(0); setSubmittedQuery(query); }}>
          <input className={`${input} min-w-0 flex-1 basis-40`} aria-label={t("aiMemory.search")} placeholder={t("aiMemory.search")} value={query} maxLength={200} onChange={event => setQuery(event.target.value)}/>
          <select className={`${input} sm:max-w-52`} aria-label={t("aiMemory.allSources")} value={filter} onChange={event => { setOffset(0); setFilter(event.target.value); }}><option value="">{t("aiMemory.allSources")}</option>{sources.map(source => <option key={source.id} value={source.id}>{source.displayName}</option>)}</select>
          <button className={button} type="submit">{t("aiMemory.search")}</button><button className={button} type="button" disabled={busy} onClick={() => void perform(refreshArchive)} aria-label={t("aiMemory.refresh")}><RefreshCw size={15}/></button>
        </form>
        <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={deleted} onChange={event => { setOffset(0); setDeleted(event.target.checked); }}/>{t("aiMemory.showDeleted")}</label>
        {!conversations.length && <p className={`${surface} text-sm leading-6`}>{t("aiMemory.empty")}</p>}
        {conversations.map(conversation => <article key={conversation.id} className={`${surface} min-w-0 space-y-3`}>
          <div><h3 className="break-words text-sm font-semibold">{conversation.title}</h3><p className="mt-1 text-xs leading-5 text-[var(--color-text-secondary)]">{sources.find(source => source.id === conversation.sourceId)?.displayName} · {t("aiMemory.messageCount", { count: conversation.messageCount })} · {completeness(conversation.completeness)}<br/>{t("aiMemory.savedAt")}: {conversation.lastSyncedAt}</p></div>
          {conversation.projectionStatus === "conflict" && <p className="text-xs text-amber-700 dark:text-amber-300">{t("aiMemory.projectionConflict")}</p>}
          <div className="flex flex-wrap gap-2">
            {!conversation.deletedAt && <button type="button" className={button} disabled={busy} onClick={() => void perform(async () => { const next = await aiMemoryApi.messages(conversation.id); if (current()) { setSelected(conversation.id); setMessages(next); } })}>{t("aiMemory.viewMessages")}</button>}
            {!conversation.deletedAt && conversation.noteId && <button type="button" className={button} onClick={() => openNote(conversation.noteId!)}>{t("aiMemory.openNote")}</button>}
            {!conversation.deletedAt && <button type="button" className={button} disabled={busy} onClick={() => void perform(() => exportConversation(conversation))}><Download size={15}/>{t("aiMemory.exportConversation")}</button>}
            {conversation.deletedAt ? <button type="button" className={button} disabled={busy} onClick={() => void perform(async () => { await aiMemoryApi.restoreConversation(conversation.id); await refreshArchive(); })}>{t("aiMemory.restore")}</button> : <button type="button" className={button} disabled={busy} onClick={() => void perform(async () => { if (!await confirm({ title: t("aiMemory.deleteTitle"), description: t("aiMemory.deleteHint") }) || !current()) return; await aiMemoryApi.deleteConversation(conversation.id); setSelected(null); setMessages([]); await refreshArchive(); })}>{t("aiMemory.delete")}</button>}
            {!conversation.deletedAt && conversation.projectionStatus === "conflict" && <button type="button" className={button} disabled={busy} onClick={() => void perform(async () => { if (!await confirm({ title: t("aiMemory.rebuildTitle"), description: t("aiMemory.rebuildHint") }) || !current()) return; await aiMemoryApi.rebuildNote(conversation.id); await refreshArchive(); })}>{t("aiMemory.rebuild")}</button>}
          </div>
          {selected === conversation.id && messages.map(message => <div key={message.id} className="min-w-0 border-t border-[var(--color-border)] pt-3"><p className="text-xs font-medium">{message.role} · {message.captureState}</p><pre className="mt-1 whitespace-pre-wrap break-words font-sans text-sm leading-6 [overflow-wrap:anywhere]">{message.text}</pre></div>)}
        </article>)}
        <div className="flex items-center justify-between gap-3"><button type="button" className={button} disabled={!offset || busy} onClick={() => setOffset(Math.max(0, offset - 30))}>{t("aiMemory.previous")}</button><span className="text-xs tabular-nums">{Math.min(offset + 1, total)}–{Math.min(offset + 30, total)} / {total}</span><button type="button" className={button} disabled={offset + 30 >= total || busy} onClick={() => setOffset(offset + 30)}>{t("aiMemory.next")}</button></div>
      </> : <>
        {!sources.length && <p className={`${surface} text-sm leading-6`}>{t("aiMemory.sourceEmpty")}</p>}
        {sources.map(source => <article key={source.id} className={`${surface} space-y-2`}><h3 className="break-words text-sm font-semibold">{source.displayName} · {source.provider}</h3><p className="text-xs text-[var(--color-text-secondary)]">{t(source.permissionState === "revoked" ? "aiMemory.revoked" : source.captureEnabled ? "aiMemory.autoOn" : "aiMemory.autoOff")}{source.lastSyncedAt ? ` · ${t("aiMemory.savedAt")}: ${source.lastSyncedAt}` : ""}</p><div className="flex flex-wrap gap-2">
          <button type="button" className={button} disabled={busy} onClick={() => void perform(async () => { await aiMemoryApi.updateSource(source.id, source.permissionState === "revoked" ? { permissionState: "granted", captureEnabled: false } : { captureEnabled: !source.captureEnabled }); await refreshSources(); })}>{t(source.permissionState === "revoked" ? "aiMemory.reconnect" : source.captureEnabled ? "aiMemory.pause" : "aiMemory.enable")}</button>
          {source.permissionState === "granted" && <button type="button" className={button} disabled={busy} onClick={() => void perform(async () => { if (!await confirm({ title: t("aiMemory.revokeTitle"), description: t("aiMemory.revokeHint") }) || !current()) return; await aiMemoryApi.revokeSource(source.id); await refreshSources(); })}>{t("aiMemory.revoke")}</button>}
        </div></article>)}
        <details className={surface}><summary className="cursor-pointer text-sm font-semibold">{t("aiMemory.createSource")}</summary><form className="mt-4 space-y-3" onSubmit={event => { event.preventDefault(); void perform(async () => { if (!consent || !notebookId) return; const next = await aiMemoryApi.createSource({ provider, notebookId, displayName: name.trim() || provider, accountScope: `import:${crypto.randomUUID()}`, permissionState: "granted", captureEnabled: false }); if (!current()) return; setSourceId(next.id); setConsent(false); await refreshSources(); }); }}>
          <label className="block text-xs">{t("aiMemory.provider")}<select className={`${input} mt-1`} value={provider} onChange={event => setProvider(event.target.value)}><option value="chatgpt">ChatGPT</option><option value="doubao">豆包 / Doubao</option><option value="standard">JSON / Markdown / TXT</option></select></label>
          <label className="block text-xs">{t("aiMemory.displayName")}<input className={`${input} mt-1`} maxLength={200} value={name} onChange={event => setName(event.target.value)}/></label>
          <label className="block text-xs">{t("aiMemory.notebook")}<select className={`${input} mt-1`} value={notebookId} onChange={event => setNotebookId(event.target.value)}><option value="">{t("aiMemory.chooseNotebook")}</option>{notebooks.map(notebook => <option key={notebook.id} value={notebook.id}>{notebook.name}</option>)}</select></label>
          <p className="text-xs leading-5 text-[var(--color-text-secondary)]">{t("aiMemory.accountHint")}</p><label className="flex items-start gap-2 text-xs leading-5"><input type="checkbox" className="mt-1" checked={consent} onChange={event => setConsent(event.target.checked)}/>{t("aiMemory.sourceConsent")}</label><button type="submit" className={button} disabled={busy || !consent || !notebookId}>{t("aiMemory.create")}</button>
        </form></details>
        <section className={`${surface} space-y-3`}><h3 className="text-sm font-semibold">{t("aiMemory.import")}</h3><p className="text-xs leading-5 text-[var(--color-text-secondary)]">{t("aiMemory.importHint")}</p><p className="text-xs leading-5 text-[var(--color-text-secondary)]">{t("aiMemory.importLimits")}</p>
          <select className={input} aria-label={t("aiMemory.chooseSource")} value={sourceId} disabled={busy || uploading} onChange={event => { setSourceId(event.target.value); setJob(null); setReviewed(false); }}><option value="">{t("aiMemory.chooseSource")}</option>{sources.filter(source => source.permissionState === "granted").map(source => <option key={source.id} value={source.id}>{source.displayName}</option>)}</select>
          <input type="file" ref={fileInput} className="hidden" accept=".zip,.json,.md,.markdown,.txt" onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; if (!file || !sourceId || activeOperation.current) return; setJob(null); setReviewed(false); setUploading(true); upload.current = new AbortController(); void perform(async () => { try { receive(await aiMemoryApi.previewImport(sourceId, file, upload.current!.signal)); } finally { if (current()) setUploading(false); upload.current = null; } }); }}/>
          <div className="flex flex-wrap gap-2"><button type="button" className={button} disabled={!sourceId || busy || uploading} onClick={() => fileInput.current?.click()}>{uploading ? <Loader2 size={15} className="animate-spin motion-reduce:animate-none"/> : <FileUp size={15}/>} {t(uploading ? "aiMemory.uploading" : "aiMemory.chooseFile")}</button>{uploading && <button type="button" className={button} onClick={() => upload.current?.abort()}>{t("aiMemory.abort")}</button>}</div>
        </section>
        {job && <section className={`${surface} space-y-3`} aria-label={job.filename}><h3 className="break-words text-sm font-semibold">{job.filename} · {t(`aiMemory.states.${job.status}`)}</h3><p role="status" className="text-sm">{t("aiMemory.imported", job.counts)}</p>
          {job.warnings.map((warning, index) => <p key={index} className="break-words text-xs leading-5 text-amber-700 dark:text-amber-300">{warning}</p>)}
          {["PARTIAL", "FAILED", "INTERRUPTED"].includes(job.status) && <p role="alert" className="text-sm">{t("aiMemory.partialError")}</p>}
          <div className="max-h-80 space-y-2 overflow-y-auto">{job.items.map(item => <details key={item.index} className="rounded-lg border border-[var(--color-border)] p-3"><summary className="cursor-pointer break-words text-xs leading-5">{item.title} · {t("aiMemory.messageCount", { count: item.messages })} · {completeness(item.completeness)} · {t(`aiMemory.states.${item.status}`)}</summary><p className="mt-2 text-xs">{item.expectedRevision ? t("aiMemory.existing", { revision: item.expectedRevision }) : t("aiMemory.newConversation")}</p>{item.preview && <pre aria-label={t("aiMemory.previewText")} className="mt-2 whitespace-pre-wrap break-words font-sans text-xs leading-5 [overflow-wrap:anywhere]">{item.preview}</pre>}{item.error && <code className="mt-2 block break-all text-xs">{item.error}</code>}{item.noteId && <button type="button" className={`${button} mt-2`} onClick={() => openNote(item.noteId!)}>{t("aiMemory.openNote")}</button>}</details>)}</div>
          {job.status === "PREVIEW" && <label className="flex items-start gap-2 text-xs leading-5"><input type="checkbox" className="mt-1" checked={reviewed} onChange={event => setReviewed(event.target.checked)}/>{t("aiMemory.reviewed")}</label>}
          <div className="flex flex-wrap gap-2">{job.status === "PREVIEW" && <button type="button" className={button} disabled={!reviewed || busy || sourceId !== job.sourceId} onClick={() => void perform(async () => { receive(await aiMemoryApi.startImport(job)); setReviewed(false); })}>{t("aiMemory.start")}</button>}
            {job.status === "IMPORTING" && <button type="button" className={button} disabled={busy} onClick={() => void perform(async () => receive(await aiMemoryApi.cancelImport(job.id)))}>{t("aiMemory.cancel")}</button>}
            {["PARTIAL", "FAILED", "INTERRUPTED", "CANCELLED"].includes(job.status) && <button type="button" className={button} disabled={busy} onClick={() => void perform(async () => receive(await aiMemoryApi.retryImport(job)))}>{t("aiMemory.retry")}</button>}
            <button type="button" className={button} onClick={downloadReport}><Download size={15}/>{t("aiMemory.report")}</button>{job.status !== "IMPORTING" && <button type="button" className={button} disabled={busy} onClick={() => void perform(async () => { await aiMemoryApi.discardImport(job.id); if (current()) { setJobs(previous => previous.filter(item => item.id !== job.id)); setJob(null); } })}>{t("aiMemory.discard")}</button>}</div><p className="text-xs leading-5 text-[var(--color-text-secondary)]">{t("aiMemory.cancelledHint")}</p>
        </section>}
        <section className={`${surface} space-y-2`}><h3 className="text-sm font-semibold">{t("aiMemory.jobHistory")}</h3>{!jobs.length && <p className="text-xs text-[var(--color-text-secondary)]">{t("aiMemory.noJobs")}</p>}{jobs.map(item => <button type="button" key={item.id} disabled={busy} className={`${button} w-full justify-start break-words text-left`} onClick={() => void perform(async () => chooseJob(await aiMemoryApi.importJob(item.id)))}>{item.filename} · {t(`aiMemory.states.${item.status}`)}</button>)}</section>
      </>}
    </div>
  </section>;
}
