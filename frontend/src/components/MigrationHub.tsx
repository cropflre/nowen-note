import { useCallback, useEffect, useRef, useState } from "react";
import { ClipboardCopy, Download, FileUp, FolderOpen, History, Loader2, RefreshCw, Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "@/lib/api";
import { getOfflineQueueStorageKey } from "@/lib/offlineScope";
import { migrationApi, migrationIsActive, type MigrationJob, type MigrationUploadProgress } from "@/lib/migrations";
import { scheduleObjectUrlRevocation } from "@/lib/reliableExportDownloadBridge";
import { confirm } from "./ui/confirm";
import McpConnectionPanel from "./settings/McpConnectionPanel";
import MigrationReviewItems from "./MigrationReviewItems";
import type { Notebook } from "@/types";

interface Props {
  workspaceId: string;
  disabled: boolean;
  localOnly?: boolean;
  onLegacyImport: () => void;
  onImported: (job: MigrationJob) => void;
  onView: (job: MigrationJob) => Promise<void>;
}

const surface = "rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4";
const button = "inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-[var(--color-border)] px-3 py-2 text-xs font-medium text-[var(--color-text-primary)] hover:bg-[var(--color-hover)] disabled:cursor-not-allowed disabled:opacity-50";
const input = "min-h-10 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-text-primary)]";
const preparatory = new Set(["CREATED", "PREVIEW_READY"]);
const terminal = new Set(["COMPLETED", "PARTIAL", "FAILED", "CANCELLED", "UNDONE"]);

export default function MigrationHub({ workspaceId, disabled, localOnly = false, onLegacyImport, onImported, onView }: Props) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<"ai" | "files" | null>(null);
  const [client, setClient] = useState("Codex");
  const [copied, setCopied] = useState(false);
  const [name, setName] = useState("");
  const [target, setTarget] = useState("");
  const [notebooks, setNotebooks] = useState<Notebook[]>([]);
  const [jobs, setJobs] = useState<MigrationJob[]>([]);
  const [job, setJob] = useState<MigrationJob | null>(null);
  const [sourceFilter, setSourceFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [reviewed, setReviewed] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{ current: number; total: number } | null>(null);
  const [fileProgress, setFileProgress] = useState<MigrationUploadProgress | null>(null);
  const resumeUploadId = useRef<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  const busyRef = useRef(false);
  const notified = useRef(new Set<string>());
  const onImportedRef = useRef(onImported);
  const initialScope = useRef(getOfflineQueueStorageKey());
  const current = useCallback(() => mounted.current && initialScope.current === getOfflineQueueStorageKey(), []);
  const available = !disabled && !localOnly && !!workspaceId;
  const selectedId = job?.id;
  const pollDelay = mode === "ai" || jobs.some((item) => migrationIsActive(item.status)) ? 2500 : 15000;

  useEffect(() => { onImportedRef.current = onImported; }, [onImported]);

  const errorText = useCallback((cause: unknown) => cause instanceof Error
    ? cause.message === "MIGRATION_ACCOUNT_CHANGED" ? t("migration.accountChanged")
      : cause.message === "MIGRATION_INVALID_RESPONSE" ? t("migration.invalidResponse") : cause.message
    : t("migration.unknownError"), [t]);

  const receive = useCallback((next: MigrationJob) => {
    if (!current()) return;
    if (!next || typeof next.id !== "string" || !next.counts || !next.source || !Array.isArray(next.warnings)) {
      throw new Error("MIGRATION_INVALID_RESPONSE");
    }
    setJob(next);
    setJobs((previous) => [next, ...previous.filter((item) => item.id !== next.id)]);
    const receipt = `${next.id}:${next.counts.imported}:${next.status}`;
    if (next.counts.imported > 0 && terminal.has(next.status) && !notified.current.has(receipt)) {
      notified.current.add(receipt);
      onImportedRef.current(next);
    }
  }, [current]);

  const refresh = useCallback(async () => {
    const list = await migrationApi.list();
    if (current()) setJobs(list);
    return list;
  }, [current]);

  useEffect(() => {
    mounted.current = true;
    if (!localOnly) {
      void refresh().catch((cause: unknown) => { if (current()) setError(errorText(cause)); });
      void api.getNotebooks(workspaceId).then((list) => { if (current()) setNotebooks(list); }).catch(() => {});
    }
    return () => { mounted.current = false; };
  }, [current, errorText, localOnly, refresh, workspaceId]);

  // Poll server-backed history so closing and reopening the page does not lose a job.
  useEffect(() => {
    if (localOnly) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const list = await refresh();
        if (selectedId && current()) {
          const next = list.find((item) => item.id === selectedId);
          if (next) receive(next);
        }
      } catch (cause) {
        if (current()) setError(errorText(cause));
      }
      if (!stopped && current()) timer = setTimeout(() => void poll(), pollDelay);
    };
    timer = setTimeout(() => void poll(), pollDelay);
    return () => { stopped = true; clearTimeout(timer); };
  }, [current, errorText, localOnly, pollDelay, receive, refresh, selectedId]);

  useEffect(() => { setReviewed(false); }, [job?.id, job?.previewDigest]);

  const run = async (operation: () => Promise<MigrationJob>) => {
    if (busyRef.current || !current()) return;
    busyRef.current = true; setBusy(true); setError("");
    try { receive(await operation()); }
    catch (cause) { if (current()) setError(errorText(cause)); }
    finally { busyRef.current = false; if (current()) setBusy(false); }
  };

  const upload = async (files: File[], resumeId: string | null = null) => {
    if (!available || busyRef.current || !files.length || !current()) return;
    if (files.some((file) => !/\.(md|markdown|html?|txt|zip)$/i.test(file.name))) {
      setError(t("migration.unsupportedFile")); return;
    }
    busyRef.current = true; setBusy(true); setError("");
    try {
      const operationId = crypto.randomUUID();
      let next = resumeId ? await migrationApi.get(resumeId) : await migrationApi.create({ operationId, name: name.trim() || t("migration.defaultName"),
        source: { platform: "files", exportId: operationId }, workspaceId,
        ...(target ? { targetNotebookId: target } : {}),
      });
      receive(next);
      for (let index = 0; index < files.length; index++) {
        if (!current()) return;
        setUploadProgress({ current: index + 1, total: files.length });
        next = await migrationApi.uploadResumable(next.id, files[index], { current, onProgress: (progress) => { if (current()) setFileProgress(progress); } });
        receive(next);
        while (["UPLOADING", "SCANNING", "NORMALIZING"].includes(next.status)) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          if (!current()) return;
          next = await migrationApi.get(next.id); receive(next);
        }
        if (!preparatory.has(next.status)) throw new Error(next.error || t("migration.uploadStopped"));
      }
      if (current()) receive(await migrationApi.preview(next.id));
    } catch (cause) { if (current()) setError(errorText(cause)); }
    finally {
      busyRef.current = false;
      if (current()) { setBusy(false); setUploadProgress(null); setFileProgress(null); }
    }
  };

  const downloadReport = async () => {
    if (!job || busyRef.current) return;
    setError("");
    try {
      const report = await migrationApi.report(job.id);
      if (!current()) return;
      const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }));
      const anchor = document.createElement("a");
      anchor.href = url; anchor.download = `nowen-migration-${job.id}.json`; anchor.click();
      scheduleObjectUrlRevocation(url);
    } catch (cause) { if (current()) setError(errorText(cause)); }
  };

  const sources = [...new Set(jobs.map((item) => item.source.platform))];
  const statuses = [...new Set(jobs.map((item) => item.status))];
  const visibleJobs = jobs.filter((item) => (!sourceFilter || item.source.platform === sourceFilter) && (!statusFilter || item.status === statusFilter));
  const statusLabel = (status: string) => t(`migration.states.${status}`, { defaultValue: status });

  return <section className="space-y-4 text-[var(--color-text-primary)]" aria-label={t("migration.title")}>
    <div><h4 className="text-base font-semibold">{t("migration.title")}</h4><p className="mt-1 text-sm text-[var(--color-text-secondary)]">{t("migration.description")}</p></div>
    {localOnly && <p className={`${surface} text-sm`}>{t("migration.localOnly")}</p>}
    {!localOnly && <>
      {disabled && <p className="text-sm text-amber-700 dark:text-amber-300">{t("migration.disabled")}</p>}
      <div className="grid gap-3 sm:grid-cols-2">
        {([{ id: "ai", icon: Sparkles }, { id: "files", icon: FileUp }] as const).map(({ id, icon: Icon }) => <button key={id} type="button" disabled={!available || busy} aria-pressed={mode === id} onClick={() => setMode(id)} className={`${surface} min-h-28 text-left transition-colors hover:border-[var(--color-accent-primary)] disabled:opacity-50 ${mode === id ? "ring-2 ring-[var(--color-accent-primary)]" : ""}`}>
          <Icon size={19} className="mb-2 text-[var(--color-accent-primary)]"/><span className="block text-sm font-semibold">{t(`migration.${id}`)}</span><span className="mt-1 block text-xs leading-5 text-[var(--color-text-secondary)]">{t(`migration.${id}Hint`)}</span>
        </button>)}
      </div>
      {mode === "ai" && <div className={`${surface} space-y-3`}>
        <label className="block text-xs font-medium">{t("migration.client")}<select className={`${input} mt-1`} value={client} onChange={(event) => setClient(event.target.value)}>{["Codex", "Claude Code", "WorkBuddy", "Qoder / QoderWork", "豆包工作"].map((value) => <option key={value}>{value}</option>)}<option value="other">{t("migration.clientOther")}</option></select></label>
        <p className="text-sm text-[var(--color-text-secondary)]">{t("migration.aiSteps")}</p>
        <button type="button" className={button} onClick={() => { void navigator.clipboard.writeText(t("migration.prompt")).then(() => setCopied(true), () => setError(t("migration.copyFailed"))); }}><ClipboardCopy size={15}/>{t(copied ? "migration.copied" : "migration.copy")}</button>
        <p className="text-xs leading-5 text-[var(--color-text-secondary)]">{t("migration.clientBoundary")}</p>
        <details><summary className="cursor-pointer text-xs text-[var(--color-accent-primary)]">{t("migration.clientGuide")}</summary><div className="mt-3 space-y-3"><p className="text-xs leading-5 text-[var(--color-text-secondary)]">{t("migration.connectionScopes")}</p><McpConnectionPanel purpose="migration"/></div></details>
      </div>}
      {mode === "files" && <div className={`${surface} space-y-3`}>
        <label className="block text-xs font-medium">{t("migration.name")}<input className={`${input} mt-1`} value={name} maxLength={200} placeholder={t("migration.defaultName")} disabled={busy} onChange={(event) => setName(event.target.value)}/></label>
        <label className="block text-xs font-medium">{t("migration.target")}<select className={`${input} mt-1`} value={target} disabled={busy} onChange={(event) => setTarget(event.target.value)}><option value="">{t("migration.newRoot")}</option>{notebooks.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <p className="text-xs leading-5 text-[var(--color-text-secondary)]">{t("migration.targetHint")}</p>
        <button type="button" className={button} disabled={!available || busy} onClick={() => { resumeUploadId.current = null; fileInput.current?.click(); }}>{busy ? <Loader2 size={15} className="animate-spin"/> : <FileUp size={15}/>} {t(busy ? "migration.uploading" : "migration.choose")}</button>
        {uploadProgress && <p role="status" className="text-xs">{t("migration.uploadCount", uploadProgress)}</p>}
        {fileProgress && <p role="status" className="text-xs">{t(`migration.${fileProgress.phase === "hashing" ? "hashing" : "uploadingProgress"}`, { percent: Math.floor(fileProgress.loaded / Math.max(1, fileProgress.total) * 100) })}</p>}
      </div>}
      {error && <p role="alert" className="break-words rounded-lg border border-red-300 p-3 text-sm text-red-700 dark:border-red-900 dark:text-red-300">{error}</p>}
      <div className={`${surface} space-y-3`}>
        <div className="flex flex-wrap items-center justify-between gap-2"><h5 className="flex items-center gap-2 text-sm font-semibold"><History size={16}/>{t("migration.history")}</h5><button type="button" className={button} disabled={busy} onClick={() => { void refresh().catch((cause: unknown) => setError(errorText(cause))); }}><RefreshCw size={14}/>{t("migration.refresh")}</button></div>
        {jobs.length > 0 && <div className="grid grid-cols-2 gap-2"><select className={input} aria-label={t("migration.sourceFilter")} value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value)}><option value="">{t("migration.all")}</option>{sources.map((value) => <option key={value}>{value}</option>)}</select><select className={input} aria-label={t("migration.statusFilter")} value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="">{t("migration.all")}</option>{statuses.map((value) => <option key={value} value={value}>{statusLabel(value)}</option>)}</select></div>}
        {!jobs.length && <p className="text-xs text-[var(--color-text-secondary)]">{t("migration.empty")}</p>}
        <div className="max-h-64 space-y-2 overflow-y-auto">{visibleJobs.map((item) => <button type="button" key={item.id} aria-label={t("migration.selectJob", { name: item.name })} disabled={busy} aria-pressed={job?.id === item.id} className={`flex w-full flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-left text-xs ${job?.id === item.id ? "border-[var(--color-accent-primary)]" : "border-[var(--color-border)]"}`} onClick={() => void run(() => migrationApi.get(item.id))}>
          <span className="min-w-0"><span className="block break-words font-medium">{item.name || item.source.platform}</span><span className="mt-1 block text-[var(--color-text-secondary)]">{item.source.platform} · {new Date(item.createdAt).toLocaleString()}</span></span><span className="shrink-0">{statusLabel(item.status)}</span>
        </button>)}</div>
      </div>
      {job && <div className={`${surface} space-y-3`} aria-label={t("migration.previewTitle")}>
        <div className="flex flex-wrap items-center justify-between gap-2"><h5 className="break-words text-sm font-semibold">{job.name || job.source.platform}</h5><span role="status" className="flex items-center gap-1.5 text-xs">{migrationIsActive(job.status) && <Loader2 size={13} className="animate-spin"/>}{statusLabel(job.status)}</span></div>
        <p className="text-xs text-[var(--color-text-secondary)]">{t("migration.target")}: {t(job.workspaceId ? "dataManager.scope.workspace" : "dataManager.scope.personal")} · {job.targetNotebookId ? notebooks.find((item) => item.id === job.targetNotebookId)?.name || t("migration.underTarget") : t("migration.newRoot")} → {job.name}</p>
        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">{(["total", "create", "existing", "skipped", "needsAttention", "imported", "failed", "attachments"] as const).map((key) => <div key={key} className="rounded-lg bg-[var(--color-bg)] p-2"><dt className="text-[11px] text-[var(--color-text-secondary)]">{t(`migration.counts.${key}`)}</dt><dd className="mt-1 text-lg font-semibold tabular-nums">{job.counts[key] || 0}</dd></div>)}</dl>
        {job.warnings.length > 0 && <div className="rounded-lg border border-amber-300 p-3 text-xs text-amber-800 dark:border-amber-900 dark:text-amber-300"><p className="font-medium">{t("migration.warnings")}</p><ul className="mt-1 list-disc space-y-1 pl-4">{job.warnings.map((warning, index) => <li className="break-words" key={index}>{warning}</li>)}</ul></div>}
        {job.error && <p className="break-words text-xs text-red-700 dark:text-red-300">{job.error}</p>}
        {job.status === "PREVIEW_READY" && <><MigrationReviewItems job={job} busy={busy} onDecision={(itemId, decision) => { setReviewed(false); void run(() => migrationApi.decide(job.id, itemId, job.previewDigest!, decision)); }}/><div className="space-y-2 border-t border-[var(--color-border)] pt-3"><p className="text-xs text-[var(--color-text-secondary)]">{t("migration.digest")}</p><label className="flex items-start gap-2 text-sm"><input className="mt-1 shrink-0" type="checkbox" checked={reviewed} disabled={busy || !available} onChange={(event) => setReviewed(event.target.checked)}/><span>{t("migration.review")}</span></label><button type="button" className={`${button} bg-[var(--color-accent-primary)] text-white`} disabled={!reviewed || !job.previewDigest || !available || busy || job.counts.needsAttention > 0} onClick={() => void run(() => migrationApi.approve(job.id, job.previewDigest!))}>{t("migration.approve")}</button><p className="text-xs text-[var(--color-text-secondary)]">{t("migration.approvalHint")}</p></div></>}
        <div className="flex flex-wrap gap-2">
          {job.status === "CREATED" && <button type="button" className={button} disabled={busy || !available} onClick={() => { resumeUploadId.current = job.id; setMode("files"); fileInput.current?.click(); }}>{t("migration.continueUpload")}</button>}
          {preparatory.has(job.status) && <button type="button" className={button} disabled={busy || !available} onClick={() => { setReviewed(false); void run(() => migrationApi.preview(job.id)); }}>{t("migration.preview")}</button>}
          {job.counts.failed > 0 && ["PARTIAL", "FAILED"].includes(job.status) && <button type="button" className={button} disabled={busy || !available} onClick={() => void run(() => migrationApi.retry(job.id))}>{t("migration.retry")}</button>}
          {job.status === "IMPORTING" && <button type="button" className={button} disabled={busy} onClick={() => void run(() => migrationApi.pause(job.id))}>{t("migration.pause")}</button>}
          {job.status === "PAUSED" && <button type="button" className={button} disabled={busy || !available} onClick={() => void run(() => migrationApi.resume(job.id))}>{t("migration.resume")}</button>}
          {!terminal.has(job.status) && <button type="button" className={button} disabled={busy} onClick={() => void run(() => migrationApi.cancel(job.id))}>{t("migration.cancel")}</button>}
          {job.rootNotebookId && job.counts.imported > 0 && job.status !== "UNDONE" && <button type="button" className={button} onClick={() => { void onView(job).catch((cause: unknown) => setError(errorText(cause))); }}><FolderOpen size={14}/>{t("migration.view")}</button>}
          <button type="button" className={button} disabled={busy} onClick={() => void downloadReport()}><Download size={14}/>{t("migration.report")}</button>
          {job.undo?.available && <button type="button" className={button} disabled={busy} onClick={() => void run(async () => {
            if (!await confirm({ title: t("migration.undoTitle"), description: t("migration.undoHint"), confirmText: t("migration.undo"), danger: true })) return job;
            return migrationApi.undo(job.id);
          })}>{t("migration.undo")}</button>}
        </div>
        {terminal.has(job.status) && job.status !== "UNDONE" && !job.undo?.available && job.undo?.reason && <p className="text-xs text-[var(--color-text-secondary)]">{t("migration.undoUnavailable")}: {job.undo.reason}</p>}
        {migrationIsActive(job.status) && <p className="text-xs text-[var(--color-text-secondary)]">{t("migration.progress", job.counts)}</p>}
      </div>}
    </>}
    <input ref={fileInput} type="file" accept=".md,.markdown,.html,.htm,.txt,.zip" multiple className="hidden" aria-label={t("migration.choose")} disabled={!available || busy} onChange={(event) => { const files = Array.from(event.currentTarget.files || []); event.currentTarget.value = ""; const resumeId = resumeUploadId.current; resumeUploadId.current = null; void upload(files, resumeId); }}/>
    <button type="button" className="min-h-10 text-xs text-[var(--color-accent-primary)]" disabled={busy} onClick={onLegacyImport}>{t("migration.legacy")}</button>
  </section>;
}
