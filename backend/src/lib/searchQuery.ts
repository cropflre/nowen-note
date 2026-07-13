const ZERO_WIDTH_RE = /[\u200B-\u200D\uFEFF]/g;

/**
 * Normalize user-visible text for reliable literal search.
 *
 * NFKC folds full-width latin letters/numbers and compatibility characters,
 * lower-casing makes ASCII/Unicode case differences deterministic, and hidden
 * zero-width characters no longer make an otherwise visible keyword miss.
 */
export function normalizeSearchText(value: string): string {
  return (value || "")
    .normalize("NFKC")
    .replace(ZERO_WIDTH_RE, "")
    .toLocaleLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Split a query into literal AND terms while keeping punctuation attached.
 * Keeping `c++`, `foo-bar` and version strings intact prevents the tokenizer
 * from broadening them into unrelated single-letter/token matches.
 */
export function splitSearchTerms(query: string): string[] {
  const normalized = normalizeSearchText(query);
  return Array.from(new Set(normalized.match(/[\p{Script=Han}]+|[^\s\p{Script=Han}]+/gu) || []));
}

export function hasHanText(query: string): boolean {
  return /\p{Script=Han}/u.test(normalizeSearchText(query));
}

/** Build a conservative FTS5 query used only for candidate ranking. */
export function buildFtsSearchTerm(query: string): string {
  const tokens = normalizeSearchText(query).match(/[\p{L}\p{N}_]+/gu) || [];
  return Array.from(new Set(tokens))
    .map((term) => `"${term.replace(/"/g, '""')}"*`)
    .join(" AND ");
}

export function countSearchTermOccurrences(source: string, term: string): number {
  const haystack = normalizeSearchText(source);
  const needle = normalizeSearchText(term);
  if (!haystack || !needle) return 0;

  let count = 0;
  let from = 0;
  while (from < haystack.length) {
    const index = haystack.indexOf(needle, from);
    if (index < 0) break;
    count += 1;
    from = index + Math.max(needle.length, 1);
  }
  return count;
}

export function containsAllSearchTerms(source: string, terms: string[]): boolean {
  const normalized = normalizeSearchText(source);
  return terms.length > 0 && terms.every((term) => normalized.includes(normalizeSearchText(term)));
}
