import { api, getServerUrl } from "./api";
import { toast } from "./toast";
import { emitMediaUploadLifecycle } from "./mediaUploadLifecycle";
import {
  isElectronFullLocalRuntime,
  shouldRejectRemoteOffline,
  uploadErrorMetadata,
  type UploadErrorCode,
} from "./uploadRequest";

export interface ImageUploadOptions {
  /** 图片文件 */
  file: File | Blob;
  /** 文件名 */
  filename: string;
  /** 关联笔记 ID */
  noteId?: string;
  /** 上传来源 */
  source?: "editor" | "markdown" | "paste" | "drag-drop";
}

export interface ImageUploadResult {
  success: boolean;
  /** 最终可访问的 Nowen 附件 URL */
  url?: string;
  /** 文件名 */
  filename?: string;
  /** 上传目标固定为 Nowen 附件系统 */
  target?: "local";
  /** 附件 ID */
  attachmentId?: string;
  error?: string;
  errorCode?: UploadErrorCode;
  retryable?: boolean;
}

function browserOnlineState(): boolean | undefined {
  return typeof navigator === "undefined" ? undefined : navigator.onLine;
}

function isDesktopFullLocalRuntime(): boolean {
  if (typeof window === "undefined") return false;
  return isElectronFullLocalRuntime(
    getServerUrl(),
    Boolean((window as any).nowenDesktop?.isDesktop),
  );
}

function asFile(file: File | Blob, filename: string): File {
  if (file instanceof File) return file;
  return new File([file], filename, {
    type: file.type || "application/octet-stream",
    lastModified: Date.now(),
  });
}

function failedResult(prefix: string, error: unknown): ImageUploadResult {
  const metadata = uploadErrorMetadata(error);
  return {
    success: false,
    error: `${prefix}: ${metadata.message}`,
    errorCode: metadata.code,
    retryable: metadata.retryable,
  };
}

/**
 * 统一图片上传。
 *
 * 所有图片都会先成为 Nowen 附件，再由服务端的附件存储驱动决定二进制实际写入
 * 本地磁盘、S3、R2 或 MinIO。图片始终拥有附件记录、权限、哈希、备份和迁移关系。
 */
export async function uploadImage(options: ImageUploadOptions): Promise<ImageUploadResult> {
  const { file, filename, noteId } = options;
  const online = browserOnlineState();
  const fullLocalRuntime = isDesktopFullLocalRuntime();

  if (shouldRejectRemoteOffline(online, fullLocalRuntime)) {
    return {
      success: false,
      error: "当前处于离线状态，图片尚未上传；请恢复网络后重试",
      errorCode: "OFFLINE",
      retryable: true,
    };
  }

  if (!noteId) {
    return {
      success: false,
      error: "附件上传需要 noteId",
      errorCode: "HTTP_ERROR",
      retryable: false,
    };
  }

  try {
    const result = await api.attachments.upload(noteId, asFile(file, filename));
    return {
      success: true,
      url: result.url,
      filename: result.filename || filename,
      target: "local",
      attachmentId: result.id,
    };
  } catch (error) {
    return failedResult("附件上传失败", error);
  }
}

/**
 * 上传图片并插入到编辑器。
 *
 * 用于 TiptapEditor / MarkdownEditor 的工具栏、粘贴和拖拽场景。
 */
export async function uploadAndInsertImage(
  file: File | Blob,
  filename: string,
  noteId: string | undefined,
  insertFn: (url: string, filename: string) => void,
  source: "editor" | "markdown" | "paste" | "drag-drop" = "editor",
): Promise<void> {
  emitMediaUploadLifecycle({
    phase: "start",
    file,
    filename,
    mediaType: "image",
  });

  try {
    const result = await uploadImage({ file, filename, noteId, source });

    if (result.success && result.url) {
      insertFn(result.url, result.filename || filename);
      emitMediaUploadLifecycle({
        phase: "success",
        file,
        filename,
        mediaType: "image",
        result,
      });
      return;
    }

    const message = result.error || "图片上传失败";
    emitMediaUploadLifecycle({
      phase: "error",
      file,
      filename,
      mediaType: "image",
      error: message,
      result,
    });
    toast.error(message);
  } catch (error: any) {
    const message = error?.message || "图片上传失败";
    emitMediaUploadLifecycle({
      phase: "error",
      file,
      filename,
      mediaType: "image",
      error: message,
    });
    toast.error(message);
  }
}
