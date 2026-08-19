import { SYNC_LOG_PREFIX } from "./constants";

/**
 * Sync V2 统一日志。
 *
 * 同步问题基本只能靠用户反馈定位，因此日志必须结构化且可安全外发：
 * 记录计数、序号、耗时、错误码，绝不记录笔记正文、密码、Token、附件二进制。
 *
 * 实现方式是白名单而非黑名单——只允许已知安全字段通过，
 * 这样将来新增字段时不会因为忘记加脱敏规则而泄漏用户内容。
 */

export interface SyncLogFields {
  profileId?: string | null;
  deviceId?: string | null;
  scopeKey?: string | null;
  pushCount?: number;
  pullSequence?: number;
  applyCount?: number;
  conflictCount?: number;
  pendingCount?: number;
  durationMs?: number;
  retryCount?: number;
  errorCode?: string;
  entityType?: string;
  entityId?: string;
  /** 仅允许布尔/数字型状态标记，禁止塞入自由文本。 */
  state?: string;
}

const ALLOWED_FIELDS: readonly (keyof SyncLogFields)[] = [
  "profileId",
  "deviceId",
  "scopeKey",
  "pushCount",
  "pullSequence",
  "applyCount",
  "conflictCount",
  "pendingCount",
  "durationMs",
  "retryCount",
  "errorCode",
  "entityType",
  "entityId",
  "state",
];

/**
 * 把字段序列化为 `key=value` 序列。
 *
 * entityId 等标识符会被截断：它本身不是敏感内容，但过长值通常意味着
 * 调用方误传了 payload。
 */
export function formatSyncLog(event: string, fields: SyncLogFields = {}): string {
  const parts: string[] = [`${SYNC_LOG_PREFIX} ${event}`];
  for (const key of ALLOWED_FIELDS) {
    const value = fields[key];
    if (value === undefined || value === null || value === "") continue;
    const rendered = typeof value === "number" ? String(value) : String(value).slice(0, 128);
    parts.push(`${key}=${rendered}`);
  }
  return parts.join(" ");
}

export function logSyncInfo(event: string, fields?: SyncLogFields): void {
  console.log(formatSyncLog(event, fields));
}

export function logSyncWarn(event: string, fields?: SyncLogFields): void {
  console.warn(formatSyncLog(event, fields));
}

export function logSyncError(event: string, fields?: SyncLogFields): void {
  console.error(formatSyncLog(event, fields));
}
