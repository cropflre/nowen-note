import { api } from "@/lib/api";
import {
  emitMediaUploadLifecycle,
  resolveMediaUploadLifecycleFile,
} from "@/lib/mediaUploadLifecycle";

const VIDEO_EXTENSIONS = new Set(["mp4", "webm", "ogg", "ogv", "m4v", "mov"]);

export interface MediaUploadOptions {
  noteId: string;
  file: File;
  source?: "editor" | "markdown" | "paste" | "drag-drop";
}

export interface MediaUploadResult {
  attachmentId: string;
  url: string;
  previewUrl: string;
  filename: string;
  mimeType: string;
  size: number;
  source: "editor" | "markdown" | "paste" | "drag-drop";
}

function getFileExtension(filename: string): string {
  const idx = filename.lastIndexOf(".");
  if (idx < 0) return "";
  return filename.slice(idx + 1).toLowerCase();
}

export function isVideoFile(file: Pick<File, "name" | "type">): boolean {
  const mime = (file.type || "").toLowerCase();
  if (mime.startsWith("video/")) return true;
  return VIDEO_EXTENSIONS.has(getFileExtension(file.name || ""));
}

export function toInlineAttachmentUrl(url: string): string {
  if (!url.startsWith("/api/attachments/")) return url;
  if (/[?&]inline=1\b/.test(url)) return url;

  const hashIndex = url.indexOf("#");
  const base = hashIndex >= 0 ? url.slice(0, hashIndex) : url;
  const hash = hashIndex >= 0 ? url.slice(hashIndex) : "";
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}inline=1${hash}`;
}

export async function uploadMediaAttachment({
  noteId,
  file,
  source = "editor",
}: MediaUploadOptions): Promise<MediaUploadResult> {
  const lifecycleFile = resolveMediaUploadLifecycleFile(file);

  emitMediaUploadLifecycle({
    phase: "start",
    file: lifecycleFile,
    filename: file.name,
    mediaType: "video",
  });

  try {
    const uploaded = await api.attachments.upload(noteId, file);

    // 移动端 multipart 一旦被 WebView / native HTTP bridge 错误序列化，后端仍有
    // 可能收到一个“合法但字节不完整”的 File。此时绝不能继续把坏附件写进正文。
    // 服务端响应的 size 来自实际收到的 File.size，与选择器拿到的本地字节数必须一致。
    if (
      file.size > 0
      && Number.isFinite(uploaded.size)
      && uploaded.size > 0
      && uploaded.size !== file.size
    ) {
      throw new Error(
        `视频上传校验失败：本地 ${file.size} 字节，服务端 ${uploaded.size} 字节，请重新上传`,
      );
    }

    const result: MediaUploadResult = {
      attachmentId: uploaded.id,
      url: uploaded.url,
      previewUrl: toInlineAttachmentUrl(uploaded.url),
      filename: uploaded.filename || file.name,
      mimeType: uploaded.mimeType,
      size: uploaded.size,
      source,
    };
    emitMediaUploadLifecycle({
      phase: "success",
      file: lifecycleFile,
      filename: file.name,
      mediaType: "video",
      result,
    });
    return result;
  } catch (error: any) {
    emitMediaUploadLifecycle({
      phase: "error",
      file: lifecycleFile,
      filename: file.name,
      mediaType: "video",
      error: error?.message || "视频上传失败",
    });
    throw error;
  }
}
