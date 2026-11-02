export const DEFAULT_EMBEDDING_TIMEOUT_SECONDS = 30;
export const MAX_EMBEDDING_TIMEOUT_SECONDS = 600;

export function parseEmbeddingTimeoutSeconds(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const seconds = Number(value);
  return Number.isInteger(seconds)
    && seconds >= DEFAULT_EMBEDDING_TIMEOUT_SECONDS
    && seconds <= MAX_EMBEDDING_TIMEOUT_SECONDS ? seconds : null;
}
