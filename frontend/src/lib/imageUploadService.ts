/**
 * 统一图片上传服务
 *
 * 根据图床配置自动选择上传目标：
 * 1. 图床启用 → 上传到第三方图床
 * 2. 图床未启用 / 上传失败且 fallbackToLocal → 上传到本地附件
 * 3. 上传失败且不允许 fallback → 返回错误
 */

import { api } from "./api";
import { toast } from "./toast";
import { emitMediaUploadLifecycle } from "./mediaUploadLifecycle";

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
  error?: string;
}

/** 检查图床是否启用 */
async function isImageHostingEnabled(): Promise<boolean> {
  try {
    const status = await api.imageHosting.getStatus();
    return status.enabled;
  } catch {
    return false;
  }
}

/** 获取 fallbackToLocal 配置 */
async function getFallbackToLocal(): Promise<boolean> {
  try {
    const config = await api.imageHosting.getConfig();
    return config.enabled && (config as any).fallbackToLocal !== false;
  } catch {
    return true; // 默认允许 fallback
  }
}

/**
 * 统一图片上传
 *
 * 优先使用图床，失败时按配置回退本地附件。
 */
export async function uploadImage(options: ImageUploadOptions): Promise<ImageUploadResult> {
  const { file, filename, noteId, source = "editor" } = options;

  // 检查图床是否启用
  const hostingEnabled = await isImageHostingEnabled();

  if (hostingEnabled) {
    try {
      // 上传到图床
      const result = await api.imageHosting.upload(file, source);
      return {
        success: true,
        url: result.url,
        filename: result.filename,
        target: "image-hosting",
      };
    } catch (err: any) {
      console.warn("[imageUpload] Image hosting upload failed:", err.message);

      // 检查是否允许 fallback
      const fallback = await getFallbackToLocal();
      if (!fallback) {
        return {
          success: false,
          error: `图床上传失败: ${err.message}`,
        };
      }

      // fallback 到本地附件
      console.log("[imageUpload] Falling back to local attachment storage");
    }
  }

  // 本地附件上传
  if (!noteId) {
    return {
      success: false,
      error: "本地附件上传需要 noteId",
    };
  }

  try {
    const result = await api.attachments.upload(noteId, file as File);
    return {
      success: true,
      url: result.url,
      filename: result.filename || filename,
      target: "local",
      attachmentId: result.id,
    };
  } catch (err: any) {
    return {
      success: false,
      error: `本地附件上传失败: ${err.message}`,
    };
  }
}

/**
 * 上传图片并插入到编辑器
 *
 * 用于 TiptapEditor / MarkdownEditor 的图片上传场景。
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

      // 提示 fallback
      if (result.target === "local") {
        toast.info("图片已回退到本地存储");
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
    throw error;
  }
}
