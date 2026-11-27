import { useTranslation } from "react-i18next";
import { UploadCloud } from "lucide-react";
import { humanFileSize } from "@/lib/fileExplorerModel";
import type { useFileUploadQueue } from "@/hooks/useFileUploadQueue";
import type { FileItem } from "@/types";

export default function FileUploadQueue({ queue, onView, onMove, onCopyLink }: {
  queue: ReturnType<typeof useFileUploadQueue>;
  onView: (id: string) => void;
  onMove: (id: string) => void;
  /** Image hosting: copy the uploaded file's public link straight from the queue. */
  onCopyLink?: (file: FileItem) => void;
}) {
  const { t } = useTranslation();
  if (!queue.tasks.length) return null;
  const success = queue.tasks.filter((task) => ["success", "existing"].includes(task.status)).length;
  const failed = queue.tasks.filter((task) => task.status === "failed").length;
  const uploading = queue.tasks.filter((task) => task.status === "uploading").length;
  const waiting = queue.tasks.filter((task) => task.status === "waiting").length;
  const totalBytes = queue.tasks.reduce((sum, task) => sum + task.file.size, 0);
  const progressBytes = queue.tasks.reduce((sum, task) => sum + task.file.size * (task.progress || 0) / 100, 0);
  const measurable = queue.canCancelActive && queue.tasks.some((task) => task.progress !== null);
  const priority = { uploading: 0, waiting: 1, failed: 2, existing: 3, success: 4, cancelled: 5 };
  const visibleTasks = [...queue.tasks].sort((left, right) => priority[left.status] - priority[right.status]);

  return (
    <section
      aria-label={t("fileExplorer.uploadQueue")}
      className="shrink-0 border-t border-app-border/80 bg-app-elevated/90 px-4 py-3 backdrop-blur-md"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-tx-secondary">
        <span className="inline-flex items-center gap-2 font-medium">
          <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-sky-500/12 text-sky-600 dark:text-sky-300">
            <UploadCloud size={14} />
          </span>
          {t("fileExplorer.queueSummary", { total: queue.tasks.length, success, failed, uploading, waiting })}
          {measurable && totalBytes > 0 ? ` · ${Math.round(progressBytes / totalBytes * 100)}%` : ""}
        </span>
        <button
          onClick={queue.clearCompleted}
          className="rounded-lg px-2 py-1 font-medium text-accent-primary transition-colors hover:bg-accent-primary/10"
        >
          {t("fileExplorer.clearCompleted")}
        </button>
      </div>
      <div className="mt-2.5 max-h-40 space-y-2 overflow-auto">
        {visibleTasks.map((task) => (
          <div
            key={task.id}
            className="rounded-xl border border-app-border/65 bg-app-surface/85 px-3 py-2 text-xs"
            data-upload-status={task.status}
          >
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate font-medium text-tx-primary" title={task.file.name}>{task.file.name}</span>
              <span className="tabular-nums text-tx-tertiary">{humanFileSize(task.file.size)}</span>
              <span className="rounded-full bg-app-hover px-2 py-0.5 text-[11px] text-tx-secondary">
                {t(!queue.canCancelActive && task.status === "success" ? "fileExplorer.nativeCompleted" : `fileExplorer.uploadStatus.${task.status}`)}
              </span>
              {task.status === "uploading" && task.progress !== null && (
                <span className="tabular-nums font-medium text-accent-primary">{Math.floor(task.progress)}%</span>
              )}
              {["waiting", "uploading"].includes(task.status) && (
                <button
                  disabled={task.status === "uploading" && !queue.canCancelActive}
                  onClick={() => queue.cancel(task.id)}
                  className="text-tx-secondary hover:text-tx-primary disabled:opacity-40"
                >
                  {t("common.cancel")}
                </button>
              )}
              {task.status === "failed" && (
                <button onClick={() => queue.retry(task.id)} className="font-medium text-accent-primary hover:underline">
                  {t("fileExplorer.retry")}
                </button>
              )}
              {onCopyLink && task.result && ["success", "existing"].includes(task.status) && (
                <button onClick={() => onCopyLink(task.result!)} className="font-medium text-accent-primary hover:underline">
                  {t("fileExplorer.imageHost.copyLink")}
                </button>
              )}
            </div>
            {task.status === "uploading" && task.progress !== null && (
              <progress
                value={task.progress}
                max={100}
                className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full [accent-color:var(--color-accent-primary)]"
                aria-label={task.file.name}
              />
            )}
            {task.error && <p className="mt-1 text-red-500" role="alert">{task.error}</p>}
            {task.status === "cancelled" && <p className="mt-1 text-tx-tertiary">{t("fileExplorer.cancelHint")}</p>}
            {task.status === "existing" && task.result && (
              <div className="mt-1.5 flex flex-wrap gap-2 text-tx-secondary">
                <span>{t("fileExplorer.existsAt", { folder: task.result.folderName || t("fileExplorer.unorganized") })}</span>
                <button className="font-medium text-accent-primary hover:underline" onClick={() => onView(task.result!.id)}>{t("fileExplorer.viewExisting")}</button>
                <button className="font-medium text-accent-primary hover:underline" onClick={() => onMove(task.result!.id)}>{t("fileManager.moveFiles")}</button>
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
