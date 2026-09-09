import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Download,
  Eye,
  File,
  FileArchive,
  FileSpreadsheet,
  FileText,
  Image as ImageIcon,
  Loader2,
  Music,
  Paperclip,
  Trash2,
  Upload,
  Video,
} from "lucide-react";
import type { Task } from "@/types";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/toast";
import {
  listTaskAttachments,
  removeTaskAttachment,
  subscribeTaskAttachmentsChanged,
  taskAttachmentUrl,
  uploadTaskAttachment,
  type TaskAttachmentItem,
} from "@/lib/taskAttachmentClient";

function formatBytes(value: number): string {
  const bytes = Number.isFinite(value) && value > 0 ? value : 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function fileKind(item: TaskAttachmentItem): "image" | "pdf" | "audio" | "video" | "sheet" | "archive" | "document" | "file" {
  const mime = (item.mimeType || "").toLowerCase();
  const name = item.filename.toLowerCase();
  if (mime.startsWith("image/")) return "image";
  if (mime === "application/pdf" || name.endsWith(".pdf")) return "pdf";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  if (/\.(xlsx?|xlsm|csv)$/i.test(name) || /spreadsheet|excel|csv/.test(mime)) return "sheet";
  if (/\.(zip|rar|7z|tar|gz)$/i.test(name) || /zip|rar|7z|gzip|tar/.test(mime)) return "archive";
  if (/\.(docx?|pptx?|txt|md|rtf|json)$/i.test(name) || /word|powerpoint|text\//.test(mime)) return "document";
  return "file";
}

function KindIcon({ kind }: { kind: ReturnType<typeof fileKind> }) {
  const cls = "h-5 w-5";
  if (kind === "image") return <ImageIcon className={cls} />;
  if (kind === "audio") return <Music className={cls} />;
  if (kind === "video") return <Video className={cls} />;
  if (kind === "sheet") return <FileSpreadsheet className={cls} />;
  if (kind === "archive") return <FileArchive className={cls} />;
  if (kind === "document" || kind === "pdf") return <FileText className={cls} />;
  return <File className={cls} />;
}

function AttachmentPreview({ item }: { item: TaskAttachmentItem }) {
  const kind = fileKind(item);
  if (kind === "image") {
    return (
      <a href={item.url} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-md bg-app-elevated">
        <img src={item.url} alt={item.filename} className="max-h-64 w-full object-contain" loading="lazy" />
      </a>
    );
  }
  if (kind === "pdf") {
    return (
      <iframe
        src={item.url}
        title={item.filename}
        sandbox="allow-same-origin"
        className="h-72 w-full rounded-md border border-app-border bg-white"
      />
    );
  }
  if (kind === "video") {
    return <video src={item.url} controls preload="metadata" className="max-h-64 w-full rounded-md bg-black" />;
  }
  if (kind === "audio") {
    return <audio src={item.url} controls preload="metadata" className="w-full" />;
  }
  return null;
}

export default function TaskAttachmentSection({ task }: { task: Pick<Task, "id" | "title" | "description"> }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<TaskAttachmentItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await listTaskAttachments(task.id);
      setItems(next);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "加载任务附件失败");
    } finally {
      setLoading(false);
    }
  }, [task.id]);

  useEffect(() => {
    setLoading(true);
    setPreviewId(null);
    void load();
    return subscribeTaskAttachmentsChanged(task.id, () => void load());
  }, [load, task.id]);

  const uploadFiles = useCallback(async (files: File[]) => {
    if (files.length === 0) return;
    setUploading(true);
    try {
      for (const file of files) await uploadTaskAttachment(file, task.id);
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "任务附件上传失败");
    } finally {
      setUploading(false);
    }
  }, [load, task.id]);

  const isReferenced = (id: string) => {
    const needle = `/task-attachments/${id}`;
    return task.title.includes(needle) || (task.description || "").includes(needle);
  };

  const remove = async (item: TaskAttachmentItem) => {
    if (isReferenced(item.id)) {
      toast.error("该附件仍被任务标题或详情引用，请先移除正文中的对应图片后再删除");
      return;
    }
    if (!window.confirm(`确定删除附件“${item.filename}”吗？`)) return;
    setDeletingId(item.id);
    try {
      await removeTaskAttachment(item.id, task.id);
      setItems((prev) => prev.filter((current) => current.id !== item.id));
      if (previewId === item.id) setPreviewId(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "删除任务附件失败");
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <section
      className="rounded-lg border border-app-border bg-app-elevated/35 p-3"
      onDragOver={(event) => {
        if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
      }}
      onDrop={(event) => {
        const files = Array.from(event.dataTransfer?.files || []);
        if (files.length === 0) return;
        event.preventDefault();
        void uploadFiles(files);
      }}
    >
      <div className="mb-2 flex items-center gap-2">
        <Paperclip size={14} className="text-tx-tertiary" />
        <span className="text-xs font-medium uppercase tracking-wider text-tx-tertiary">附件</span>
        {!loading && items.length > 0 && (
          <span className="rounded-full bg-app-hover px-1.5 py-0.5 text-[10px] text-tx-tertiary">{items.length}</span>
        )}
        <button
          type="button"
          disabled={uploading}
          onClick={() => inputRef.current?.click()}
          className="ml-auto inline-flex items-center gap-1 rounded-md border border-app-border px-2 py-1 text-[11px] text-tx-secondary transition-colors hover:border-accent-primary/40 hover:text-accent-primary disabled:opacity-50"
        >
          {uploading ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />}
          {uploading ? "上传中" : "上传文件"}
        </button>
        <input
          ref={inputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(event) => {
            const files = Array.from(event.target.files || []);
            event.target.value = "";
            void uploadFiles(files);
          }}
        />
      </div>

      {loading ? (
        <div className="flex min-h-16 items-center justify-center text-tx-tertiary"><Loader2 size={16} className="animate-spin" /></div>
      ) : items.length === 0 ? (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="flex min-h-20 w-full flex-col items-center justify-center gap-1 rounded-md border border-dashed border-app-border text-xs text-tx-tertiary transition-colors hover:border-accent-primary/40 hover:text-accent-primary"
        >
          <Upload size={18} />
          <span>点击上传，或把文件拖到这里</span>
          <span className="text-[10px]">图片可直接预览，PDF/音视频支持内嵌查看，Office 等文件可打开或下载</span>
        </button>
      ) : (
        <div className="space-y-2">
          {items.map((item) => {
            const kind = fileKind(item);
            const canPreview = kind === "image" || kind === "pdf" || kind === "audio" || kind === "video";
            const expanded = kind === "image" || previewId === item.id;
            return (
              <div key={item.id} className="overflow-hidden rounded-md border border-app-border bg-app-bg">
                <div className="flex min-w-0 items-center gap-2 p-2">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-app-elevated text-tx-secondary">
                    <KindIcon kind={kind} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-medium text-tx-primary" title={item.filename}>{item.filename}</div>
                    <div className="mt-0.5 truncate text-[10px] text-tx-tertiary">
                      {formatBytes(item.size)} · {item.mimeType || "application/octet-stream"}
                    </div>
                  </div>
                  {canPreview && kind !== "image" && (
                    <button
                      type="button"
                      title={expanded ? "收起预览" : "预览"}
                      onClick={() => setPreviewId(expanded ? null : item.id)}
                      className={cn("rounded p-1.5 text-tx-tertiary hover:bg-app-hover hover:text-tx-primary", expanded && "text-accent-primary")}
                    >
                      <Eye size={14} />
                    </button>
                  )}
                  <a
                    href={item.url}
                    target="_blank"
                    rel="noreferrer"
                    title="打开"
                    className="rounded p-1.5 text-tx-tertiary hover:bg-app-hover hover:text-accent-primary"
                  >
                    <Eye size={14} />
                  </a>
                  <a
                    href={taskAttachmentUrl(item.id, { download: true })}
                    title="下载"
                    className="rounded p-1.5 text-tx-tertiary hover:bg-app-hover hover:text-accent-primary"
                  >
                    <Download size={14} />
                  </a>
                  <button
                    type="button"
                    title="删除"
                    disabled={deletingId === item.id}
                    onClick={() => void remove(item)}
                    className="rounded p-1.5 text-tx-tertiary hover:bg-red-500/10 hover:text-red-500 disabled:opacity-50"
                  >
                    {deletingId === item.id ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                  </button>
                </div>
                {expanded && canPreview && (
                  <div className="border-t border-app-border p-2">
                    <AttachmentPreview item={item} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
