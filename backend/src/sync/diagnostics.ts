import { createHash } from "node:crypto";

import { isRootDocumentNotebookId } from "../services/knowledgeTreeRootDocuments.js";
import { SyncError, isRetryableSyncError, type SyncErrorCode, type SyncFailureDiagnostic } from "./errors";
import type { SyncLogFields } from "./log";

/**
 * 同步失败的安全诊断与分类。
 *
 * 背景：SQLite 触发器守卫（如 NOTEBOOK_PARENT_NOT_FOUND）抛出的是裸 SqliteError，
 * 过去会被一律当成 SERVER_ERROR：日志里只剩一个 errorCode=SERVER_ERROR，
 * 调用方又会因为"可重试"而无限重试同一份必然失败的载荷。
 *
 * 这里的所有输出都必须可以安全外发：只有阶段名、固定枚举、SQLite 错误码，
 * 以及经过 redactEntityId 的标识。笔记正文、标题、令牌、SQL 参数一律不出现。
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 实体标识脱敏。
 *
 * - 根文档容器：用固定标签，它本身带着服务器账号 ID；
 * - UUID：只保留前 8 位，足够在 NAS 上用 `id LIKE 'xxxxxxxx%'` 定位，但无法还原完整 ID；
 * - 其它形态：导入或第三方生成的 ID 可能内嵌标题等内容，只输出不可逆的短哈希。
 */
export function redactEntityId(value: unknown): string | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  if (isRootDocumentNotebookId(value)) return "root-documents";
  if (UUID_PATTERN.test(value)) return `${value.slice(0, 8)}…`;
  return `h:${createHash("sha256").update(value).digest("hex").slice(0, 10)}`;
}

const RAISE_TOKEN = /^[A-Z][A-Z0-9_]{2,63}$/;
const CONSTRAINT_MESSAGE = /^(UNIQUE|NOT NULL|CHECK|FOREIGN KEY|PRIMARY KEY) constraint failed(?:: ([A-Za-z0-9_.,\s]{1,80}))?$/;

/**
 * 从 SQLite 错误消息里提取可安全记录的原因。
 *
 * 只接受两种形态：触发器 `RAISE(ABORT, 'TOKEN')` 的固定标记，以及 SQLite 自带的
 * 约束类别（只含表名/列名，不含取值）。其它自由文本一律丢弃。
 */
export function sqliteFailureReason(message: unknown): string | undefined {
  if (typeof message !== "string") return undefined;
  const text = message.trim();
  if (RAISE_TOKEN.test(text)) return text;
  const constraint = CONSTRAINT_MESSAGE.exec(text);
  if (!constraint) return undefined;
  return constraint[2] ? `${constraint[1]} ${constraint[2].trim()}` : constraint[1];
}

export function isSqliteError(error: unknown): error is Error & { code: string } {
  const candidate = error as { name?: unknown; code?: unknown } | null | undefined;
  return candidate?.name === "SqliteError"
    && typeof candidate.code === "string"
    && candidate.code.startsWith("SQLITE_");
}

export function structureFailureMessage(reason?: string): string {
  return `同步数据的目录或引用结构与本机不一致${reason ? `（${reason}）` : ""}，已停止自动重试。`
    + "本机笔记和服务器数据均未改动，可继续在线使用。";
}

/**
 * 把落库阶段抛出的 SQLite 错误归类为 SyncError。
 *
 * - 约束类失败（外键、唯一、触发器守卫…）：同一份载荷再应用必然再次失败 → DATA_STRUCTURE，不可重试；
 * - 其余 SQLite 错误（BUSY、IO、磁盘满…）：可能是暂时的 → SERVER_ERROR，保持可重试；
 * - 已经是 SyncError、或根本不是 SQLite 错误：原样返回，不改变既有语义。
 */
export function classifyApplyFailure(error: unknown, context: SyncFailureDiagnostic = {}): unknown {
  if (error instanceof SyncError || !isSqliteError(error)) return error;
  const reason = sqliteFailureReason(error.message);
  const diagnostic: SyncFailureDiagnostic = {
    ...context,
    sqliteCode: error.code,
    ...(reason ? { reason } : {}),
  };
  if (error.code.startsWith("SQLITE_CONSTRAINT")) {
    return new SyncError("DATA_STRUCTURE", structureFailureMessage(reason ?? error.code), diagnostic);
  }
  return new SyncError(
    "SERVER_ERROR",
    `本机数据库暂时无法写入（${error.code}），数据未改动，稍后会重试。`,
    diagnostic,
  );
}

export interface SyncFailureDescription {
  code: SyncErrorCode;
  retryable: boolean;
  message: string;
  diagnostic: SyncFailureDiagnostic;
}

/**
 * 供路由、迁移进度等出口使用：把任意错误描述成"码 + 是否可重试 + 面向用户的话 + 诊断"。
 *
 * message 对非 SyncError 沿用旧行为（截断后的原始消息），保证现有提示文案不变。
 */
export function describeSyncFailure(error: unknown, stage?: string): SyncFailureDescription {
  const classified = classifyApplyFailure(error, stage ? { stage } : {});
  if (classified instanceof SyncError) {
    return {
      code: classified.code,
      retryable: isRetryableSyncError(classified.code),
      message: classified.message.slice(0, 300),
      diagnostic: { ...(stage ? { stage } : {}), ...classified.diagnostic },
    };
  }
  return {
    code: "SERVER_ERROR",
    retryable: true,
    message: classified instanceof Error ? classified.message.slice(0, 200) : "UNKNOWN",
    diagnostic: stage ? { stage } : {},
  };
}

/** 诊断 → 日志字段。日志白名单之外的内容不会被写出。 */
export function diagnosticLogFields(
  code: SyncErrorCode | string,
  diagnostic: SyncFailureDiagnostic | undefined,
  retryable: boolean,
): SyncLogFields {
  return {
    errorCode: code,
    retryable,
    stage: diagnostic?.stage,
    step: diagnostic?.step,
    reason: diagnostic?.reason,
    sqliteCode: diagnostic?.sqliteCode,
    entityType: diagnostic?.entityType,
    entityId: diagnostic?.entityId,
    parentId: diagnostic?.parentId,
    parentState: diagnostic?.parentState,
  };
}
