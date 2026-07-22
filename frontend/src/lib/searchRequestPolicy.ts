const HAN_TEXT_RE = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/u;
const SIMPLE_TOKEN_RE = /^[\p{L}\p{N}_]+$/u;

/** SearchCenter already waits 180 ms; this raises progressive short input to ~600 ms total. */
export const PROGRESSIVE_SHORT_QUERY_EXTRA_DELAY_MS = 420;

export function normalizeProgressiveSearchQuery(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase();
}

/**
 * SQLite FTS5 trigram cannot index 1-2 character Latin/number fragments. Sending those
 * fragments while a user is still typing forces the backend onto its synchronous literal
 * body fallback and can block the final indexed query on low-power NAS hardware.
 *
 * Han queries keep their existing behavior because one/two-character Chinese search is a
 * common intentional operation. Punctuation-bearing terms such as C++ are also preserved.
 */
export function isIncrementalShortLatinQuery(value: string): boolean {
  const normalized = normalizeProgressiveSearchQuery(value);
  return normalized.length > 0
    && normalized.length < 3
    && !HAN_TEXT_RE.test(normalized)
    && SIMPLE_TOKEN_RE.test(normalized);
}

export function getProgressiveSearchExtraDelayMs(value: string): number {
  return isIncrementalShortLatinQuery(value)
    ? PROGRESSIVE_SHORT_QUERY_EXTRA_DELAY_MS
    : 0;
}
