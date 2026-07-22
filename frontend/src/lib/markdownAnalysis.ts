import type { NoteEditorHeading } from "@/components/editors/types";

export const MARKDOWN_ANALYSIS_SEARCH_TEXT_LIMIT = 1_000_000;
export const MARKDOWN_ANALYSIS_OUTLINE_LIMIT = 400;

export interface MarkdownAnalysisStats {
  chars: number;
  charsNoSpace: number;
  words: number;
}

export interface MarkdownAnalysisResult {
  sourceCharacters: number;
  plainText: string;
  headings: NoteEditorHeading[];
  stats: MarkdownAnalysisStats;
}

function boundSearchText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const headLength = Math.floor(limit * 0.8);
  const tailLength = Math.max(0, limit - headLength);
  return `${text.slice(0, headLength)}\n\n…\n\n${text.slice(-tailLength)}`;
}

function stripInlineMarkdown(line: string): string {
  return line
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/^\s{0,3}#{1,6}\s+/, "")
    .replace(/^\s{0,3}>\s?/, "")
    .replace(/^\s*[-+*]\s+\[[ xX]\]\s+/, "")
    .replace(/^\s*(?:[-+*]|\d+[.)])\s+/, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1")
    .replace(/<((?:https?:\/\/|mailto:)[^>]+)>/gi, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/^[=-]{3,}\s*$/, "")
    .replace(/[*_~`]/g, "")
    .replace(/\\([\\`*{}\[\]()#+\-.!_>])/g, "$1")
    .trimEnd();
}

/**
 * Parser-free Markdown analysis designed for a Web Worker.
 *
 * It intentionally avoids importing the full Tiptap/Turndown conversion stack. The result is a
 * search-friendly plain-text approximation, bounded outline data and word statistics. Source text
 * never leaves the browser and no document content is logged.
 */
export function analyzeMarkdown(
  markdown: string,
  options: {
    searchTextLimit?: number;
    outlineLimit?: number;
  } = {},
): MarkdownAnalysisResult {
  const searchTextLimit = options.searchTextLimit ?? MARKDOWN_ANALYSIS_SEARCH_TEXT_LIMIT;
  const outlineLimit = options.outlineLimit ?? MARKDOWN_ANALYSIS_OUTLINE_LIMIT;
  const headings: NoteEditorHeading[] = [];
  const plainLines: string[] = [];

  let lineStart = 0;
  let inFence = false;
  let previousLine: { raw: string; start: number } | null = null;

  for (let index = 0; index <= markdown.length; index += 1) {
    if (index < markdown.length && markdown.charCodeAt(index) !== 10) continue;

    const rawLine = markdown.slice(lineStart, index).replace(/\r$/, "");
    const fence = /^\s{0,3}(```+|~~~+)/.exec(rawLine);
    if (fence) {
      inFence = !inFence;
      plainLines.push("");
      previousLine = { raw: rawLine, start: lineStart };
      lineStart = index + 1;
      continue;
    }

    if (!inFence && headings.length < outlineLimit) {
      const atx = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(rawLine);
      if (atx) {
        const text = stripInlineMarkdown(atx[2]).trim();
        if (text) {
          headings.push({
            id: `large-md-h-${lineStart}`,
            level: atx[1].length,
            text,
            pos: lineStart,
          });
        }
      } else if (previousLine) {
        const setext = /^\s*(=+|-+)\s*$/.exec(rawLine);
        const text = stripInlineMarkdown(previousLine.raw).trim();
        if (setext && text && !/^\s*[-*_]{3,}\s*$/.test(previousLine.raw)) {
          headings.push({
            id: `large-md-h-${previousLine.start}`,
            level: setext[1][0] === "=" ? 1 : 2,
            text,
            pos: previousLine.start,
          });
        }
      }
    }

    plainLines.push(inFence ? rawLine : stripInlineMarkdown(rawLine));
    previousLine = { raw: rawLine, start: lineStart };
    lineStart = index + 1;
  }

  const fullPlainText = plainLines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  const chars = fullPlainText.length;
  const charsNoSpace = fullPlainText.replace(/\s+/g, "").length;
  const englishWords = (fullPlainText.match(/[A-Za-z0-9_']+/g) || []).length;
  const cjkChars = (fullPlainText.match(/[\u3400-\u4dbf\u4e00-\u9fff]/g) || []).length;

  return {
    sourceCharacters: markdown.length,
    plainText: boundSearchText(fullPlainText, searchTextLimit),
    headings: headings.slice(0, outlineLimit),
    stats: {
      chars,
      charsNoSpace,
      words: englishWords + cjkChars,
    },
  };
}
