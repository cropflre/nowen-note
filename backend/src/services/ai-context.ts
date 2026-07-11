export interface NoteContentLike {
  content?: string | null;
  contentText?: string | null;
  contentFormat?: string | null;
}

export interface ContextSegment {
  label: "full" | "head" | "middle" | "tail";
  start: number;
  end: number;
}

export interface BudgetedContext {
  text: string;
  originalChars: number;
  includedChars: number;
  omittedChars: number;
  truncated: boolean;
  strategy: "full" | "head-middle-tail";
  segments: ContextSegment[];
}

const BLOCK_TAGS = /<\/?(?:address|article|aside|blockquote|br|div|dl|dt|dd|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|tbody|td|tfoot|th|thead|tr|ul)[^>]*>/gi;

function decodeEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  };
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (_m, entity: string) => {
    if (entity[0] === "#") {
      const hex = entity[1]?.toLowerCase() === "x";
      const raw = entity.slice(hex ? 2 : 1);
      const code = Number.parseInt(raw, hex ? 16 : 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        try { return String.fromCodePoint(code); } catch { return ""; }
      }
      return "";
    }
    return named[entity.toLowerCase()] ?? "";
  });
}

function normalizeLines(value: string): string {
  return value
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\t\f\v]+/g, " ")
    .replace(/[ \u00a0]+\n/g, "\n")
    .replace(/\n[ \u00a0]+/g, "\n")
    .replace(/[ \u00a0]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function htmlToPlainText(html: string): string {
  return normalizeLines(decodeEntities(
    html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, "")
      .replace(BLOCK_TAGS, "\n")
      .replace(/<[^>]+>/g, " "),
  ));
}

function markdownToPlainText(markdown: string): string {
  return normalizeLines(decodeEntities(
    markdown
      .replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, "")
      .replace(/```[^\n]*\n([\s\S]*?)```/g, "$1")
      .replace(/~~~[^\n]*\n([\s\S]*?)~~~/g, "$1")
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/^\s{0,3}#{1,6}\s+/gm, "")
      .replace(/^\s*>\s?/gm, "")
      .replace(/^\s*[-+*]\s+/gm, "• ")
      .replace(/^\s*\d+[.)]\s+/gm, "")
      .replace(/(\*\*|__|~~|`)/g, "")
      .replace(BLOCK_TAGS, "\n")
      .replace(/<[^>]+>/g, " "),
  ));
}

function tiptapNodeText(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const item = node as { type?: string; text?: string; content?: unknown[]; attrs?: Record<string, unknown> };
  if (item.type === "text") return typeof item.text === "string" ? item.text : "";
  if (item.type === "hardBreak") return "\n";
  if (item.type === "image") return typeof item.attrs?.alt === "string" ? `[图片：${item.attrs.alt}]` : "[图片]";

  const children = Array.isArray(item.content) ? item.content.map(tiptapNodeText).join("") : "";
  const block = new Set([
    "doc", "paragraph", "heading", "blockquote", "codeBlock", "bulletList", "orderedList",
    "listItem", "taskList", "taskItem", "table", "tableRow",
  ]);
  if (item.type === "tableCell" || item.type === "tableHeader") return `${children}\t`;
  return block.has(item.type || "") ? `${children}\n` : children;
}

function tiptapToPlainText(content: string): string {
  try {
    return normalizeLines(tiptapNodeText(JSON.parse(content)));
  } catch {
    return "";
  }
}

/**
 * Convert every note representation to one stable plain-text form. The richer of
 * parsed content and contentText wins so stale preview text cannot silently hide
 * tables, code blocks, or the tail of the document.
 */
export function noteToPlainText(note: NoteContentLike): string {
  const content = typeof note.content === "string" ? note.content : "";
  const fallback = normalizeLines(typeof note.contentText === "string" ? note.contentText : "");
  const format = String(note.contentFormat || "").toLowerCase();

  let parsed = "";
  if (format === "markdown") parsed = markdownToPlainText(content);
  else if (format === "html") parsed = htmlToPlainText(content);
  else if (format === "tiptap-json" || content.trim().startsWith("{")) parsed = tiptapToPlainText(content);
  if (!parsed && /<\w+[\s>]/.test(content)) parsed = htmlToPlainText(content);
  if (!parsed) parsed = markdownToPlainText(content);

  return parsed.length >= fallback.length ? parsed : fallback;
}

export function normalizeExternalText(value: string): string {
  if (!value) return "";
  if (/^\s*[<{]/.test(value)) {
    const tiptap = tiptapToPlainText(value);
    if (tiptap) return tiptap;
  }
  return /<\w+[\s>]/.test(value) ? htmlToPlainText(value) : markdownToPlainText(value);
}

/**
 * Preserve the beginning, middle and end of oversized documents. This makes the
 * omission deterministic and visible instead of silently taking only a prefix.
 */
export function fitContextBudget(raw: string, budget = 48_000): BudgetedContext {
  const text = normalizeLines(raw);
  const safeBudget = Math.max(2_000, Math.floor(budget));
  if (text.length <= safeBudget) {
    return {
      text,
      originalChars: text.length,
      includedChars: text.length,
      omittedChars: 0,
      truncated: false,
      strategy: "full",
      segments: [{ label: "full", start: 0, end: text.length }],
    };
  }

  const markerBudget = 180;
  const available = Math.max(1_500, safeBudget - markerBudget);
  const headLen = Math.floor(available * 0.4);
  const middleLen = Math.floor(available * 0.2);
  const tailLen = available - headLen - middleLen;
  const middleStart = Math.max(headLen, Math.floor((text.length - middleLen) / 2));
  const tailStart = Math.max(middleStart + middleLen, text.length - tailLen);
  const head = text.slice(0, headLen);
  const middle = text.slice(middleStart, middleStart + middleLen);
  const tail = text.slice(tailStart);
  const joined = [
    "【正文开头】\n" + head,
    `【中间省略，保留正文中部；原文共 ${text.length} 字】\n` + middle,
    "【正文结尾】\n" + tail,
  ].join("\n\n");

  return {
    text: joined,
    originalChars: text.length,
    includedChars: head.length + middle.length + tail.length,
    omittedChars: Math.max(0, text.length - head.length - middle.length - tail.length),
    truncated: true,
    strategy: "head-middle-tail",
    segments: [
      { label: "head", start: 0, end: headLen },
      { label: "middle", start: middleStart, end: middleStart + middleLen },
      { label: "tail", start: tailStart, end: text.length },
    ],
  };
}

export function safeContextPreview(value: string, limit = 180): string {
  const text = normalizeLines(value).replace(/\n+/g, " ");
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
