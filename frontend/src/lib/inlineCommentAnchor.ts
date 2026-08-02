export type InlineCommentEditor = "tiptap" | "markdown";

export interface TextCommentAnchor {
  version: 1;
  kind: "text";
  editor: InlineCommentEditor;
  quote: string;
  prefix: string;
  suffix: string;
  start: number;
  end: number;
  createdAt: number;
}

export interface ResolvedTextCommentAnchor {
  start: number;
  end: number;
  exact: boolean;
}

const CONTEXT_LENGTH = 32;
const MAX_QUOTE_LENGTH = 1200;

export function buildTextCommentAnchor(input: {
  editor: InlineCommentEditor;
  documentText: string;
  start: number;
  end: number;
}): TextCommentAnchor | null {
  const documentText = input.documentText || "";
  let start = Math.max(0, Math.min(documentText.length, Math.trunc(input.start)));
  let end = Math.max(start, Math.min(documentText.length, Math.trunc(input.end)));
  const raw = documentText.slice(start, end);
  if (!raw) return null;

  const leading = raw.match(/^\s*/)?.[0].length || 0;
  const trailing = raw.match(/\s*$/)?.[0].length || 0;
  start += leading;
  end -= trailing;
  if (end <= start) return null;

  const quote = documentText.slice(start, end);
  if (!quote.trim()) return null;

  return {
    version: 1,
    kind: "text",
    editor: input.editor,
    quote: quote.slice(0, MAX_QUOTE_LENGTH),
    prefix: documentText.slice(Math.max(0, start - CONTEXT_LENGTH), start),
    suffix: documentText.slice(end, Math.min(documentText.length, end + CONTEXT_LENGTH)),
    start,
    end,
    createdAt: Date.now(),
  };
}

export function parseTextCommentAnchor(value: unknown): TextCommentAnchor | null {
  if (!value) return null;
  let raw: unknown = value;
  if (typeof value === "string") {
    try {
      raw = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!raw || typeof raw !== "object") return null;
  const data = raw as Partial<TextCommentAnchor>;
  if (data.kind !== "text" || data.version !== 1) return null;
  if (data.editor !== "tiptap" && data.editor !== "markdown") return null;
  if (typeof data.quote !== "string" || !data.quote.trim()) return null;
  if (!Number.isFinite(data.start) || !Number.isFinite(data.end)) return null;
  return {
    version: 1,
    kind: "text",
    editor: data.editor,
    quote: data.quote.slice(0, MAX_QUOTE_LENGTH),
    prefix: typeof data.prefix === "string" ? data.prefix.slice(-CONTEXT_LENGTH) : "",
    suffix: typeof data.suffix === "string" ? data.suffix.slice(0, CONTEXT_LENGTH) : "",
    start: Math.max(0, Math.trunc(data.start as number)),
    end: Math.max(0, Math.trunc(data.end as number)),
    createdAt: Number.isFinite(data.createdAt) ? Math.trunc(data.createdAt as number) : 0,
  };
}

function matchingSuffixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let count = 0;
  for (let i = 1; i <= limit; i += 1) {
    if (left[left.length - i] !== right[right.length - i]) break;
    count += 1;
  }
  return count;
}

function matchingPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let count = 0;
  for (let i = 0; i < limit; i += 1) {
    if (left[i] !== right[i]) break;
    count += 1;
  }
  return count;
}

export function resolveTextCommentAnchor(
  documentText: string,
  anchor: TextCommentAnchor,
): ResolvedTextCommentAnchor | null {
  const text = documentText || "";
  if (!anchor.quote || !text) return null;

  const expectedStart = Math.max(0, Math.min(text.length, anchor.start));
  const expectedEnd = expectedStart + anchor.quote.length;
  if (expectedEnd <= text.length && text.slice(expectedStart, expectedEnd) === anchor.quote) {
    return { start: expectedStart, end: expectedEnd, exact: true };
  }

  const candidates: Array<{ start: number; score: number }> = [];
  let cursor = 0;
  while (cursor <= text.length - anchor.quote.length) {
    const found = text.indexOf(anchor.quote, cursor);
    if (found === -1) break;
    const before = text.slice(Math.max(0, found - CONTEXT_LENGTH), found);
    const after = text.slice(found + anchor.quote.length, found + anchor.quote.length + CONTEXT_LENGTH);
    const prefixScore = matchingSuffixLength(before, anchor.prefix);
    const suffixScore = matchingPrefixLength(after, anchor.suffix);
    const distancePenalty = Math.min(Math.abs(found - anchor.start), 10_000) / 10_000;
    candidates.push({ start: found, score: prefixScore * 3 + suffixScore * 3 - distancePenalty });
    cursor = found + Math.max(1, anchor.quote.length);
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.score - a.score || Math.abs(a.start - anchor.start) - Math.abs(b.start - anchor.start));
  const best = candidates[0];
  return {
    start: best.start,
    end: best.start + anchor.quote.length,
    exact: false,
  };
}

export function serializeTextCommentAnchor(anchor: TextCommentAnchor): string {
  return JSON.stringify(anchor);
}

export function compactAnchorQuote(anchor: TextCommentAnchor, maxLength = 100): string {
  const normalized = anchor.quote.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}…` : normalized;
}
