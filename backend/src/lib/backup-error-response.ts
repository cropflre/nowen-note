import { randomUUID } from "node:crypto";
import type { Context } from "hono";
import { classifyFullBackupJobError } from "../services/full-backup-jobs";

export type BackupFailure = {
  code: string;
  message: string;
  status: 400 | 404 | 409 | 413 | 500;
  retryable: boolean;
};

/** Expose only stable public messages; raw BackupManager exceptions may contain
 * filesystem paths, SQL or archive entries originating from users. */
export function classifyBackupFailure(
  error: unknown,
  operation: "create" | "import" | "restore",
): BackupFailure {
  const source = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const typed = classifyFullBackupJobError(error);
  if (typed.code === "BACKUP_STORAGE_NO_SPACE" || typed.code === "BACKUP_STORAGE_PERMISSION_DENIED") {
    return { code: typed.code, message: typed.message, status: 500, retryable: false };
  }
  if (operation === "restore" && /备份文件不存在|backup file not found/i.test(source)) {
    return { code: "BACKUP_NOT_FOUND", message: "备份文件不存在", status: 404, retryable: false };
  }
  if (operation === "import" && /文件头|仅支持|格式|meta\.json|非法|损坏|invalid archive|bad zip|corrupt/i.test(source)) {
    return { code: "BACKUP_INVALID_FORMAT", message: "备份文件格式不正确或已损坏", status: 400, retryable: false };
  }
  if (operation === "restore" && /格式版本|schema.version|checksum|校验和|文件头|meta\.json|invalid archive|bad zip|corrupt|损坏/i.test(source)) {
    return { code: "BACKUP_RESTORE_VALIDATION_FAILED", message: "备份预检失败，请确认文件完整且版本兼容", status: 400, retryable: false };
  }
  const code = operation === "create" ? "BACKUP_CREATE_FAILED"
    : operation === "import" ? "BACKUP_IMPORT_FAILED" : "BACKUP_RESTORE_FAILED";
  const message = operation === "create" ? "备份创建失败，请根据故障编号查看日志"
    : operation === "import" ? "备份导入失败，请根据故障编号查看日志"
    : "备份恢复失败，请勿直接重复恢复操作，先根据故障编号查看日志";
  // Restore is not idempotent. Even on server errors do not suggest an automatic retry.
  return { code, message, status: 500, retryable: false };
}

/** Use only after the route's permission + sudo checks; do not disclose archive data. */
export function backupErrorResponse(c: Context, failure: BackupFailure): Response {
  const requestId = c.get("requestId") || randomUUID();
  console.error(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: "ERROR",
    event: "backup.http.failed",
    module: "backup",
    requestId,
    code: failure.code,
    httpStatus: failure.status,
  }));
  return c.json({
    error: failure.message,
    code: failure.code,
    requestId,
    retryable: failure.retryable,
  }, failure.status);
}
