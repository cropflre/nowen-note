import { parseServerTime } from "@/lib/dateTime";

/**
 * Normalize backend comment timestamps to an explicit UTC ISO string.
 *
 * SQLite stores `datetime('now')` as a timezone-less UTC value. Keeping the
 * normalization at the API/runtime boundary means every consumer can safely
 * use the native Date constructor without re-implementing SQLite semantics.
 * Invalid timestamps are preserved instead of being replaced with the current
 * time, so corrupted historical data is never presented as a new comment.
 */
export function normalizeShareCommentTimestamp<T extends { createdAt: string }>(comment: T): T {
  const parsed = parseServerTime(comment.createdAt);
  if (!parsed) return comment;

  const createdAt = parsed.toISOString();
  return createdAt === comment.createdAt
    ? comment
    : { ...comment, createdAt };
}
