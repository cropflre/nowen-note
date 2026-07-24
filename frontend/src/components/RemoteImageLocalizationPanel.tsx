import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle,
  CheckCircle2,
  FileText,
  Folder,
  Image,
  Loader2,
  Play,
  RefreshCw,
  Search,
  Square,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { useApp, useAppActions } from "@/store/AppContext";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import {
  isRemoteImageLocalizationJobActive,
  remoteImageLocalizationApi,
  type RemoteImageLocalizationJob,
  type RemoteImageLocalizationScope,
  type RemoteImageLocalizationScan,
} from "@/lib/remoteImageLocalizationApi";

type ScopeMode = "current" | "selected" | "notebook";

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function terminalStatus(status: RemoteImageLocalizationJob["status"]): boolean {
  return !["queued", "running"].includes(status);
}

export default function RemoteImageLocalizationPanel() {
  const { state } = useApp();
  const actions = useAppActions();
  const { t, i18n } = useTranslation();
  const zh = i18n.language.toLowerCase().startsWith("zh");
  const tr = useCallback(
    (key: string, chinese: string, english: string) => t(key, { defaultValue: zh ? chinese : english }),
    [t, zh],
  );

  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<ScopeMode>("current");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [notebookId, setNotebookId] = useState("");
  const [query, setQuery] = useState("");
  const [scan, setScan] = useState<RemoteImageLocalizationScan | null>(null);
  const [job, setJob] = useState<RemoteImageLocalizationJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const completedRefreshRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!notebookId && state.selectedNotebookId) setNotebookId(state.selectedNotebookId);
  }, [notebookId, state.selectedNotebookId]);

  const noteById = useMemo(
    () => new Map(state.notes.map((note) => [note.id, note])),
    [state.notes],
  );

  const visibleNotes = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return state.notes;
    return state.notes.filter((note) =>
      note.title.toLowerCase().includes(normalized)
      || note.contentText?.toLowerCase().includes(normalized),
    );
  }, [query, state.notes]);

  const expectedVersions = useCallback((ids: string[]) => {
    const versions: Record<string, number> = {};
    for (const id of ids) {
      const note = noteById.get(id);
      if (note && Number.isInteger(note.version)) versions[id] = note.version;
      if (state.activeNote?.id === id && Number.isInteger(state.activeNote.version)) {
        versions[id] = state.activeNote.version;
      }
    }
    return versions;
  }, [noteById, state.activeNote]);

  const buildScope = useCallback((): RemoteImageLocalizationScope | null => {
    if (mode === "current") {
      if (!state.activeNote) return null;
      return {
        noteIds: [state.activeNote.id],
        expectedVersions: { [state.activeNote.id]: state.activeNote.version },
      };
    }
    if (mode === "selected") {
      const ids = [...selectedIds];
      if (ids.length === 0) return null;
      return { noteIds: ids, expectedVersions: expectedVersions(ids) };
    }
    if (!notebookId) return null;
    return { notebookId };
  }, [expectedVersions, mode, notebookId, selectedIds, state.activeNote]);

  const resetPreview = useCallback(() => {
    setScan(null);
    setError("");
  }, []);

  useEffect(() => {
    resetPreview();
  }, [mode, notebookId, selectedIds, resetPreview]);

  const refreshChangedNotes = useCallback(async (completedJob: RemoteImageLocalizationJob) => {
    if (completedRefreshRef.current.has(completedJob.id)) return;
    completedRefreshRef.current.add(completedJob.id);
    actions.refreshNotes();
    const activeId = state.activeNote?.id;
    const changedActive = activeId && completedJob.noteResults.some(
      (result) => result.noteId === activeId && ["completed", "partial"].includes(result.status),
    );
    if (changedActive) {
      try {
        const latest = await api.getNote(activeId);
        actions.setActiveNote(latest);
      } catch {
        // The list refresh still updates navigation; editor can reload manually.
      }
    }
  }, [actions, state.activeNote?.id]);

  useEffect(() => {
    if (!open) return;
    let disposed = false;
    void remoteImageLocalizationApi.listJobs(10).then(({ jobs }) => {
      if (disposed || job) return;
      const active = jobs.find(isRemoteImageLocalizationJobActive);
      if (active) setJob(active);
      else if (jobs[0]) setJob(jobs[0]);
    }).catch(() => {});
    return () => { disposed = true; };
  }, [job, open]);

  useEffect(() => {
    if (!job || !isRemoteImageLocalizationJobActive(job)) return;
    let disposed = false;
    const poll = async () => {
      try {
        const latest = await remoteImageLocalizationApi.getJob(job.id);
        if (disposed) return;
        setJob(latest);
        if (terminalStatus(latest.status)) void refreshChangedNotes(latest);
      } catch (pollError) {
        if (!disposed) setError(pollError instanceof Error ? pollError.message : String(pollError));
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 1200);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [job?.id, job?.status, refreshChangedNotes]);

  const handleScan = useCallback(async () => {
    const scope = buildScope();
    if (!scope) {
      setError(tr("remoteImageLocalization.scopeRequired", "请选择要处理的笔记或笔记本", "Select notes or a notebook first"));
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await remoteImageLocalizationApi.scan(scope);
      setScan(result);
    } catch (scanError) {
      setError(scanError instanceof Error ? scanError.message : String(scanError));
    } finally {
      setBusy(false);
    }
  }, [buildScope, tr]);

  const handleStart = useCallback(async () => {
    const scope = buildScope();
    if (!scope) return;
    setBusy(true);
    setError("");
    try {
      const created = await remoteImageLocalizationApi.createJob(scope);
      setJob(created);
      setScan(null);
      toast.success(tr("remoteImageLocalization.started", "网络图片本地化任务已启动", "Image localization job started"));
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : String(startError));
    } finally {
      setBusy(false);
    }
  }, [buildScope, tr]);

  const handleCancel = useCallback(async () => {
    if (!job) return;
    setBusy(true);
    try {
      setJob(await remoteImageLocalizationApi.cancelJob(job.id));
    } catch (cancelError) {
      setError(cancelError instanceof Error ? cancelError.message : String(cancelError));
    } finally {
      setBusy(false);
    }
  }, [job]);

  const handleRetry = useCallback(async () => {
    if (!job) return;
    setBusy(true);
    setError("");
    try {
      const retried = await remoteImageLocalizationApi.retryJob(job.id);
      setJob(retried);
      toast.success(tr("remoteImageLocalization.retryStarted", "失败项重试任务已启动", "Retry job started"));
    } catch (retryError) {
      setError(retryError instanceof Error ? retryError.message : String(retryError));
    } finally {
      setBusy(false);
    }
  }, [job, tr]);

  const toggleNote = useCallback((noteId: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(noteId)) next.delete(noteId);
      else next.add(noteId);
      return next;
    });
  }, []);

  const selectAllVisible = useCallback(() => {
    setSelectedIds((current) => {
      const next = new Set(current);
      const allSelected = visibleNotes.length > 0 && visibleNotes.every((note) => next.has(note.id));
      for (const note of visibleNotes) {
        if (allSelected) next.delete(note.id);
        else next.add(note.id);
      }
      return next;
    });
  }, [visibleNotes]);

  const progress = job?.summary.totalNotes
    ? Math.min(100, Math.round(job.summary.processedNotes / job.summary.totalNotes * 100))
    : 0;
  const retryable = Boolean(job && terminalStatus(job.status) && job.noteResults.some(
    (result) => ["failed", "partial", "conflict", "parse_error"].includes(result.status),
  ));

  const panel = open ? (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/45 p-3 md:p-6" role="dialog" aria-modal="true">
      <div className="flex max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-app-border bg-app-elevated shadow-2xl">
        <div className="flex items-center justify-between border-b border-app-border px-4 py-3 md:px-5">
          <div className="flex items-center gap-2">
            <Image size={20} className="text-accent-primary" />
            <div>
              <h2 className="font-semibold text-tx-primary">
                {tr("remoteImageLocalization.title", "网络图片本地化", "Remote image localization")}
              </h2>
              <p className="text-xs text-tx-tertiary">
                {tr(
                  "remoteImageLocalization.subtitle",
                  "将历史笔记中的网络图片保存为 Nowen 附件，失败时保留原链接",
                  "Save remote images as Nowen attachments while preserving failed URLs",
                )}
              </p>
            </div>
          </div>
          <button className="rounded-md p-1.5 text-tx-tertiary hover:bg-app-hover hover:text-tx-primary" onClick={() => setOpen(false)}>
            <X size={18} />
          </button>
        </div>

        <div className="overflow-y-auto p-4 md:p-5">
          <div className="mb-4 grid grid-cols-3 gap-2 rounded-lg bg-app-bg p-1">
            {([
              ["current", tr("remoteImageLocalization.current", "当前笔记", "Current note"), FileText],
              ["selected", tr("remoteImageLocalization.multiple", "选择多篇", "Select notes"), CheckCircle2],
              ["notebook", tr("remoteImageLocalization.notebook", "整个笔记本", "Notebook"), Folder],
            ] as const).map(([value, label, Icon]) => (
              <button
                key={value}
                type="button"
                onClick={() => setMode(value)}
                className={cn(
                  "flex items-center justify-center gap-1.5 rounded-md px-2 py-2 text-xs transition-colors md:text-sm",
                  mode === value ? "bg-app-elevated text-accent-primary shadow-sm" : "text-tx-secondary hover:text-tx-primary",
                )}
              >
                <Icon size={15} /> {label}
              </button>
            ))}
          </div>

          {mode === "current" && (
            <div className="rounded-lg border border-app-border bg-app-bg p-3">
              {state.activeNote ? (
                <>
                  <div className="font-medium text-tx-primary">{state.activeNote.title || tr("common.untitled", "无标题笔记", "Untitled")}</div>
                  <div className="mt-1 text-xs text-tx-tertiary">ID: {state.activeNote.id} · v{state.activeNote.version}</div>
                </>
              ) : (
                <div className="text-sm text-tx-tertiary">
                  {tr("remoteImageLocalization.noActiveNote", "当前没有打开笔记", "No note is currently open")}
                </div>
              )}
            </div>
          )}

          {mode === "selected" && (
            <div className="rounded-lg border border-app-border bg-app-bg">
              <div className="flex items-center gap-2 border-b border-app-border p-2">
                <Search size={15} className="text-tx-tertiary" />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={tr("remoteImageLocalization.searchNotes", "搜索笔记", "Search notes")}
                  className="min-w-0 flex-1 bg-transparent text-sm text-tx-primary outline-none placeholder:text-tx-tertiary"
                />
                <button type="button" onClick={selectAllVisible} className="text-xs text-accent-primary hover:underline">
                  {visibleNotes.length > 0 && visibleNotes.every((note) => selectedIds.has(note.id))
                    ? tr("remoteImageLocalization.deselectVisible", "取消当前结果", "Deselect visible")
                    : tr("remoteImageLocalization.selectVisible", "选择当前结果", "Select visible")}
                </button>
              </div>
              <div className="max-h-52 overflow-y-auto p-1">
                {visibleNotes.map((note) => (
                  <label key={note.id} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 hover:bg-app-hover">
                    <input type="checkbox" checked={selectedIds.has(note.id)} onChange={() => toggleNote(note.id)} />
                    <span className="min-w-0 flex-1 truncate text-sm text-tx-primary">{note.title}</span>
                    <span className="text-[11px] text-tx-tertiary">v{note.version}</span>
                  </label>
                ))}
                {visibleNotes.length === 0 && (
                  <div className="p-4 text-center text-sm text-tx-tertiary">
                    {tr("remoteImageLocalization.noNotes", "没有可选择的笔记", "No notes available")}
                  </div>
                )}
              </div>
              <div className="border-t border-app-border px-3 py-2 text-xs text-tx-tertiary">
                {tr("remoteImageLocalization.selectedCount", "已选择", "Selected")}: {selectedIds.size}
              </div>
            </div>
          )}

          {mode === "notebook" && (
            <div className="rounded-lg border border-app-border bg-app-bg p-3">
              <label className="mb-1 block text-xs text-tx-tertiary">
                {tr("remoteImageLocalization.notebookScope", "包含该笔记本及全部子笔记本", "Includes this notebook and all descendants")}
              </label>
              <select
                value={notebookId}
                onChange={(event) => setNotebookId(event.target.value)}
                className="w-full rounded-md border border-app-border bg-app-elevated px-3 py-2 text-sm text-tx-primary outline-none focus:border-accent-primary"
              >
                <option value="">{tr("remoteImageLocalization.chooseNotebook", "选择笔记本", "Choose a notebook")}</option>
                {state.notebooks.map((notebook) => (
                  <option key={notebook.id} value={notebook.id}>{notebook.name}</option>
                ))}
              </select>
            </div>
          )}

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button onClick={handleScan} disabled={busy || isRemoteImageLocalizationJobActive(job)}>
              {busy && !job ? <Loader2 size={15} className="mr-1 animate-spin" /> : <Search size={15} className="mr-1" />}
              {tr("remoteImageLocalization.scan", "扫描网络图片", "Scan images")}
            </Button>
            <span className="text-xs text-tx-tertiary">
              {tr(
                "remoteImageLocalization.riskHint",
                "仅处理 HTTP/HTTPS 图片；写入前会重新检查权限和版本",
                "Only HTTP/HTTPS images are processed; permission and version are rechecked before saving",
              )}
            </span>
          </div>

          {error && (
            <div className="mt-4 flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-500">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {scan && (
            <div className="mt-4 rounded-lg border border-app-border bg-app-bg p-4">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div>
                  <h3 className="font-medium text-tx-primary">
                    {tr("remoteImageLocalization.scanResult", "扫描结果", "Scan result")}
                  </h3>
                  <p className="text-xs text-tx-tertiary">
                    {scan.notesWithRemoteImages} / {scan.noteCount} {tr("remoteImageLocalization.notesContainImages", "篇笔记包含网络图片", "notes contain remote images")}
                  </p>
                </div>
                <Button onClick={handleStart} disabled={busy || scan.uniqueRemoteUrlCount === 0}>
                  {busy ? <Loader2 size={15} className="mr-1 animate-spin" /> : <Play size={15} className="mr-1" />}
                  {tr("remoteImageLocalization.start", "开始本地化", "Start localization")}
                </Button>
              </div>
              <div className="grid grid-cols-2 gap-2 text-sm md:grid-cols-4">
                <Stat label={tr("remoteImageLocalization.notes", "笔记", "Notes")} value={scan.noteCount} />
                <Stat label={tr("remoteImageLocalization.remoteRefs", "网络图片引用", "Remote references")} value={scan.remoteReferenceCount} />
                <Stat label={tr("remoteImageLocalization.uniqueUrls", "唯一 URL", "Unique URLs")} value={scan.uniqueRemoteUrlCount} />
                <Stat label={tr("remoteImageLocalization.skipped", "跳过笔记", "Skipped notes")} value={scan.skippedNoteCount} />
              </div>
              {scan.uniqueRemoteUrlCount === 0 && (
                <div className="mt-3 text-sm text-tx-tertiary">
                  {tr("remoteImageLocalization.nothingToDo", "没有需要本地化的网络图片", "No remote images need localization")}
                </div>
              )}
            </div>
          )}

          {job && (
            <div className="mt-4 rounded-lg border border-app-border bg-app-bg p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2 font-medium text-tx-primary">
                    {isRemoteImageLocalizationJobActive(job) && <Loader2 size={16} className="animate-spin text-accent-primary" />}
                    {!isRemoteImageLocalizationJobActive(job) && job.status === "completed" && <CheckCircle2 size={16} className="text-green-500" />}
                    {!isRemoteImageLocalizationJobActive(job) && job.status !== "completed" && <AlertTriangle size={16} className="text-amber-500" />}
                    {job.status}
                  </div>
                  <div className="mt-1 text-xs text-tx-tertiary">
                    {job.currentNoteTitle || tr("remoteImageLocalization.waiting", "等待处理", "Waiting")}
                    {job.currentUrl ? ` · ${job.currentUrl}` : ""}
                  </div>
                </div>
                <div className="flex gap-2">
                  {isRemoteImageLocalizationJobActive(job) && (
                    <Button variant="outline" onClick={handleCancel} disabled={busy || job.cancelRequested}>
                      <Square size={14} className="mr-1" />
                      {job.cancelRequested
                        ? tr("remoteImageLocalization.cancelling", "正在取消", "Cancelling")
                        : tr("remoteImageLocalization.cancel", "取消后续处理", "Cancel remaining")}
                    </Button>
                  )}
                  {retryable && (
                    <Button variant="outline" onClick={handleRetry} disabled={busy}>
                      <RefreshCw size={14} className="mr-1" />
                      {tr("remoteImageLocalization.retry", "重试失败项", "Retry failures")}
                    </Button>
                  )}
                </div>
              </div>

              <div className="mt-3 h-2 overflow-hidden rounded-full bg-app-border">
                <div className="h-full rounded-full bg-accent-primary transition-all" style={{ width: `${progress}%` }} />
              </div>
              <div className="mt-1 text-right text-xs text-tx-tertiary">
                {job.summary.processedNotes} / {job.summary.totalNotes} · {progress}%
              </div>

              <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-4">
                <Stat label={tr("remoteImageLocalization.updatedNotes", "已更新笔记", "Updated notes")} value={job.summary.updatedNotes} />
                <Stat label={tr("remoteImageLocalization.localizedImages", "已替换引用", "Localized references")} value={job.summary.localizedReferences} />
                <Stat label={tr("remoteImageLocalization.deduplicated", "附件去重", "Deduplicated")} value={job.summary.deduplicatedAttachments} />
                <Stat label={tr("remoteImageLocalization.failures", "失败 URL", "Failed URLs")} value={job.summary.failedUrls} />
              </div>
              <div className="mt-2 text-xs text-tx-tertiary">
                {tr("remoteImageLocalization.downloaded", "已下载", "Downloaded")}: {formatBytes(job.summary.downloadedBytes)} ·
                {tr("remoteImageLocalization.reusedDownloads", "任务内复用", "Task download reuse")}: {job.summary.reusedDownloads}
              </div>

              {job.failures.length > 0 && (
                <details className="mt-3 rounded-md border border-amber-500/25 bg-amber-500/5 p-3">
                  <summary className="cursor-pointer text-sm font-medium text-amber-600">
                    {tr("remoteImageLocalization.failureDetails", "失败与跳过明细", "Failure and skip details")} ({job.failures.length})
                  </summary>
                  <div className="mt-2 max-h-48 space-y-2 overflow-y-auto">
                    {job.failures.map((failure, index) => (
                      <div key={`${failure.noteId}-${failure.url || failure.code}-${index}`} className="text-xs text-tx-secondary">
                        <div className="font-medium text-tx-primary">{failure.code}</div>
                        <div>{failure.message}</div>
                        {failure.url && <div className="truncate text-tx-tertiary">{failure.url}</div>}
                      </div>
                    ))}
                  </div>
                </details>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  ) : null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="fixed bottom-5 right-5 z-[80] flex items-center gap-2 rounded-full border border-app-border bg-app-elevated px-4 py-2.5 text-sm font-medium text-tx-primary shadow-lg transition-transform hover:-translate-y-0.5 hover:bg-app-hover"
      >
        <Image size={17} className="text-accent-primary" />
        {tr("remoteImageLocalization.trigger", "网络图片保护", "Protect remote images")}
        {job && isRemoteImageLocalizationJobActive(job) && <Loader2 size={14} className="animate-spin text-accent-primary" />}
      </button>
      {typeof document !== "undefined" && panel ? createPortal(panel, document.body) : null}
    </>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-md border border-app-border bg-app-elevated px-3 py-2">
      <div className="text-xs text-tx-tertiary">{label}</div>
      <div className="mt-0.5 font-semibold text-tx-primary">{value}</div>
    </div>
  );
}
