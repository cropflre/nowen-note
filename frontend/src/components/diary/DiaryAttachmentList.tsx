import React, { Suspense, lazy, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  File,
  FileArchive,
  FileSpreadsheet,
  FileText,
  Image as ImageIcon,
  Loader2,
  Music,
  RotateCcw,
  Trash2,
  Video,
  X,
} from "lucide-react";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { downloadAttachment } from "@/lib/downloadFile";
import { detectAttachmentPreviewKind } from "@/lib/attachmentOpenStrategy";

// 预览分发器会按需加载 PDF / Office / 表格解析器，说说页首屏不需要它。
const AttachmentPreview = lazy(() => import("@/components/attachmentPreview/AttachmentPreview"));

/** 说说附件区的一行：已发布的附件，或发布框 / 编辑器里待发布的上传。 */
export interface DiaryAttachmentViewItem {
  /** React key：已上传的项用服务端 id，上传中的项用本地随机 key。 */
  key: string;
  /** 服务端 id；上传中或上传失败时为 null。 */
  id: string | null;
  filename: string;
  mimeType: string;
  size: number;
  /** 缺省视为 ready。 */
  status?: "uploading" | "ready" | "error";
  errorMessage?: string;
  /** 被服务端策略拒绝（过大、类型被拦截、服务器不支持）时为 false，不再提供重试。 */
  retryable?: boolean;
}

function formatBytes(value: number): string {
  const bytes = Number.isFinite(value) && value > 0 ? value : 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function KindIcon({ mimeType, filename }: { mimeType: string; filename: string }) {
  const mime = (mimeType || "").toLowerCase();
  const name = filename.toLowerCase();
  const className = "h-4 w-4";
  if (mime.startsWith("image/")) return <ImageIcon className={className} />;
  if (mime.startsWith("audio/")) return <Music className={className} />;
  if (mime.startsWith("video/")) return <Video className={className} />;
  if (/\.(xlsx?|xlsm|csv)$/.test(name) || /spreadsheet|excel|csv/.test(mime)) return <FileSpreadsheet className={className} />;
  if (/\.(zip|rar|7z|tar|gz)$/.test(name) || /zip|rar|7z|gzip|tar/.test(mime)) return <FileArchive className={className} />;
  if (mime === "application/pdf" || /\.(pdf|docx?|pptx?|txt|md|rtf|json)$/.test(name) || /word|powerpoint|text\//.test(mime)) {
    return <FileText className={className} />;
  }
  return <File className={className} />;
}

const actionClass = "shrink-0 rounded-md p-1.5 text-tx-tertiary transition-colors hover:bg-app-hover hover:text-accent-primary";

export default function DiaryAttachmentList({
  items,
  onRemove,
  onRetry,
  removeMode = "remove",
}: {
  items: DiaryAttachmentViewItem[];
  /** 不传则不显示删除按钮（例如上传中的项）。 */
  onRemove?: (item: DiaryAttachmentViewItem) => void;
  onRetry?: (item: DiaryAttachmentViewItem) => void;
  /** remove：从待发布列表移除（发布框 / 编辑器）；delete：直接删除已发布的附件。 */
  removeMode?: "remove" | "delete";
}) {
  const { t } = useTranslation();
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  if (items.length === 0) return null;

  const removeLabel = removeMode === "delete" ? t("diary.attachment.delete") : t("diary.attachment.remove");

  return (
    <ul className="mt-3 space-y-1.5" aria-label={t("diary.attachment.title")}>
      {items.map((item) => {
        const ready = (item.status ?? "ready") === "ready" && !!item.id;
        const url = ready && item.id ? api.diaryImages.urlFor(item.id) : "";
        const previewable = ready && detectAttachmentPreviewKind(item.mimeType, item.filename) !== "unsupported";
        const expanded = previewable && previewKey === item.key;
        const subtitle = item.status === "uploading"
          ? t("diary.attachment.uploading")
          : item.status === "error"
            ? item.errorMessage || t("diary.attachment.uploadFailed")
            : `${formatBytes(item.size)} · ${item.mimeType || "application/octet-stream"}`;

        return (
          <li
            key={item.key}
            data-diary-attachment={item.id || item.key}
            className="overflow-hidden rounded-lg border border-app-border bg-app-bg/60"
          >
            <div className="flex min-w-0 items-center gap-1 p-1.5 pl-2">
              <div className="mr-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-app-hover/60 text-tx-secondary">
                <KindIcon mimeType={item.mimeType} filename={item.filename} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-medium text-tx-primary" title={item.filename}>{item.filename}</div>
                <div
                  className={item.status === "error" ? "mt-0.5 truncate text-[10px] text-red-500" : "mt-0.5 truncate text-[10px] text-tx-tertiary"}
                  title={subtitle}
                >
                  {subtitle}
                </div>
              </div>
              {item.status === "uploading" && <Loader2 size={14} className="mx-1.5 shrink-0 animate-spin text-tx-tertiary" />}
              {item.status === "error" && item.retryable !== false && onRetry && (
                <button
                  type="button"
                  onClick={() => onRetry(item)}
                  title={t("diary.attachment.retry")}
                  aria-label={`${t("diary.attachment.retry")} ${item.filename}`}
                  className={actionClass}
                >
                  <RotateCcw size={14} />
                </button>
              )}
              {previewable && (
                <button
                  type="button"
                  aria-pressed={expanded}
                  onClick={() => setPreviewKey(expanded ? null : item.key)}
                  title={expanded ? t("diary.attachment.collapse") : t("diary.attachment.preview")}
                  aria-label={`${expanded ? t("diary.attachment.collapse") : t("diary.attachment.preview")} ${item.filename}`}
                  className={expanded ? `${actionClass} text-accent-primary` : actionClass}
                >
                  {expanded ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              )}
              {url && (
                <a
                  href={url}
                  target="_blank"
                  rel="noreferrer"
                  title={t("diary.attachment.open")}
                  aria-label={`${t("diary.attachment.open")} ${item.filename}`}
                  className={actionClass}
                >
                  <ExternalLink size={14} />
                </a>
              )}
              {url && (
                <button
                  type="button"
                  onClick={() => {
                    downloadAttachment(url, item.filename).catch(() => toast.error(t("diary.attachment.downloadFailed")));
                  }}
                  title={t("diary.attachment.download")}
                  aria-label={`${t("diary.attachment.download")} ${item.filename}`}
                  className={actionClass}
                >
                  <Download size={14} />
                </button>
              )}
              {onRemove && item.status !== "uploading" && (
                <button
                  type="button"
                  onClick={() => onRemove(item)}
                  title={removeLabel}
                  aria-label={`${removeLabel} ${item.filename}`}
                  className="shrink-0 rounded-md p-1.5 text-tx-tertiary transition-colors hover:bg-red-500/10 hover:text-red-500"
                >
                  {removeMode === "delete" ? <Trash2 size={14} /> : <X size={14} />}
                </button>
              )}
            </div>
            {expanded && (
              <div className="border-t border-app-border p-2">
                <Suspense
                  fallback={(
                    <div className="flex min-h-[120px] items-center justify-center text-tx-tertiary">
                      <Loader2 size={16} className="animate-spin" />
                    </div>
                  )}
                >
                  <AttachmentPreview
                    url={url}
                    filename={item.filename}
                    mimeType={item.mimeType}
                    size={item.size}
                    heightClass="min-h-[200px]"
                    imgMaxHeightClass="max-h-[360px]"
                  />
                </Suspense>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
