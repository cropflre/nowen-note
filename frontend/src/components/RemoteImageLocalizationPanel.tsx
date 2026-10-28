import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle,
  CheckCircle2,
  Image,
  Loader2,
  Play,
  RefreshCw,
  Square,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { useApp, useAppActions } from "@/store/AppContext";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import {
  isRemoteImageLocalizationJobActive,
  remoteImageLocalizationApi,
  type RemoteImageLocalizationJob,
} from "@/lib/remoteImageLocalizationApi";

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
  const [job, setJob] = useState<RemoteImageLocalizationJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const completedRefreshRef = useRef<Set<string>>(new Set());

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
    if (job) return;
    let disposed = false;
    void remoteImageLocalizationApi.listJobs(10).then(({ jobs }) => {
      if (disposed) return;
      const active = jobs.find(isRemoteImageLocalizationJobActive);
      setJob((current) => current ?? active ?? jobs[0] ?? null);
    }).catch(() => {});
    return () => { disposed = true; };
  }, [job]);

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

  const handleStart = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const created = await remoteImageLocalizationApi.createJob({ allPersonal: true });
      setJob(created);
      toast.success(tr("remoteImageLocalization.started", "网络图片本地化任务已启动", "Image localization job started"));
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : String(startError));
    } finally {
      setBusy(false);
    }
  }, [tr]);

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

  const progress = job?.summary.totalNotes
    ? Math.min(100, Math.round(job.summary.processedNotes / job.summary.totalNotes * 100))
    : terminalStatus(job?.status ?? "queued") ? 100 : 0;
  const retryable = Boolean(job && terminalStatus(job.status) && (job.status === "failed" || job.noteResults.some(
    (result) => ["failed", "partial", "conflict", "parse_error"].includes(result.status),
  )));

  const panel = open ? (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/45 p-3 md:p-6" role="dialog" aria-modal="true">
      <div className="flex max-h-[92vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-app-border bg-app-elevated shadow-2xl">
        <div className="flex items-center justify-between border-b border-app-border px-4 py-3 md:px-5">
          <div className="flex items-center gap-2">
            <Image size={20} className="text-accent-primary" />
            <div>
              <h2 className="font-semibold text-tx-primary">
                {tr("remoteImageLocalization.title", "网络图片转存", "Save remote images")}
              </h2>
              <p className="text-xs text-tx-tertiary">
                {tr(
                  "remoteImageLocalization.subtitle",
                  "将全部个人笔记中的网络图片保存为附件，失败时保留原链接",
                  "Save remote images from all personal notes as attachments; failed URLs are preserved",
                )}
              </p>
            </div>
          </div>
          <button aria-label={tr("common.close", "关闭", "Close")} className="rounded-md p-1.5 text-tx-tertiary hover:bg-app-hover hover:text-tx-primary" onClick={() => setOpen(false)}>
            <X size={18} />
          </button>
        </div>

        <div className="overflow-y-auto p-4 md:p-5">
          <p className="text-sm text-tx-secondary">
            {tr("remoteImageLocalization.allPersonalHint", "自动分批处理全部个人笔记，不包含工作区和回收站中的笔记。", "Automatically process all personal notes in batches, excluding workspaces and trash.")}
          </p>
          <p className="mt-2 text-xs text-tx-tertiary">
            {tr("remoteImageLocalization.backgroundHint", "图片较多时耗时较长，可关闭窗口，稍后查看进度。", "Large collections take longer. You can close this window and check progress later.")}
          </p>
          {!isRemoteImageLocalizationJobActive(job) && (
            <Button className="mt-4" onClick={handleStart} disabled={busy}>
              {busy ? <Loader2 size={15} className="mr-1 animate-spin" /> : <Play size={15} className="mr-1" />}
              {tr("remoteImageLocalization.start", "开始转存全部笔记图片", "Save images from all personal notes")}
            </Button>
          )}

          {error && (
            <div className="mt-4 flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-500">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" />
              <span>{error}</span>
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
                    {({
                      queued: tr("remoteImageLocalization.queued", "排队中", "Queued"),
                      running: tr("remoteImageLocalization.running", "正在转存", "Running"),
                      completed: tr("remoteImageLocalization.completed", "转存完成", "Completed"),
                      completed_with_errors: tr("remoteImageLocalization.partial", "部分转存成功", "Partially completed"),
                      cancelled: tr("remoteImageLocalization.cancelled", "任务已取消", "Cancelled"),
                      failed: tr("remoteImageLocalization.failed", "任务失败", "Failed"),
                    } as Record<RemoteImageLocalizationJob["status"], string>)[job.status]}
                  </div>
                  <div className="mt-1 text-xs text-tx-tertiary">
                    {job.currentNoteTitle || tr("remoteImageLocalization.waiting", "等待处理", "Waiting")}
                  </div>
                </div>
                <div className="flex gap-2">
                  {isRemoteImageLocalizationJobActive(job) && (
                    <Button variant="outline" onClick={handleCancel} disabled={busy || job.cancelRequested}>
                      <Square size={14} className="mr-1" />
                      {job.cancelRequested
                        ? tr("remoteImageLocalization.cancelling", "正在停止", "Stopping")
                        : tr("remoteImageLocalization.cancel", "停止转存", "Stop")}
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
                {job.summary.processedNotes} / {job.summary.totalNotes} {tr("remoteImageLocalization.notes", "笔记", "Notes")} · {progress}%
              </div>

              <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-4">
                <Stat label={tr("remoteImageLocalization.successImages", "已保存图片", "Saved images")} value={job.summary.localizedUrls} />
                <Stat label={tr("remoteImageLocalization.failures", "失败图片", "Failed images")} value={job.summary.failedUrls} />
                <Stat label={tr("remoteImageLocalization.skippedImages", "跳过图片", "Skipped images")} value={job.summary.skippedImageOperations ?? 0} />
                <Stat label={tr("remoteImageLocalization.scannedNotes", "已扫描笔记", "Notes scanned")} value={job.summary.scannedNotes} />
              </div>
              {job.error && <p className="mt-2 text-sm text-red-500">{job.error}</p>}
              {job.status === "completed" && job.summary.remoteReferenceCount === 0 && (
                <p className="mt-2 text-sm text-tx-tertiary">
                  {tr("remoteImageLocalization.nothingToDo", "没有需要转存的网络图片", "No remote images need saving")}
                </p>
              )}
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
      <div
        className="flex flex-col gap-3 rounded-xl border border-zinc-200 bg-zinc-50/50 p-4 dark:border-zinc-800 dark:bg-zinc-800/30 sm:flex-row sm:items-center sm:justify-between"
        data-settings-tool="remote-image-localization"
      >
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-blue-500/10 text-blue-500">
            <Image size={17} />
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-medium text-zinc-700 dark:text-zinc-300">
              {tr("remoteImageLocalization.trigger", "网络图片转存", "Save remote images")}
              {job && isRemoteImageLocalizationJobActive(job) && (
                <Loader2 size={13} className="animate-spin text-accent-primary" aria-label={tr("remoteImageLocalization.running", "任务进行中", "Job in progress")} />
              )}
            </div>
            <p className="mt-0.5 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
              {tr(
                "remoteImageLocalization.settingsDesc",
                "一键保存笔记中的外链图片到 Nowen 附件库，防止源站关闭导致图片失效",
                "Save remote images as local attachments to prevent broken images",
              )}
            </p>
          </div>
        </div>
        <Button variant="outline" onClick={() => setOpen(true)} className="shrink-0 self-end sm:self-auto">
          {job && isRemoteImageLocalizationJobActive(job)
            ? tr("remoteImageLocalization.viewProgress", "查看进度", "View progress")
            : tr("remoteImageLocalization.openTool", "打开工具", "Open tool")}
        </Button>
      </div>
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
