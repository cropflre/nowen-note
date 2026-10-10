/**
 * The reference can be copied into a GitHub Issue without including a signed
 * URL, note content, backend stack trace or local filesystem paths.
 */
export type SupportError = {
  message: string;
  code?: string;
  reference?: string;
  referenceKind?: "requestId" | "operationId";
};

const CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,63}$/;
const REFERENCE_PATTERN = /^[a-zA-Z0-9_-]{8,64}$/;

/** Client-owned messages only; even a typed 500 from an older server might
 * contain SQL, signed URLs or a filesystem path in its `error` field. */
const SAFE_MESSAGES: Record<string, string> = {
  BACKUP_NOT_FOUND: "备份文件不存在",
  BACKUP_JOB_NOT_FOUND: "完整备份任务不存在或已过期",
  BACKUP_BUSY: "已有备份任务正在运行",
  FULL_BACKUP_JOB_BUSY: "已有完整备份任务正在运行",
  BACKUP_INVALID_FORMAT: "备份文件格式不正确或已损坏",
  BACKUP_RESTORE_VALIDATION_FAILED: "备份预检失败，请检查文件完整性与兼容性",
  BACKUP_RESTORE_FAILED: "备份恢复失败",
  BACKUP_CREATE_FAILED: "备份创建失败",
  BACKUP_IMPORT_FAILED: "备份导入失败",
  BACKUP_JOB_FAILED: "完整备份生成失败",
  BACKUP_STORAGE_NO_SPACE: "磁盘空间不足",
  BACKUP_STORAGE_PERMISSION_DENIED: "备份目录没有写入权限",
  SYSTEM_INTERNAL_ERROR: "服务器内部错误",
};

export function formatSupportError(error: unknown, fallbackMessage: string): SupportError {
  const data = error !== null && typeof error === "object"
    ? error as { message?: unknown; code?: unknown; requestId?: unknown; operationId?: unknown }
    : null;
  const code = typeof data?.code === "string" && CODE_PATTERN.test(data.code)
    ? data.code : undefined;
  const requestId = typeof data?.requestId === "string" && REFERENCE_PATTERN.test(data.requestId)
    ? data.requestId : undefined;
  const operationId = typeof data?.operationId === "string" && REFERENCE_PATTERN.test(data.operationId)
    ? data.operationId : undefined;
  // Never render arbitrary Error.message: even a well-formed error code can
  // accompany a server response containing credentials or private note data.
  const safeText = code ? SAFE_MESSAGES[code] || fallbackMessage : fallbackMessage;
  return {
    message: safeText,
    ...(code ? { code } : {}),
    ...(requestId
      ? { reference: requestId, referenceKind: "requestId" as const }
      : operationId ? { reference: operationId, referenceKind: "operationId" as const } : {}),
  };
}

export function formatSupportReference(error: SupportError): string | null {
  if (!error.code && !error.reference) return null;
  return [error.code, error.reference].filter(Boolean).join(" · ");
}
