/**
 * Sync V2 错误码。
 *
 * 同步失败必须能被稳定分类，因为客户端要据此决定：
 * - 继续重试（网络/服务端临时故障）；
 * - 进入冲突中心（VERSION_CONFLICT）；
 * - 回退到 snapshot 重建（SYNC_RESET_REQUIRED）；
 * - 暂停同步但保持本地可用（AUTH_EXPIRED）。
 *
 * 任何情况下这些错误都不得升级为"保存失败"：本地写入成功即为保存成功。
 */

export const SYNC_ERROR_CODES = [
  /** 携带的 baseVersion 与服务端当前版本不一致，禁止静默覆盖正文。 */
  "VERSION_CONFLICT",
  /** 客户端游标早于服务端可增量供给的最小序号，需回退 snapshot。 */
  "SYNC_RESET_REQUIRED",
  /** 远端凭据失效：同步暂停，本地读写不受影响。 */
  "AUTH_EXPIRED",
  /** 请求结构不合法（缺字段、实体越界、mutation 超限等）。 */
  "INVALID_PAYLOAD",
  /** 引用的父实体不存在（例如 note 指向未同步的 notebook）。 */
  "MISSING_DEPENDENCY",
  /** 网络不可达，属于可重试类别。 */
  "NETWORK_UNAVAILABLE",
  /** 服务端内部错误，属于可重试类别。 */
  "SERVER_ERROR",
] as const;

export type SyncErrorCode = (typeof SYNC_ERROR_CODES)[number];

export function isSyncErrorCode(value: unknown): value is SyncErrorCode {
  return typeof value === "string"
    && (SYNC_ERROR_CODES as readonly string[]).includes(value);
}

/**
 * 是否应继续自动重试。
 *
 * VERSION_CONFLICT 需要用户或冲突策略介入；AUTH_EXPIRED 需要重新授权；
 * SYNC_RESET_REQUIRED 需要改走 snapshot；INVALID_PAYLOAD / MISSING_DEPENDENCY
 * 重复提交同样会失败。这些都不该无脑轮询，但对应的 Outbox 条目仍然保留。
 */
export function isRetryableSyncError(code: SyncErrorCode): boolean {
  return code === "NETWORK_UNAVAILABLE" || code === "SERVER_ERROR";
}

export class SyncError extends Error {
  readonly code: SyncErrorCode;

  constructor(code: SyncErrorCode, message?: string) {
    super(message || code);
    this.name = "SyncError";
    this.code = code;
  }

  get retryable(): boolean {
    return isRetryableSyncError(this.code);
  }
}
