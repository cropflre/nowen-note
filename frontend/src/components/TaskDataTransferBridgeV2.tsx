import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle,
  CheckCircle2,
  DatabaseBackup,
  Download,
  FileArchive,
  FileJson,
  FileSpreadsheet,
  ImagePlus,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Upload,
  X,
} from "lucide-react";
import {
  buildTaskCsv,
  collectTaskBackup,
  importTaskBackup,
  saveTaskTransferFile,
  taskBackupFilename,
  type TaskImportResult,
  type TaskTransferProgress,
} from "@/lib/taskDataTransfer";
import {
  buildTaskArchive,
  importTaskArchive,
  parseTaskTransferFile,
  saveTaskTransferBlob,
  type AnyTaskImportPreview,
  type TaskArchiveImportResult,
} from "@/lib/taskDataTransferArchive";
import { OPEN_TASK_DATA_TRANSFER_EVENT } from "@/lib/taskDataTransferBridge";
import { cn } from "@/lib/utils";

type ExportFormat = "zip" | "json" | "csv";
type ImportResult = TaskImportResult | TaskArchiveImportResult;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function ProgressBar({ progress }: { progress: TaskTransferProgress | null }) {
  if (!progress) return null;
  const percent = progress.total > 0
    ? Math.min(100, Math.max(4, Math.round((progress.current / progress.total) * 100)))
    : 12;
  return (
    <div className="rounded-xl border border-app-border bg-app-bg px-3 py-2.5" aria-live="polite">
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="truncate text-tx-secondary">{progress.message}</span>
        <span className="shrink-0 tabular-nums text-tx-tertiary">
          {progress.total > 0 ? `${progress.current}/${progress.total}` : ""}
        </span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-app-border/80">
        <div
          className="h-full rounded-full bg-accent-primary transition-[width] duration-200"
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-app-border bg-app-bg px-3 py-2.5">
      <div className="text-lg font-semibold tabular-nums text-tx-primary">{value}</div>
      <div className="mt-0.5 text-[11px] text-tx-tertiary">{label}</div>
    </div>
  );
}

function hasAttachmentResult(result: ImportResult): result is TaskArchiveImportResult {
  return "importedAttachments" in result;
}

function ResultSummary({ result }: { result: ImportResult }) {
  const created = result.createdTasks + result.createdProjects + result.createdDependencies + result.createdReminders;
  const skipped = result.skippedTasks + result.skippedDependencies + result.skippedReminders;
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3 rounded-2xl border border-emerald-500/25 bg-emerald-500/8 p-4">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
          <CheckCircle2 size={19} />
        </div>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-tx-primary">待办数据导入完成</h3>
          <p className="mt-1 text-xs leading-5 text-tx-secondary">
            新增 {created} 项数据，安全跳过 {skipped} 项重复或已存在数据。
            {hasAttachmentResult(result) && ` 已恢复 ${result.importedAttachments} 张图片。`}
          </p>
        </div>
      </div>
      <div className={cn("grid grid-cols-2 gap-2", hasAttachmentResult(result) ? "sm:grid-cols-5" : "sm:grid-cols-4")}>
        <Metric label="新增任务" value={result.createdTasks} />
        <Metric label="跳过任务" value={result.skippedTasks} />
        <Metric label="新增项目" value={result.createdProjects} />
        <Metric label="复用项目" value={result.reusedProjects} />
        <Metric label="新增依赖" value={result.createdDependencies} />
        <Metric label="跳过依赖" value={result.skippedDependencies} />
        <Metric label="新增提醒" value={result.createdReminders} />
        <Metric label="跳过提醒" value={result.skippedReminders} />
        {hasAttachmentResult(result) && <Metric label="恢复图片" value={result.importedAttachments} />}
        {hasAttachmentResult(result) && <Metric label="跳过图片" value={result.skippedAttachments} />}
      </div>
      {result.warnings.length > 0 && (
        <div className="rounded-xl border border-amber-500/25 bg-amber-500/8 px-3 py-2.5 text-xs leading-5 text-amber-700 dark:text-amber-300">
          <div className="mb-1 flex items-center gap-1.5 font-medium"><AlertTriangle size={13} /> 导入提示</div>
          <ul className="list-disc space-y-0.5 pl-4">
            {result.warnings.slice(0, 10).map((warning) => <li key={warning}>{warning}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}

export default function TaskDataTransferBridgeV2() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<ExportFormat | "import" | null>(null);
  const [progress, setProgress] = useState<TaskTransferProgress | null>(null);
  const [preview, setPreview] = useState<AnyTaskImportPreview | null>(null);
  const [duplicateMode, setDuplicateMode] = useState<"skip" | "append">("skip");
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, open]);

  const resetImport = useCallback(() => {
    setPreview(null);
    setResult(null);
    setError("");
    setProgress(null);
    setDuplicateMode("skip");
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, []);

  useEffect(() => {
    const handleOpen = () => {
      resetImport();
      setOpen(true);
    };
    window.addEventListener(OPEN_TASK_DATA_TRANSFER_EVENT, handleOpen);
    return () => window.removeEventListener(OPEN_TASK_DATA_TRANSFER_EVENT, handleOpen);
  }, [resetImport]);

  const handleExport = useCallback(async (format: ExportFormat) => {
    setBusy(format);
    setError("");
    setProgress(null);
    try {
      if (format === "zip") {
        const archive = await buildTaskArchive(setProgress);
        await saveTaskTransferBlob(archive.blob, archive.filename);
        return;
      }

      const pkg = await collectTaskBackup(setProgress);
      const content = format === "json" ? JSON.stringify(pkg, null, 2) : buildTaskCsv(pkg);
      await saveTaskTransferFile(
        content,
        taskBackupFilename(format),
        format === "json" ? "application/json;charset=utf-8" : "text/csv;charset=utf-8",
      );
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : "导出失败，请稍后重试");
    } finally {
      setBusy(null);
      setProgress(null);
    }
  }, []);

  const readFile = useCallback(async (file: File | null | undefined) => {
    if (!file) return;
    setError("");
    setResult(null);
    setProgress(null);
    try {
      setPreview(await parseTaskTransferFile(file));
    } catch (parseError) {
      setPreview(null);
      setError(parseError instanceof Error ? parseError.message : "无法读取该文件");
    }
  }, []);

  const handleImport = useCallback(async () => {
    if (!preview) return;
    setBusy("import");
    setError("");
    setProgress(null);
    try {
      const options = { duplicateMode, onProgress: setProgress } as const;
      const imported = preview.format === "zip"
        ? await importTaskArchive(preview, options)
        : await importTaskBackup(preview.pkg, options);
      setResult(imported);
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : "导入失败，请稍后重试");
    } finally {
      setBusy(null);
      setProgress(null);
    }
  }, [duplicateMode, preview]);

  const dialog = open ? createPortal(
    <div
      className="fixed inset-0 z-[210] flex items-end justify-center bg-black/45 px-0 backdrop-blur-sm sm:items-center sm:p-5"
      data-swipe-blocker="task-data-transfer"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget && !busy) setOpen(false);
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label="待办数据导入导出"
        className="flex max-h-[92dvh] w-full flex-col overflow-hidden rounded-t-[24px] border border-app-border bg-app-elevated shadow-2xl sm:max-h-[88vh] sm:max-w-[860px] sm:rounded-2xl"
        style={{ paddingBottom: "var(--safe-area-bottom)" }}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <header className="flex shrink-0 items-start gap-3 border-b border-app-border px-4 py-4 sm:px-5">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent-primary/12 text-accent-primary">
            <DatabaseBackup size={20} />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold text-tx-primary">待办数据导入导出</h2>
            <p className="mt-1 text-xs leading-5 text-tx-tertiary">
              完整备份可连同任务图片一起迁移；JSON / CSV 继续用于结构化数据与表格整理。
            </p>
          </div>
          <button
            type="button"
            onClick={() => !busy && setOpen(false)}
            disabled={!!busy}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-tx-tertiary transition-colors hover:bg-app-hover hover:text-tx-primary disabled:opacity-40"
            aria-label="关闭"
          >
            <X size={18} />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 sm:p-5">
          {result ? <ResultSummary result={result} /> : (
            <div className="space-y-5">
              <section>
                <div className="mb-2 flex items-center justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-semibold text-tx-primary">导出当前空间</h3>
                    <p className="mt-0.5 text-xs leading-5 text-tx-tertiary">
                      ZIP 完整保存任务图片；JSON / CSV 不包含图片二进制文件。
                    </p>
                  </div>
                  <div className="hidden items-center gap-1 rounded-full bg-emerald-500/10 px-2.5 py-1 text-[11px] text-emerald-700 dark:text-emerald-300 sm:flex">
                    <ShieldCheck size={12} /> 本地生成文件
                  </div>
                </div>

                <button
                  type="button"
                  disabled={!!busy}
                  onClick={() => void handleExport("zip")}
                  className="group mb-2 flex w-full items-center gap-3 rounded-2xl border border-accent-primary/35 bg-accent-primary/[0.055] p-4 text-left transition-all hover:bg-accent-primary/[0.09] disabled:cursor-wait disabled:opacity-60"
                >
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent-primary/15 text-accent-primary">
                    {busy === "zip" ? <Loader2 size={20} className="animate-spin" /> : <FileArchive size={20} />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2 text-sm font-semibold text-tx-primary">
                      完整备份 ZIP <span className="rounded-full bg-accent-primary px-2 py-0.5 text-[10px] text-white">推荐</span>
                    </div>
                    <p className="mt-1 text-xs leading-5 text-tx-secondary">保存任务、项目、层级、循环、依赖、提醒及任务图片，适合换设备和迁移实例。</p>
                  </div>
                  <ImagePlus size={17} className="shrink-0 text-accent-primary" />
                </button>

                <div className="grid gap-2 sm:grid-cols-2">
                  <button
                    type="button"
                    disabled={!!busy}
                    onClick={() => void handleExport("json")}
                    className="group flex items-center gap-3 rounded-2xl border border-app-border bg-app-bg p-4 text-left transition-all hover:border-accent-primary/35 hover:bg-accent-primary/[0.035] disabled:cursor-wait disabled:opacity-60"
                  >
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-violet-500/12 text-violet-600 dark:text-violet-400">
                      {busy === "json" ? <Loader2 size={19} className="animate-spin" /> : <FileJson size={19} />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 text-sm font-medium text-tx-primary">JSON 结构化备份 <Download size={13} /></div>
                      <p className="mt-1 text-xs leading-5 text-tx-tertiary">保留完整任务关系，但不打包图片文件。</p>
                    </div>
                  </button>
                  <button
                    type="button"
                    disabled={!!busy}
                    onClick={() => void handleExport("csv")}
                    className="group flex items-center gap-3 rounded-2xl border border-app-border bg-app-bg p-4 text-left transition-all hover:border-accent-primary/35 hover:bg-accent-primary/[0.035] disabled:cursor-wait disabled:opacity-60"
                  >
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-emerald-500/12 text-emerald-600 dark:text-emerald-400">
                      {busy === "csv" ? <Loader2 size={19} className="animate-spin" /> : <FileSpreadsheet size={19} />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 text-sm font-medium text-tx-primary">CSV / Excel <Download size={13} /></div>
                      <p className="mt-1 text-xs leading-5 text-tx-tertiary">适合批量编辑基础字段，不承载图片文件。</p>
                    </div>
                  </button>
                </div>
              </section>

              <div className="h-px bg-app-border" />

              <section>
                <div className="mb-2">
                  <h3 className="text-sm font-semibold text-tx-primary">导入待办数据</h3>
                  <p className="mt-0.5 text-xs text-tx-tertiary">支持完整备份 ZIP、Nowen JSON 和 CSV；写入前会先进行安全预检。</p>
                </div>

                {!preview ? (
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
                    onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
                    onDragLeave={(event) => {
                      const related = event.relatedTarget;
                      if (!(related instanceof Node) || !event.currentTarget.contains(related)) setDragging(false);
                    }}
                    onDrop={(event) => {
                      event.preventDefault();
                      setDragging(false);
                      void readFile(event.dataTransfer.files?.[0]);
                    }}
                    className={cn(
                      "flex min-h-[150px] w-full flex-col items-center justify-center rounded-2xl border-2 border-dashed px-5 py-6 text-center transition-colors",
                      dragging
                        ? "border-accent-primary bg-accent-primary/8"
                        : "border-app-border bg-app-bg hover:border-accent-primary/35 hover:bg-accent-primary/[0.025]",
                    )}
                  >
                    <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-accent-primary/10 text-accent-primary">
                      <Upload size={20} />
                    </div>
                    <div className="mt-3 text-sm font-medium text-tx-primary">点击选择，或把 ZIP / JSON / CSV 拖到这里</div>
                    <div className="mt-1 text-xs text-tx-tertiary">ZIP 会同时预检任务数量、图片数量、总大小及压缩包路径</div>
                  </button>
                ) : (
                  <div className="space-y-3 rounded-2xl border border-app-border bg-app-bg p-3.5 sm:p-4">
                    <div className="flex items-start gap-3">
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent-primary/10 text-accent-primary">
                        {preview.format === "zip" ? <FileArchive size={17} /> : preview.format === "csv" ? <FileSpreadsheet size={17} /> : <FileJson size={17} />}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium text-tx-primary" title={preview.fileName}>{preview.fileName}</div>
                        <div className="mt-0.5 text-xs uppercase text-tx-tertiary">{preview.format} · 已完成安全预检</div>
                      </div>
                      <button type="button" onClick={resetImport} disabled={!!busy} className="rounded-lg px-2 py-1 text-xs text-tx-tertiary hover:bg-app-hover hover:text-tx-primary">重选</button>
                    </div>
                    <div className={cn("grid grid-cols-3 gap-2", preview.format === "zip" ? "sm:grid-cols-7" : "sm:grid-cols-6")}>
                      <Metric label="项目" value={preview.projects} />
                      <Metric label="任务" value={preview.tasks} />
                      <Metric label="子任务" value={preview.subtasks} />
                      <Metric label="已完成" value={preview.completed} />
                      <Metric label="依赖" value={preview.dependencies} />
                      <Metric label="提醒" value={preview.reminders} />
                      {preview.format === "zip" && <Metric label="图片" value={preview.attachments} />}
                    </div>
                    {preview.format === "zip" && (
                      <div className="flex items-center gap-2 rounded-xl border border-accent-primary/20 bg-accent-primary/[0.045] px-3 py-2 text-xs text-tx-secondary">
                        <ImagePlus size={14} className="shrink-0 text-accent-primary" />
                        图片文件共 {preview.attachments} 张，约 {formatBytes(preview.attachmentBytes)}，导入时会重新上传并绑定到新任务。
                      </div>
                    )}
                    <div className="rounded-xl border border-app-border bg-app-elevated p-3">
                      <div className="text-xs font-medium text-tx-primary">重复数据处理</div>
                      <div className="mt-2 grid grid-cols-2 gap-1 rounded-lg bg-app-hover/70 p-1">
                        <button
                          type="button"
                          onClick={() => setDuplicateMode("skip")}
                          className={cn("rounded-md px-3 py-2 text-xs transition-colors", duplicateMode === "skip" ? "bg-app-elevated font-medium text-accent-primary shadow-sm" : "text-tx-secondary")}
                        >安全跳过重复（推荐）</button>
                        <button
                          type="button"
                          onClick={() => setDuplicateMode("append")}
                          className={cn("rounded-md px-3 py-2 text-xs transition-colors", duplicateMode === "append" ? "bg-app-elevated font-medium text-accent-primary shadow-sm" : "text-tx-secondary")}
                        >全部追加为副本</button>
                      </div>
                      {preview.format === "zip" && duplicateMode === "skip" && (
                        <p className="mt-2 text-[11px] leading-5 text-tx-tertiary">被判定为重复而跳过的任务不会重复导入图片，避免修改现有任务。</p>
                      )}
                    </div>
                    {preview.warnings.length > 0 && (
                      <div className="rounded-xl border border-amber-500/25 bg-amber-500/8 px-3 py-2.5 text-xs leading-5 text-amber-700 dark:text-amber-300">
                        {preview.warnings.map((warning) => <div key={warning}>• {warning}</div>)}
                      </div>
                    )}
                  </div>
                )}

                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".zip,.json,.csv,application/zip,application/json,text/csv"
                  className="hidden"
                  onChange={(event) => void readFile(event.target.files?.[0])}
                />
              </section>

              <ProgressBar progress={progress} />
              {error && (
                <div className="flex items-start gap-2 rounded-xl border border-red-500/25 bg-red-500/8 px-3 py-2.5 text-xs leading-5 text-red-600 dark:text-red-400" role="alert">
                  <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                  <span>{error}</span>
                </div>
              )}
            </div>
          )}
        </div>

        <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-app-border bg-app-bg/70 px-4 py-3 sm:px-5">
          {result ? (
            <>
              <button type="button" onClick={resetImport} className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs text-tx-secondary hover:bg-app-hover">
                <RefreshCw size={13} /> 继续导入
              </button>
              <button type="button" onClick={() => window.location.reload()} className="rounded-lg bg-accent-primary px-4 py-2 text-sm font-medium text-white hover:opacity-90">
                完成并刷新待办
              </button>
            </>
          ) : (
            <>
              <div className="hidden items-center gap-1.5 text-[11px] text-tx-tertiary sm:flex">
                <ShieldCheck size={12} /> 不导入用户、工作区及源笔记 ID，不静默覆盖现有任务
              </div>
              <div className="ml-auto flex items-center gap-2">
                <button type="button" onClick={() => setOpen(false)} disabled={!!busy} className="rounded-lg px-3 py-2 text-sm text-tx-secondary hover:bg-app-hover disabled:opacity-40">取消</button>
                <button
                  type="button"
                  onClick={() => void handleImport()}
                  disabled={!preview || !!busy}
                  className="inline-flex min-w-[108px] items-center justify-center gap-2 rounded-lg bg-accent-primary px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {busy === "import" && <Loader2 size={15} className="animate-spin" />}
                  {busy === "import" ? "正在导入" : "确认导入"}
                </button>
              </div>
            </>
          )}
        </footer>
      </section>
    </div>,
    document.body,
  ) : null;

  return dialog;
}
