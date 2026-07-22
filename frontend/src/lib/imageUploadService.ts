/**
 * 统一图片上传服务
 *
 * 根据图床配置和运行模式自动选择上传目标：
 * 1. Electron Full 本地模式明确离线 → 跳过外部图床，直接保存本地附件
 * 2. 远程模式明确离线 → 快速失败，不进入无限“上传中”
 * 3. 图床启用 → 在截止时间内上传，失败后按 fallbackToLocal 回退
 * 4. 图床未启用 → 上传到本地/远程附件服务
 */

import { api, getBaseUrl, getServerUrl } from "./api";
import { toast } from "./toast";
import { emitMediaUploadLifecycle } from "./mediaUploadLifecycle";
import {
  fetchJsonWithUploadDeadline,
  IMAGE_HOSTING_POLICY_TIMEOUT_MS,
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
  /** 关联笔记 ID（本地附件上传需要） */
  noteId?: string;
  /** 上传来源 */
  source?: "editor" | "markdown" | "paste" | "drag-drop";
}

export interface ImageUploadResult {
  success: boolean;
  /** 最终可访问的图片 URL */
  url?: string;
  /** 文件名 */
  filename?: string;
  /** 上传目标：image-hosting 或 local */
  target?: "image-hosting" | "local";
  /** 附件 ID（本地上传时有） */
  attachmentId?: string;
  /** 是否由图床失败后回退到本地 */
  fallbackUsed?: boolean;
  error?: string;
  errorCode?: UploadErrorCode;
  retryable?: boolean;
}

type ImageHostingPolicy = {
  enabled: boolean;
  fallbackToLocal: boolean;
};

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

async function readImageHostingPolicy(options: {
  fullLocalRuntime: boolean;
  online: boolean | undefined;
}): Promise<ImageHostingPolicy> {
  // Full 模式离线时本机后端仍可用，但第三方图床一定依赖外网；直接走本地附件，
  // 避免先等待一次注定失败的 S3 请求。
  if (options.fullLocalRuntime && options.online === false) {
    return { enabled: false, fallbackToLocal: true };
  }

  try {
    const status = await fetchJsonWithUploadDeadline<{
      enabled?: boolean;
      fallbackToLocal?: boolean;
    }>(
      `${getBaseUrl()}/image-hosting/status`,
      { method: "GET", cache: "no-store" },
      {
        timeoutMs: IMAGE_HOSTING_POLICY_TIMEOUT_MS,
        timeoutMessage: "读取图床策略超时",
        httpErrorMessage: "读取图床策略失败",
      },
    );
    return {
      enabled: status.enabled === true,
      fallbackToLocal: status.fallbackToLocal !== false,
    };
  } catch (error) {
    // 策略接口不可达时采用保守策略：不尝试外部图床，直接尝试附件服务。
    // 如果附件服务本身也不可达，它有独立硬超时并会进入明确错误状态。
    console.warn("[imageUpload] image hosting policy unavailable; using local attachment path", error);
    return { enabled: false, fallbackToLocal: true };
  }
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
 * 完整的离线 Blob 持久化不属于本函数职责；远程服务离线时返回可重试错误，
 * 确保调用方结束 loading 状态并允许用户恢复网络后重新选择/重试。
 */
export async function uploadImage(options: ImageUploadOptions): Promise<ImageUploadResult> {
  const { file, filename, noteId, source = "editor" } = options;
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

  const policy = await readImageHostingPolicy({ fullLocalRuntime, online });
  let fallbackUsed = false;

  if (policy.enabled) {
    try {
      const result = await api.imageHosting.upload(file, source);
      return {
        success: true,
        url: result.url,
        filename: result.filename,
        target: "image-hosting",
      };
    } catch (error) {
      const metadata = uploadErrorMetadata(error);
      console.warn("[imageUpload] image hosting upload failed:", metadata.message);
      if (!policy.fallbackToLocal) {
        return {
          success: false,
          error: `图床上传失败: ${metadata.message}`,
          errorCode: metadata.code,
          retryable: metadata.retryable,
        };
      }
      fallbackUsed = true;
      console.info("[imageUpload] falling back to local attachment storage");
    }
  }

  if (!noteId) {
    return {
      success: false,
      error: "本地附件上传需要 noteId",
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
      fallbackUsed,
    };
  } catch (error) {
    return failedResult("本地附件上传失败", error);
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

      if (result.fallbackUsed) {
        toast.info("图床不可用，图片已回退到本地存储");
      }
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
