import { getDb } from "../db/schema";

/** Summaries never expose note content, IDs, API keys or unredacted upstream bodies. */
export interface EmbeddingFailureGroup {
  code: "rate_limit" | "auth" | "client" | "provider" | "timeout" | "config" | "storage" | "other";
  label: string;
  count: number;
  example: string;
}

export interface EmbeddingIndexScope {
  userId: string;
  workspaceId: string | null;
}

const GROUP_LABELS: Record<EmbeddingFailureGroup["code"], string> = {
  rate_limit: "请求频率或额度限制 (429)",
  auth: "API Key / 权限错误",
  client: "模型或请求参数错误",
  provider: "服务商临时错误",
  timeout: "连接超时或网络故障",
  config: "Embedding 配置无效",
  storage: "本地索引或数据库错误",
  other: "其他索引错误",
};

export function classifyEmbeddingFailure(message: string): EmbeddingFailureGroup["code"] {
  if (/\b429\b|rate.?limit|too many requests|quota|限流|余额不足/i.test(message)) return "rate_limit";
  if (/\b401\b|\b403\b|unauthorized|invalid api key|permission denied|鉴权|密钥错误/i.test(message)) return "auth";
  if (/\b400\b|\b404\b|model does not exist|bad request|invalid model/i.test(message)) return "client";
  if (/\b5\d\d\b|service unavailable|bad gateway|upstream error/i.test(message)) return "provider";
  if (/timeout|timed out|aborterror|fetch failed|ECONN|ENOTFOUND|ETIMEDOUT|网络错误/i.test(message)) return "timeout";
  if (/配置|尚未|profile|未找到|未配置|missing.*model/i.test(message)) return "config";
  if (/SQLITE|vec0|database|constraint|dimension mismatch|数据库/i.test(message)) return "storage";
  return "other";
}

/** Only show a safe, bounded preview of the provider's failure message. */
export function publicEmbeddingError(message: string): string {
  // Upstream error bodies can echo prompt text, access tokens, URLs, and user
  // content. Classify on the server, but never send the raw lastError to clients
  // (especially other members of a shared workspace).
  const httpStatus = message.match(/\bHTTP\s*(\d{3})\b/i)?.[1];
  const reasons: Record<EmbeddingFailureGroup["code"], string> = {
    rate_limit: "服务商限流或配额不足，请稍后重试",
    auth: "API Key 无效或权限不足，请检查服务商配置",
    client: "模型名称或请求参数不符合服务要求",
    provider: "服务商暂时不可用，稍后自动重试",
    timeout: "网络连接失败或请求超时",
    config: "Embedding 配置不完整、未保存或引用已失效",
    storage: "本地数据库或向量索引写入出错，请检查后端日志",
    other: "索引任务发生未识别错误，请查看后端日志",
  };
  const explanation = reasons[classifyEmbeddingFailure(message)];
  return httpStatus ? `HTTP ${httpStatus} · ${explanation}` : explanation;
}

function scopeConditions(scope: EmbeddingIndexScope): { sql: string; params: string[] } {
  return scope.workspaceId === null
    ? { sql: "userId = ? AND workspaceId IS NULL", params: [scope.userId] }
    : { sql: "workspaceId = ?", params: [scope.workspaceId] };
}

export function getEmbeddingFailures(scope: EmbeddingIndexScope): {
  failed: number;
  notes: number;
  attachments: number;
  reasons: EmbeddingFailureGroup[];
} {
  const db = getDb();
  const { sql, params } = scopeConditions(scope);
  const groups = new Map<EmbeddingFailureGroup["code"], EmbeddingFailureGroup>();
  let notes = 0;
  let attachments = 0;
  for (const [table, kind] of [
    ["embedding_queue", "note"],
    ["attachment_embedding_queue", "attachment"],
  ] as const) {
    const rows = db.prepare(`
      SELECT COALESCE(lastError, '') AS message, COUNT(*) AS count
      FROM ${table}
      WHERE status = 'failed' AND ${sql}
      GROUP BY lastError
    `).all(...params) as Array<{ message: string; count: number }>;
    for (const row of rows) {
      if (kind === "note") notes += row.count;
      else attachments += row.count;
      const code = classifyEmbeddingFailure(row.message);
      const existing = groups.get(code);
      if (existing) {
        existing.count += row.count;
      } else {
        groups.set(code, {
          code,
          label: GROUP_LABELS[code],
          count: row.count,
          example: publicEmbeddingError(row.message || "未记录具体错误，请查看后端日志"),
        });
      }
    }
  }
  return {
    failed: notes + attachments,
    notes,
    attachments,
    reasons: [...groups.values()].sort((a, b) => b.count - a.count),
  };
}

/** Retry only failures. Existing vector rows and note/attachment content are untouched. */
export function retryFailedEmbeddings(scope: EmbeddingIndexScope): { notes: number; attachments: number; enqueued: number } {
  const db = getDb();
  const { sql, params } = scopeConditions(scope);
  let notes = 0;
  let attachments = 0;
  db.transaction(() => {
    const statement = (table: string) => db.prepare(`
      UPDATE ${table}
         SET status = 'pending', retries = 0, lastError = NULL,
             enqueuedAt = datetime('now'), updatedAt = datetime('now')
       WHERE status = 'failed' AND ${sql}
    `);
    notes = statement("embedding_queue").run(...params).changes;
    attachments = statement("attachment_embedding_queue").run(...params).changes;
  })();
  return { notes, attachments, enqueued: notes + attachments };
}
