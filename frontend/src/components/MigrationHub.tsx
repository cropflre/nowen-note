import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Download, FolderOpen, History, Info, Loader2, Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "@/lib/api";
import { getOfflineQueueStorageKey } from "@/lib/offlineScope";
import { migrationApi, migrationIsActive, type MigrationJob } from "@/lib/migrations";
import { scheduleObjectUrlRevocation } from "@/lib/reliableExportDownloadBridge";
import { detectAIChatExport, type AIChatExport } from "@/lib/aiChatExport";
import { openAIMemory } from "@/lib/aiMemory";
import { useSiteSettings } from "@/hooks/useSiteSettings";
import {
  IMPORT_ACCEPT, filesFromInput, importErrorKind, importPhase, importRisks, packageImport, planImport, warningText,
  type ImportErrorKind, type ImportFile,
} from "@/lib/smartImport";
import { Button } from "@/components/ui/button";
import { confirm } from "./ui/confirm";
import MigrationReviewItems from "./MigrationReviewItems";
import ImportDropZone from "./smartImport/ImportDropZone";
import AssistantMove from "./smartImport/AssistantMove";
import type { Notebook } from "@/types";

interface Props {
  workspaceId: string;
  disabled: boolean;
  localOnly?: boolean;
  onLegacyImport: () => void;
  onImported: (job: MigrationJob) => void;
  onView: (job: MigrationJob) => Promise<void>;
}

type Problem = ImportErrorKind | "no-notes" | "unsupported-files" | "invalid";
type Preparing = { stage: "packaging" | "hashing" | "uploading" | "checking"; percent?: number; current: number; total: number };

const card = "space-y-4 rounded-2xl border border-app-border bg-app-surface p-5";
const field = "min-h-10 w-full rounded-lg border border-app-border bg-app-bg px-3 py-2 text-sm text-tx-primary";
const preparatory = new Set(["CREATED", "PREVIEW_READY"]);
const terminal = new Set(["COMPLETED", "PARTIAL", "FAILED", "CANCELLED", "UNDONE"]);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * "Import notes": drop files, the server identifies and checks them, you confirm one summary, done.
 * Everything else (where to put it, per-note choices, the AI assistant path, history) stays out of the way
 * until it is needed. The server-side migration jobs underneath are unchanged.
 */
export default function MigrationHub({ workspaceId, disabled, localOnly = false, onLegacyImport, onImported, onView }: Props) {
  const { t } = useTranslation();
  const [view, setView] = useState<"files" | "assistant">("files");
  const [target, setTarget] = useState("");
  const [locationOpen, setLocationOpen] = useState(false);
  const [notebooks, setNotebooks] = useState<Notebook[]>([]);
  const [jobs, setJobs] = useState<MigrationJob[]>([]);
  const [job, setJob] = useState<MigrationJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [preparing, setPreparing] = useState<Preparing | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  // An AI chat export waiting for the person to choose where it goes.
  const [chatExport, setChatExport] = useState<(AIChatExport & { files: ImportFile[] }) | null>(null);
  const { siteConfig } = useSiteSettings();
  const [skipped, setSkipped] = useState(0);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const resumeInput = useRef<HTMLInputElement>(null);
  const stopRequested = useRef(false);
  const mounted = useRef(true);
  const busyRef = useRef(false);
  const notified = useRef(new Set<string>());
  const onImportedRef = useRef(onImported);
  const initialScope = useRef(getOfflineQueueStorageKey());
  const current = useCallback(() => mounted.current && initialScope.current === getOfflineQueueStorageKey(), []);
  const available = !disabled && !localOnly && !!workspaceId;
  const selectedId = job?.id;
  const phase = importPhase(job, preparing !== null);
  const pollDelay = view === "assistant" || jobs.some((item) => migrationIsActive(item.status)) ? 2500 : 15000;

  useEffect(() => { onImportedRef.current = onImported; }, [onImported]);

  const problemOf = useCallback((cause: unknown): Problem => (
    cause instanceof Error && cause.message === "MIGRATION_INVALID_RESPONSE" ? "invalid" : importErrorKind(cause)
  ), []);

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
      void refresh().catch((cause: unknown) => { if (current()) setProblem(problemOf(cause)); });
      void api.getNotebooks(workspaceId).then((list) => { if (current()) setNotebooks(list); }).catch(() => {});
    }
    return () => { mounted.current = false; };
  }, [current, localOnly, problemOf, refresh, workspaceId]);

  // Jobs live on the server: closing and reopening the page, or an assistant preparing one, shows up here.
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
        if (current()) setProblem(problemOf(cause));
      }
      if (!stopped && current()) timer = setTimeout(() => void poll(), pollDelay);
    };
    timer = setTimeout(() => void poll(), pollDelay);
    return () => { stopped = true; clearTimeout(timer); };
  }, [current, localOnly, pollDelay, problemOf, receive, refresh, selectedId]);

  const run = async (operation: () => Promise<MigrationJob>) => {
    if (busyRef.current || !current()) return;
    busyRef.current = true; setBusy(true); setProblem(null);
    try { receive(await operation()); }
    catch (cause) { if (current()) setProblem(problemOf(cause)); }
    finally { busyRef.current = false; if (current()) setBusy(false); }
  };

  const start = async (files: ImportFile[], resumeId: string | null = null, asNotes = false) => {
    if (!available || busyRef.current || !current()) return;
    if (!resumeId && !asNotes) {
      const chat = await detectAIChatExport(files);
      if (chat) { if (current()) { setProblem(null); setChatExport({ ...chat, files }); } return; }
    }
    const plan = planImport(files, t("migration.defaultName"));
    if (!plan.ok) {
      setProblem(plan.reason === "too-large" || plan.reason === "too-many" ? "size" : plan.reason === "unsupported" ? "unsupported-files" : "no-notes");
      return;
    }
    busyRef.current = true; setBusy(true); setProblem(null); setDetailsOpen(false); setSkipped(plan.unsupported.length);
    stopRequested.current = false;
    setPreparing({ stage: "checking", current: 1, total: plan.uploads.length });
    try {
      const operationId = crypto.randomUUID();
      let next = resumeId ? await migrationApi.get(resumeId) : await migrationApi.create({
        operationId, name: plan.name, source: { platform: "files", exportId: operationId }, workspaceId,
        ...(target ? { targetNotebookId: target } : {}),
      });
      receive(next);
      for (let index = 0; index < plan.uploads.length; index++) {
        if (!current() || stopRequested.current) return;
        const step = (stage: Preparing["stage"], percent?: number) => { if (current()) setPreparing({ stage, percent, current: index + 1, total: plan.uploads.length }); };
        const upload = plan.uploads[index];
        const file = upload.kind === "file" ? upload.file : await packageImport(upload.name, upload.entries, (percent) => step("packaging", percent));
        if (!current() || stopRequested.current) return;
        next = await migrationApi.uploadResumable(next.id, file, { current, onProgress: (progress) => step(progress.phase, Math.floor(progress.loaded / Math.max(1, progress.total) * 100)) });
        receive(next);
        step("checking");
        // The server checks and sorts each file in the background; the next one waits for it.
        while (["UPLOADING", "SCANNING", "NORMALIZING"].includes(next.status)) {
          await sleep(1000);
          if (!current() || stopRequested.current) return;
          next = await migrationApi.get(next.id); receive(next);
        }
        // A job that failed or was cancelled explains itself in its own card below.
        if (terminal.has(next.status)) return;
        if (!preparatory.has(next.status)) throw Object.assign(new Error(next.error || "MIGRATION_PROCESS_FAILED"), { code: next.error || "MIGRATION_PROCESS_FAILED" });
      }
      if (current() && !stopRequested.current) receive(await migrationApi.preview(next.id));
    } catch (cause) { if (current() && !stopRequested.current) setProblem(problemOf(cause)); }
    finally {
      busyRef.current = false;
      if (current()) { setBusy(false); setPreparing(null); }
    }
  };

  const stop = async () => {
    stopRequested.current = true;
    if (job && !terminal.has(job.status)) {
      try { receive(await migrationApi.cancel(job.id)); } catch (cause) { if (current()) setProblem(problemOf(cause)); }
    }
  };

  const reset = () => { setJob(null); setProblem(null); setSkipped(0); setDetailsOpen(false); setView("files"); };
  const openAssistant = () => { reset(); setView("assistant"); };

  const downloadReport = async () => {
    if (!job || busyRef.current) return;
    try {
      const report = await migrationApi.report(job.id);
      if (!current()) return;
      const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }));
      const anchor = document.createElement("a");
      anchor.href = url; anchor.download = `nowen-import-${job.id}.json`; anchor.click();
      scheduleObjectUrlRevocation(url);
    } catch (cause) { if (current()) setProblem(problemOf(cause)); }
  };

  const openNotes = (item: MigrationJob) => { void onView(item).catch((cause: unknown) => setProblem(problemOf(cause))); };
  const undo = (item: MigrationJob) => void run(async () => {
    if (!await confirm({ title: t("migration.undoTitle"), description: t("migration.undoHint"), confirmText: t("migration.undo"), danger: true })) return item;
    return migrationApi.undo(item.id);
  });
  const statusLabel = (status: string) => t(`migration.states.${status}`, { defaultValue: status });
  const place = (item: MigrationJob) => {
    const parent = item.targetNotebookId ? notebooks.find((notebook) => notebook.id === item.targetNotebookId)?.name : "";
    return parent ? t("migration.smart.underFolder", { parent, name: item.name }) : t("migration.smart.newFolder", { name: item.name });
  };
  const space = (item: MigrationJob) => t(item.workspaceId ? "dataManager.scope.workspace" : "dataManager.scope.personal");

  const problemCard = problem && <div role="alert" className="space-y-3 rounded-2xl border border-amber-300/70 bg-amber-50/60 p-4 text-sm text-tx-primary dark:border-amber-900 dark:bg-amber-950/30">
    <p className="flex items-start gap-2"><AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
      {problem === "account" ? t("migration.accountChanged") : problem === "invalid" ? t("migration.invalidResponse") : t(`migration.smart.errors.${problem}`)}</p>
    <div className="flex flex-wrap gap-2">
      {job?.status === "CREATED" && ["network", "changed", "unknown"].includes(problem) && <Button type="button" size="sm" disabled={busy || !available} onClick={() => resumeInput.current?.click()}>{t("migration.smart.resume")}</Button>}
      {job?.status === "PREVIEW_READY" && problem === "changed" && <Button type="button" size="sm" disabled={busy || !available} onClick={() => void run(() => migrationApi.preview(job.id))}>{t("migration.smart.recheck")}</Button>}
      {["no-notes", "unsupported-files", "format", "encoding", "size"].includes(problem) && <Button type="button" size="sm" variant="outline" onClick={reset}>{t("migration.smart.startOver")}</Button>}
      {["unsupported-files", "format"].includes(problem) && <Button type="button" size="sm" variant="outline" onClick={openAssistant}>{t("migration.smart.useAssistant")}</Button>}
    </div>
  </div>;

  const chatChoice = chatExport && <section className={card} aria-label={t("migration.smart.chat.title")}>
    <h5 className="text-base font-semibold text-tx-primary">{t("migration.smart.chat.title")}</h5>
    <p className="text-sm text-tx-secondary">{t(siteConfig.aiMemoryEnabled ? "migration.smart.chat.hint" : "migration.smart.chat.off")}</p>
    <div className="flex flex-wrap gap-2">
      {siteConfig.aiMemoryEnabled && <Button type="button" onClick={() => { const { file, provider } = chatExport; setChatExport(null); openAIMemory("connections", { file, provider }); }}>{t("migration.smart.chat.toArchive")}</Button>}
      <Button type="button" variant="outline" disabled={!available || busy} onClick={() => { const { files } = chatExport; setChatExport(null); void start(files, null, true); }}>{t("migration.smart.chat.asNotes")}</Button>
      <Button type="button" variant="ghost" onClick={() => setChatExport(null)}>{t("migration.smart.startOver")}</Button>
    </div>
  </section>;

  const startView = chatChoice || <>
    {view === "assistant"
      ? <AssistantMove jobs={jobs} notebooks={notebooks} disabled={!available || busy} onBack={() => setView("files")}
        onOpenJob={(prepared) => { setView("files"); void run(() => migrationApi.get(prepared.id)); }} />
      : <div className="space-y-3">
        <ImportDropZone disabled={!available || busy} onFiles={(files) => void start(files)} />
        <div className="text-xs text-tx-secondary">
          {t("migration.smart.location", { place: target ? t("migration.smart.locationUnder", { name: notebooks.find((item) => item.id === target)?.name || "" }) : t("migration.smart.locationNew") })}
          {" "}<button type="button" className="text-accent-primary hover:underline" aria-expanded={locationOpen} onClick={() => setLocationOpen((open) => !open)}>{t("migration.smart.changeLocation")}</button>
        </div>
        {locationOpen && <label className="block max-w-md text-xs font-medium text-tx-primary">{t("migration.target")}
          <select className={`${field} mt-1`} value={target} disabled={busy} onChange={(event) => setTarget(event.target.value)}>
            <option value="">{t("migration.smart.locationNew")}</option>
            {notebooks.map((item) => <option key={item.id} value={item.id}>{t("migration.smart.locationUnder", { name: item.name })}</option>)}
          </select>
          <span className="mt-1 block font-normal text-tx-secondary">{t("migration.smart.locationHint")}</span>
        </label>}
        <Button type="button" variant="link" size="sm" className="h-auto min-h-8 whitespace-normal py-1 text-left px-0" onClick={() => { setProblem(null); setView("assistant"); }}>
          <Sparkles size={14} className="mr-1.5" aria-hidden="true" />{t("migration.smart.assistantLink")}
        </Button>
      </div>}
  </>;

  const notices = job && phase === "preview" ? [
    ...(job.counts.existing > 0 ? [{ key: "existing", tone: "info", text: t("migration.smart.existing", { count: job.counts.existing }) }] : []),
    ...(job.counts.needsAttention > 0 ? [{ key: "attention", tone: "warn", text: t("migration.smart.attention", { count: job.counts.needsAttention }) }] : []),
    ...importRisks(job.warnings).map((risk) => ({ key: risk, tone: "warn", text: t(`migration.smart.risks.${risk}`) })),
    ...(skipped > 0 ? [{ key: "skipped", tone: "warn", text: t("migration.smart.skippedFiles", { count: skipped }) }] : []),
  ] : [];

  const jobView = phase !== "start" && <section className={card} aria-label={t("migration.smart.resultRegion")}>
    {phase === "preparing" && <>
      <h5 className="flex items-center gap-2 text-base font-semibold text-tx-primary"><Loader2 size={18} className="animate-spin" aria-hidden="true" />{t("migration.smart.preparing")}</h5>
      {preparing && <div className="space-y-2" role="status">
        <p className="text-sm text-tx-secondary">{t(`migration.smart.stage.${preparing.stage}`, { percent: preparing.percent ?? 0 })}{preparing.total > 1 ? ` · ${t("migration.smart.fileProgress", { current: preparing.current, total: preparing.total })}` : ""}</p>
        {preparing.percent !== undefined && <div className="h-1.5 overflow-hidden rounded-full bg-app-hover"><div className="h-full bg-accent-primary transition-[width]" style={{ width: `${preparing.percent}%` }} /></div>}
      </div>}
      <Button type="button" variant="outline" size="sm" onClick={() => void stop()}>{t("migration.smart.stop")}</Button>
    </>}
    {job && phase === "incomplete" && <>
      <h5 className="text-base font-semibold text-tx-primary">{t("migration.smart.incompleteTitle")}</h5>
      <p className="text-sm text-tx-secondary">{t("migration.smart.incompleteHint")}</p>
      <div className="flex flex-wrap gap-2">
        <Button type="button" disabled={busy || !available} onClick={() => resumeInput.current?.click()}>{t("migration.smart.resume")}</Button>
        <Button type="button" variant="ghost" disabled={busy} onClick={() => void run(() => migrationApi.cancel(job.id))}>{t("migration.smart.cancelImport")}</Button>
      </div>
    </>}
    {job && phase === "preview" && <>
      <div className="space-y-1">
        <h5 className="text-base font-semibold text-tx-primary">{job.counts.attachments
          ? t("migration.smart.found", { count: job.counts.total, attachments: t("migration.smart.attachmentCount", { count: job.counts.attachments }) })
          : t("migration.smart.foundNotesOnly", { count: job.counts.total })}</h5>
        <p className="text-sm text-tx-secondary">{t("migration.smart.destination", { space: space(job), place: place(job) })}</p>
        {job.preparedBy === "assistant" && <p className="text-xs text-tx-secondary">{t("migration.smart.preparedByAssistant")}</p>}
      </div>
      {notices.length > 0 && <ul className="space-y-1.5">{notices.map((notice) => <li key={notice.key} className="flex items-start gap-2 text-sm text-tx-primary">
        {notice.tone === "info" ? <Info size={15} className="mt-0.5 shrink-0 text-tx-secondary" aria-hidden="true" /> : <AlertTriangle size={15} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />}
        <span>{notice.text}</span>
      </li>)}</ul>}
      <div className="flex flex-wrap items-center gap-2">
        {job.counts.create > 0
          ? <Button type="button" disabled={!job.previewDigest || !available || busy || job.counts.needsAttention > 0} onClick={() => void run(() => migrationApi.approve(job.id, job.previewDigest!))}>
            {t("migration.smart.importCount", { count: job.counts.create })}
          </Button>
          : <p className="text-sm text-tx-secondary">{t("migration.smart.nothingNew")}</p>}
        <Button type="button" variant="outline" aria-expanded={detailsOpen} onClick={() => setDetailsOpen((open) => !open)}>{t(detailsOpen ? "migration.smart.hideDetails" : "migration.smart.details")}</Button>
        <Button type="button" variant="ghost" disabled={busy} onClick={() => void run(() => migrationApi.cancel(job.id))}>{t("migration.smart.cancelImport")}</Button>
      </div>
      <Button type="button" variant="link" size="sm" className="h-auto min-h-8 whitespace-normal py-1 text-left px-0 text-tx-secondary" onClick={reset}>{t("migration.smart.later")}</Button>
    </>}
    {job && phase === "importing" && <>
      <h5 className="flex items-center gap-2 text-base font-semibold text-tx-primary">{job.status !== "PAUSED" && <Loader2 size={18} className="animate-spin" aria-hidden="true" />}{t(job.status === "PAUSED" ? "migration.smart.paused" : "migration.smart.importing")}</h5>
      <div className="space-y-2" role="status">
        <p className="text-sm text-tx-secondary">{t("migration.smart.importingProgress", { imported: job.counts.imported, total: Math.max(job.counts.create, job.counts.imported) })}</p>
        <div className="h-1.5 overflow-hidden rounded-full bg-app-hover"><div className="h-full bg-accent-primary transition-[width]" style={{ width: `${Math.min(100, Math.floor(job.counts.imported / Math.max(1, job.counts.create) * 100))}%` }} /></div>
      </div>
      <p className="text-xs text-tx-secondary">{t("migration.approvalHint")}</p>
      <div className="flex flex-wrap gap-2">
        {job.status === "IMPORTING" && <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void run(() => migrationApi.pause(job.id))}>{t("migration.pause")}</Button>}
        {job.status === "PAUSED" && <Button type="button" size="sm" disabled={busy || !available} onClick={() => void run(() => migrationApi.resume(job.id))}>{t("migration.resume")}</Button>}
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void run(() => migrationApi.cancel(job.id))}>{t("migration.smart.cancelImport")}</Button>
      </div>
    </>}
    {job && (phase === "done" || phase === "partial") && <>
      <h5 className="flex items-center gap-2 text-base font-semibold text-tx-primary">
        {phase === "done" ? <CheckCircle2 size={18} className="text-emerald-600 dark:text-emerald-400" aria-hidden="true" /> : <AlertTriangle size={18} className="text-amber-600 dark:text-amber-400" aria-hidden="true" />}
        {phase === "done" ? t("migration.smart.done") : t("migration.smart.partial", { imported: job.counts.imported, failed: job.counts.failed })}
      </h5>
      {phase === "done" && <p className="text-sm text-tx-secondary">{t("migration.smart.doneCount", { count: job.counts.imported })}</p>}
      <div className="flex flex-wrap gap-2">
        {phase === "partial" && job.counts.failed > 0 && <Button type="button" disabled={busy || !available} onClick={() => void run(() => migrationApi.retry(job.id))}>{t("migration.smart.retryFailed")}</Button>}
        {job.rootNotebookId && job.counts.imported > 0 && <Button type="button" variant={phase === "done" ? "default" : "outline"} onClick={() => openNotes(job)}><FolderOpen size={15} className="mr-1.5" aria-hidden="true" />{t("migration.smart.viewNotes")}</Button>}
        <Button type="button" variant="outline" onClick={reset}>{t("migration.smart.importMore")}</Button>
        {job.undo?.available && <Button type="button" variant="ghost" disabled={busy} onClick={() => undo(job)}>{t("migration.undo")}</Button>}
      </div>
    </>}
    {job && (phase === "failed" || phase === "cancelled" || phase === "undone") && <>
      <h5 className="text-base font-semibold text-tx-primary">{t(`migration.smart.${phase}Title`)}</h5>
      {phase === "failed" && job.error && <p role="alert" className="text-sm text-tx-secondary">{t(`migration.smart.errors.${importErrorKind(job.error)}`)}</p>}
      <div className="flex flex-wrap gap-2">
        {phase === "failed" && job.counts.failed > 0 && <Button type="button" disabled={busy || !available} onClick={() => void run(() => migrationApi.retry(job.id))}>{t("migration.smart.retryFailed")}</Button>}
        {job.rootNotebookId && job.counts.imported > 0 && phase !== "undone" && <Button type="button" variant="outline" onClick={() => openNotes(job)}>{t("migration.smart.viewNotes")}</Button>}
        <Button type="button" variant="outline" onClick={reset}>{t("migration.smart.startOver")}</Button>
        {phase === "failed" && job.error && importErrorKind(job.error) === "format" && <Button type="button" variant="outline" onClick={openAssistant}>{t("migration.smart.useAssistant")}</Button>}
        {job.undo?.available && <Button type="button" variant="ghost" disabled={busy} onClick={() => undo(job)}>{t("migration.undo")}</Button>}
      </div>
    </>}
    {job && terminal.has(job.status) && job.status !== "UNDONE" && !job.undo?.available && job.undo?.reason && <p className="text-xs text-tx-secondary">{t("migration.undoUnavailable")}</p>}
    {job && (detailsOpen || phase === "partial" || phase === "failed") && phase !== "preparing" && <div className="space-y-3 border-t border-app-border pt-4">
      {job.status === "PREVIEW_READY" && <MigrationReviewItems job={job} busy={busy} onDecision={(itemId, decision) => void run(() => migrationApi.decide(job.id, itemId, job.previewDigest!, decision))} />}
      {job.warnings.length > 0 && <div><p className="text-xs font-medium text-tx-primary">{t("migration.smart.detailWarnings")}</p>
        <ul className="mt-1 list-disc space-y-1 pl-4 text-xs text-tx-secondary">{job.warnings.map((warning, index) => <li className="break-words" key={index}>{warningText(warning)}</li>)}</ul></div>}
      <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void downloadReport()}><Download size={14} className="mr-1.5" aria-hidden="true" />{t("migration.report")}</Button>
    </div>}
  </section>;

  return <section className="space-y-5 text-tx-primary" aria-label={t("migration.title")}>
    <div>
      <h4 className="text-lg font-semibold">{t("migration.title")}</h4>
      <p className="mt-1 text-sm text-tx-secondary">{t("migration.description")}</p>
    </div>
    {localOnly && <p className={`${card} text-sm`}>{t("migration.localOnly")}</p>}
    {!localOnly && <>
      {disabled && <p className="text-sm text-amber-700 dark:text-amber-300">{t("migration.disabled")}</p>}
      {problemCard}
      {phase === "start" ? startView : jobView}
      {phase === "start" && jobs.length > 0 && <details className="rounded-2xl border border-app-border p-4">
        <summary className="flex cursor-pointer items-center gap-2 text-sm font-medium"><History size={15} aria-hidden="true" />{t("migration.smart.historyCount", { count: jobs.length })}</summary>
        <ul className="mt-3 max-h-72 space-y-2 overflow-y-auto">{jobs.map((item) => <li key={item.id}>
          <button type="button" aria-label={t("migration.selectJob", { name: item.name })} disabled={busy} onClick={() => void run(() => migrationApi.get(item.id))}
            className="flex w-full flex-wrap items-center justify-between gap-2 rounded-xl border border-app-border p-3 text-left text-xs hover:bg-app-hover disabled:opacity-50">
            <span className="min-w-0"><span className="block break-words font-medium text-tx-primary">{item.name}</span>
              <span className="mt-0.5 block text-tx-secondary">{new Date(item.createdAt).toLocaleString()}{item.preparedBy === "assistant" ? ` · ${t("migration.smart.assistantBadge")}` : ""}</span></span>
            <span className="shrink-0 text-tx-secondary">{statusLabel(item.status)}</span>
          </button>
        </li>)}</ul>
      </details>}
    </>}
    <Button type="button" variant="link" size="sm" className="h-auto min-h-8 whitespace-normal py-1 text-left px-0 text-tx-secondary" disabled={busy} onClick={onLegacyImport}>{t("migration.smart.otherFormats")}</Button>
    <input ref={resumeInput} type="file" multiple accept={IMPORT_ACCEPT} className="hidden" aria-label={t("migration.smart.resume")} disabled={!available || busy}
      onChange={(event) => { const files = filesFromInput(event.currentTarget.files); event.currentTarget.value = ""; if (job && files.length) void start(files, job.id); }} />
  </section>;
}
