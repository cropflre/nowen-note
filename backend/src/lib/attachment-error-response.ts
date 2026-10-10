import { randomUUID } from "node:crypto";
import type { Context } from "hono";
import { classifyAttachmentStorageError } from "../services/attachment-storage";

export type AttachmentWriteStage =
  | "read"
  | "database"
  | "storage"
  | "repair-storage"
  | "repair-database"
  | "repair-references";

export interface AttachmentWriteFailure {
  code: string;
  error: string;
  retryable: boolean;
}

/**
 * Upload POST is not intrinsically idempotent (a new attachment ID is created).
 * Do not ask clients to auto-retry a failed upload even when a server fails.
 * Keep existing storage and DB codes for older clients.
 */
export function classifyAttachmentWriteFailure(stage: AttachmentWriteStage, cause: unknown): AttachmentWriteFailure {
  if (stage === "storage" || stage === "repair-storage") {
    const storage = classifyAttachmentStorageError(cause);
    const error = storage.code === "ATTACHMENT_STORAGE_NO_SPACE"
      ? "写入文件失败：存储空间不足，请释放空间后重试"
      : storage.code === "ATTACHMENT_STORAGE_PERMISSION_DENIED"
        ? "写入文件失败：附件目录没有写入权限"
        : storage.code === "ATTACHMENT_STORAGE_CONFIG_INVALID"
          ? "写入文件失败：对象存储配置不正确，请联系管理员"
          : "写入文件失败：附件存储暂时不可写";
    return { code: storage.code, error, retryable: false };
  }
  if (stage === "read") return {
    code: "ATTACHMENT_READ_FAILED", error: "读取上传内容失败，请重新选择文件", retryable: false,
  };
  if (stage === "repair-references") return {
    code: "ATTACHMENT_REPAIR_REFERENCES_FAILED",
    error: "移除悬空引用失败，请根据故障编号检查服务端日志", retryable: false,
  };
  return {
    code: "ATTACHMENT_DB_WRITE_FAILED",
    error: stage === "repair-database" ? "更新附件元数据失败，请根据故障编号检查服务端日志"
      : "写入数据库失败，请根据故障编号检查服务端日志",
    retryable: false,
  };
}

/** Log only allowlisted classification and stage, never raw DB/S3 response text. */
export function attachmentWriteErrorResponse(c: Context, stage: AttachmentWriteStage, cause: unknown): Response {
  const failure = classifyAttachmentWriteFailure(stage, cause);
  const requestId = c.get("requestId") || randomUUID();
  console.error(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: "ERROR",
    event: "attachment.write.failed",
    module: "attachment",
    stage,
    requestId,
    code: failure.code,
    httpStatus: 500,
  }));
  return c.json({ ...failure, requestId }, 500);
}
