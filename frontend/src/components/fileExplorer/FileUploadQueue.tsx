import { useTranslation } from "react-i18next";
import { humanFileSize } from "@/lib/fileExplorerModel";
import type { useFileUploadQueue } from "@/hooks/useFileUploadQueue";

export default function FileUploadQueue({ queue, onView, onMove }: {
  queue: ReturnType<typeof useFileUploadQueue>;
  onView: (id: string) => void;
  onMove: (id: string) => void;
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
  return <section aria-label={t("fileExplorer.uploadQueue")} className="shrink-0 border-t border-app-border bg-app-elevated p-3">
    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-tx-secondary">
      <span>{t("fileExplorer.queueSummary", { total: queue.tasks.length, success, failed, uploading, waiting })}{measurable && totalBytes > 0 ? ` · ${Math.round(progressBytes / totalBytes * 100)}%` : ""}</span>
      <button onClick={queue.clearCompleted} className="text-accent-primary">{t("fileExplorer.clearCompleted")}</button>
    </div>
    <div className="mt-2 max-h-40 overflow-auto space-y-2">
      {visibleTasks.map((task) => <div key={task.id} className="text-xs" data-upload-status={task.status}>
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate" title={task.file.name}>{task.file.name}</span>
          <span className="text-tx-tertiary">{humanFileSize(task.file.size)}</span>
          <span>{t(!queue.canCancelActive && task.status === "success" ? "fileExplorer.nativeCompleted" : `fileExplorer.uploadStatus.${task.status}`)}</span>
          {task.status === "uploading" && task.progress !== null && <span>{Math.floor(task.progress)}%</span>}
          {["waiting", "uploading"].includes(task.status) && <button disabled={task.status === "uploading" && !queue.canCancelActive} onClick={() => queue.cancel(task.id)} className="text-tx-secondary disabled:opacity-40">{t("common.cancel")}</button>}
          {task.status === "failed" && <button onClick={() => queue.retry(task.id)} className="text-accent-primary">{t("fileExplorer.retry")}</button>}
        </div>
        {task.status === "uploading" && task.progress !== null && <progress value={task.progress} max={100} className="mt-1 h-1 w-full" aria-label={task.file.name} />}
        {task.error && <p className="text-red-500" role="alert">{task.error}</p>}
        {task.status === "cancelled" && <p className="text-tx-tertiary">{t("fileExplorer.cancelHint")}</p>}
        {task.status === "existing" && task.result && <div className="flex flex-wrap gap-2 text-tx-secondary">
          <span>{t("fileExplorer.existsAt", { folder: task.result.folderName || t("fileExplorer.unorganized") })}</span>
          <button className="text-accent-primary" onClick={() => onView(task.result!.id)}>{t("fileExplorer.viewExisting")}</button>
          <button className="text-accent-primary" onClick={() => onMove(task.result!.id)}>{t("fileManager.moveFiles")}</button>
        </div>}
      </div>)}
    </div>
  </section>;
}
