import type { NoteEditorHeading } from "@/components/editors/types";
import {
  EDITOR_RUNTIME_THRESHOLDS,
  resolveEditorRuntimeDecision,
} from "@/lib/editorRuntimePolicy";

/**
 * The full Markdown editor enables live preview, embedded language highlighting and several
 * whole-document transforms. Medium/large documents are routed to the dedicated CodeMirror
 * viewport editor; only the most expensive tier disables Markdown parsing/highlighting entirely.
 */
export const LARGE_MARKDOWN_THRESHOLDS = {
  characters: EDITOR_RUNTIME_THRESHOLDS.markdown.lightweight.characters,
  lines: EDITOR_RUNTIME_THRESHOLDS.markdown.lightweight.lines,
  longestLine: EDITOR_RUNTIME_THRESHOLDS.markdown.lightweight.longestLine,
} as const;

export const LARGE_MARKDOWN_SEARCH_TEXT_LIMIT = 1_000_000;
export const LARGE_MARKDOWN_OUTLINE_LIMIT = 400;

export function shouldUseLargeMarkdownSafeMode(
  content: string | null | undefined,
): boolean {
  if (!content) return false;
  return resolveEditorRuntimeDecision({
    content,
    contentFormat: "markdown",
  }).mode === "lightweight-edit";
}

/** Route both viewport-optimized and lightweight Markdown through the worker-backed editor. */
export function shouldUseLargeMarkdownOptimizedMode(
  content: string | null | undefined,
): boolean {
  if (!content) return false;
  const mode = resolveEditorRuntimeDecision({
    content,
    contentFormat: "markdown",
  }).mode;
  return mode === "viewport-optimized" || mode === "lightweight-edit";
}

/**
 * A bounded, parser-free search representation used only when the background analysis has not
 * completed before an explicit save/snapshot. The Worker-generated plain text is preferred.
 */
export function buildLargeMarkdownSearchText(
  markdown: string,
  limit = LARGE_MARKDOWN_SEARCH_TEXT_LIMIT,
): string {
  if (markdown.length <= limit) return markdown.replace(/[\u200B-\u200D\uFEFF]/g, "");

  const headLength = Math.floor(limit * 0.8);
  const tailLength = Math.max(0, limit - headLength);
  return `${markdown.slice(0, headLength)}\n\n…\n\n${markdown.slice(-tailLength)}`
    .replace(/[\u200B-\u200D\uFEFF]/g, "");
}

/**
 * Parser-free synchronous outline fallback retained for tests and non-Worker environments.
 */
export function extractLargeMarkdownHeadings(
  markdown: string,
  limit = LARGE_MARKDOWN_OUTLINE_LIMIT,
): NoteEditorHeading[] {
  const headings: NoteEditorHeading[] = [];
  let lineStart = 0;

  for (let index = 0; index <= markdown.length; index += 1) {
    if (index < markdown.length && markdown.charCodeAt(index) !== 10) continue;

    const line = markdown.slice(lineStart, index);
    const match = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (match) {
      const text = match[2].trim();
      if (text) {
        headings.push({
          id: `large-md-h-${lineStart}`,
          level: match[1].length,
          text,
          pos: lineStart,
        });
        if (headings.length >= limit) break;
      }
    }

    lineStart = index + 1;
  }

  return headings;
}

export interface SingleTextChange {
  from: number;
  deleteCount: number;
  insert: string;
}

/**
 * Compute one compact replacement range so a one-character edit does not replace/broadcast the
 * entire multi-megabyte Y.Text document.
 *
 * Repeated characters can produce several equally small ranges. Canonicalize pure insertions and
 * deletions to the earliest valid position so local and remote runtimes derive the same operation.
 */
export function computeSingleTextChange(
  previous: string,
  next: string,
): SingleTextChange | null {
  if (previous === next) return null;

  const sharedLength = Math.min(previous.length, next.length);
  let from = 0;
  while (from < sharedLength && previous.charCodeAt(from) === next.charCodeAt(from)) {
    from += 1;
  }

  let previousEnd = previous.length;
  let nextEnd = next.length;
  while (
    previousEnd > from
    && nextEnd > from
    && previous.charCodeAt(previousEnd - 1) === next.charCodeAt(nextEnd - 1)
  ) {
    previousEnd -= 1;
    nextEnd -= 1;
  }

  const deleteCount = previousEnd - from;
  let insert = next.slice(from, nextEnd);

  if (deleteCount === 0 && insert.length > 0) {
    while (
      from > 0
      && insert.charCodeAt(insert.length - 1) === previous.charCodeAt(from - 1)
    ) {
      insert = `${previous[from - 1]}${insert.slice(0, -1)}`;
      from -= 1;
    }
  } else if (insert.length === 0 && deleteCount > 0) {
    let deleted = previous.slice(from, previousEnd);
    while (
      from > 0
      && deleted.charCodeAt(deleted.length - 1) === next.charCodeAt(from - 1)
    ) {
      deleted = `${next[from - 1]}${deleted.slice(0, -1)}`;
      from -= 1;
    }
  }

  return {
    from,
    deleteCount,
    insert,
  };
}

export function formatLargeMarkdownSize(characters: number): string {
  if (characters < 1024) return `${characters} B`;
  const kilobytes = characters / 1024;
  if (kilobytes < 1024) return `${kilobytes.toFixed(1)} KB`;
  return `${(kilobytes / 1024).toFixed(1)} MB`;
}
