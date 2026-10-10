import React, { useEffect, useState } from "react";
import { AlertCircle, Loader2, Paperclip } from "lucide-react";
import AttachmentPreview from "@/components/attachmentPreview/AttachmentPreview";
import { api, resolveAttachmentUrl } from "@/lib/api";
import { detectAttachmentPreviewKind } from "@/lib/attachmentOpenStrategy";
import type { FileItem } from "@/types";

interface Props {
  noteId: string;
  revision: number;
  content: string;
  onOpenAttachmentDirectory: () => void;
}

const FOLDER_SYNC_COMMENT_RE = /<!--\s*nowen-folder-sync:\s*([\s\S]*?)-->/i;
const RELATIVE_PATH_RE = /(?:^|\s)relativePath=([^\s]+)/i;

/** 仅识别由文件夹同步生成的 PDF / DOCX 占位笔记。 */
export function isFolderSyncAttachmentNote(content: string | null | undefined): boolean {
  if (!content) return false;
  const comment = content.match(FOLDER_SYNC_COMMENT_RE)?.[1] || "";
  const encodedPath = comment.match(RELATIVE_PATH_RE)?.[1];
  if (!encodedPath) return false;

  let relativePath = encodedPath;
  try {
    relativePath = decodeURIComponent(encodedPath);
  } catch {
    // 非法转义不影响扩展名兜底判断。
  }
  return /\.(?:pdf|docx)$/i.test(relativePath);
}

function isPreviewableAttachment(item: FileItem): boolean {
  const kind = detectAttachmentPreviewKind(item.mimeType, item.filename);
  return kind === "pdf" || kind === "docx";
}

function findPreviewableAttachment(items: FileItem[], content: string): FileItem | null {
  const attachmentId = content.match(/\/api\/attachments\/([0-9a-fA-F-]{36})/)?.[1]?.toLowerCase();
  if (attachmentId) {
    const byId = items.find((item) => item.id.toLowerCase() === attachmentId && isPreviewableAttachment(item));
    if (byId) return byId;
  }

  const sourceFilename = content.match(/^- 文件名：(.+)$/m)?.[1]?.trim().toLowerCase();
  if (sourceFilename) {
    const byName = items.find((item) => item.filename.toLowerCase() === sourceFilename && isPreviewableAttachment(item));
    if (byName) return byName;
  }

  return items.find(isPreviewableAttachment) || null;
}

export default function FolderSyncAttachmentPreviewPane({
  noteId,
  revision,
  content,
  onOpenAttachmentDirectory,
}: Props) {
  const [attachment, setAttachment] = useState<FileItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setAttachment(null);
    setLoading(true);
    setError("");

    api.files
      .list({ noteId, pageSize: 200, sort: "created_desc" })
      .then((result) => {
        if (cancelled) return;
        const next = findPreviewableAttachment(result.items, content);
        setAttachment(next);
        if (!next) setError("没有找到可预览的 PDF 或 DOCX 附件");
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        console.error("[FolderSyncAttachmentPreviewPane] load failed:", reason);
        setError("同步附件加载失败");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [content, noteId, revision]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-tx-tertiary">
        <Loader2 size={16} className="mr-2 animate-spin" />
        正在加载同步文件…
      </div>
    );
  }

  if (!attachment) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-tx-tertiary">
        <AlertCircle size={22} />
        <span className="text-sm">{error || "同步附件不可用"}</span>
        <button
          type="button"
          onClick={onOpenAttachmentDirectory}
          className="inline-flex items-center gap-1.5 rounded-md border border-app-border bg-app-surface px-3 py-1.5 text-xs text-tx-primary hover:bg-app-hover"
        >
          <Paperclip size={13} />
          打开附件目录
        </button>
      </div>
    );
  }

  return (
    <div className="h-full min-h-0 overflow-auto bg-app-bg p-3 md:p-5">
      <div className="mx-auto min-h-full w-full max-w-6xl overflow-hidden rounded-lg border border-app-border bg-app-surface shadow-sm">
        <AttachmentPreview
          url={resolveAttachmentUrl(attachment.url)}
          filename={attachment.filename}
          mimeType={attachment.mimeType}
          size={attachment.size}
          heightClass="min-h-full"
        />
      </div>
    </div>
  );
}
