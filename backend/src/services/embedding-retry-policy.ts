/**
 * Bounded, persisted retry policy using the queue's existing retries/updatedAt
 * columns; no schema migration or in-process timer is required for scheduling.
 */
export const MAX_EMBEDDING_RETRIES = 6;

export interface EmbeddingRetryDecision {
  retry: boolean;
  delaySeconds: number;
  rateLimited: boolean;
}

export function embeddingRetryDelaySeconds(retries: number, message: string): number {
  const backoff = Math.min(300, 15 * Math.pow(2, Math.max(0, retries - 1)));
  return /\b429\b|rate.?limit|too many requests/i.test(message)
    ? Math.max(60, backoff)
    : backoff;
}

export function embeddingRetryDecision(error: unknown, retryCount: number): EmbeddingRetryDecision {
  const msg = error instanceof Error ? error.message : String(error);
  const rateLimited = /\b429\b|rate.?limit|too many requests/i.test(msg);
  const transient = rateLimited || /HTTP\s*(408|425|500|502|503|504)\b|timeout|timed out|AbortError|fetch failed|ECONN|ENOTFOUND|ETIMEDOUT|network error/i.test(msg);
  // Client errors (400/401/403/404) and deterministic validation/storage failures
  // need a corrected config or a new build, not repeated provider requests.
  return {
    retry: transient && retryCount < MAX_EMBEDDING_RETRIES,
    delaySeconds: embeddingRetryDelaySeconds(retryCount, msg),
    rateLimited,
  };
}

/** SQL guard for note and attachment queues (q alias). Only attempted jobs wait. */
export const EMBEDDING_RETRY_DUE_SQL = `(
  q.retries = 0 OR datetime(q.updatedAt,
    '+' || max(
      CASE WHEN q.lastError LIKE '%429%' THEN 60 ELSE 0 END,
      min(300, 15 * (1 << min(8, max(0, q.retries - 1))))
    ) || ' seconds'
  ) <= datetime('now')
)`;
