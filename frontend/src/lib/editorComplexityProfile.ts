export type EditorContentFormat = "markdown" | "tiptap-json" | "html" | string;

export interface EditorComplexityProfile {
  contentFormat: EditorContentFormat;
  bytes: number;
  characters: number;
  lines: number;
  longestLine: number;
  topLevelBlocks: number;
  approximateNodes: number;
  imageCount: number;
  attachmentCount: number;
  embedCount: number;
  tableCount: number;
  codeBlockCount: number;
  countsCapped: boolean;
}

const MAX_STRUCTURAL_MATCHES = 100_000;

const TIPTAP_BLOCK_TYPES = new Set([
  "paragraph",
  "heading",
  "blockquote",
  "bulletList",
  "orderedList",
  "taskList",
  "codeBlock",
  "horizontalRule",
  "table",
  "image",
  "video",
  "attachment",
  "blockEmbed",
  "mermaid",
]);

const TIPTAP_IMAGE_TYPES = new Set(["image", "resizableImage"]);
const TIPTAP_ATTACHMENT_TYPES = new Set(["attachment", "file", "fileAttachment"]);
const TIPTAP_EMBED_TYPES = new Set([
  "video",
  "iframe",
  "youtube",
  "blockEmbed",
  "mermaid",
  "mathBlock",
  "diagram",
]);

export function normalizeEditorContentFormat(value: string | null | undefined): EditorContentFormat {
  const normalized = (value || "tiptap-json").trim().toLowerCase();
  if (normalized === "md" || normalized === "markdown") return "markdown";
  if (normalized === "json" || normalized === "tiptap" || normalized === "tiptap-json") {
    return "tiptap-json";
  }
  if (normalized === "htm" || normalized === "html") return "html";
  return normalized || "tiptap-json";
}

export function utf8ByteLength(value: string): number {
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(value).byteLength;

  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else bytes += 3;
  }
  return bytes;
}

export function formatEditorByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kilobytes = bytes / 1024;
  if (kilobytes < 1024) return `${kilobytes.toFixed(1)} KB`;
  return `${(kilobytes / 1024).toFixed(1)} MB`;
}

function scanLines(content: string): Pick<EditorComplexityProfile, "lines" | "longestLine"> {
  let lines = 1;
  let currentLine = 0;
  let longestLine = 0;

  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) === 10) {
      lines += 1;
      if (currentLine > longestLine) longestLine = currentLine;
      currentLine = 0;
    } else {
      currentLine += 1;
    }
  }
  if (currentLine > longestLine) longestLine = currentLine;
  return { lines, longestLine };
}

function countMatches(content: string, pattern: RegExp, limit = MAX_STRUCTURAL_MATCHES): {
  count: number;
  capped: boolean;
} {
  pattern.lastIndex = 0;
  let count = 0;
  while (pattern.exec(content)) {
    count += 1;
    if (count >= limit) return { count, capped: true };
  }
  return { count, capped: false };
}

function profileTiptap(content: string) {
  const typePattern = /"type"\s*:\s*"([^"]+)"/g;
  let approximateNodes = 0;
  let topLevelBlocks = 0;
  let imageCount = 0;
  let attachmentCount = 0;
  let embedCount = 0;
  let tableCount = 0;
  let codeBlockCount = 0;
  let countsCapped = false;
  let match: RegExpExecArray | null;

  while ((match = typePattern.exec(content)) !== null) {
    approximateNodes += 1;
    const type = match[1];
    if (TIPTAP_BLOCK_TYPES.has(type)) topLevelBlocks += 1;
    if (TIPTAP_IMAGE_TYPES.has(type)) imageCount += 1;
    if (TIPTAP_ATTACHMENT_TYPES.has(type)) attachmentCount += 1;
    if (TIPTAP_EMBED_TYPES.has(type)) embedCount += 1;
    if (type === "table") tableCount += 1;
    if (type === "codeBlock") codeBlockCount += 1;
    if (approximateNodes >= MAX_STRUCTURAL_MATCHES) {
      countsCapped = true;
      break;
    }
  }

  return {
    approximateNodes,
    topLevelBlocks,
    imageCount,
    attachmentCount,
    embedCount,
    tableCount,
    codeBlockCount,
    countsCapped,
  };
}

function profileHtml(content: string) {
  const tagPattern = /<([a-z][\w-]*)\b/gi;
  let approximateNodes = 0;
  let topLevelBlocks = 0;
  let imageCount = 0;
  let attachmentCount = 0;
  let embedCount = 0;
  let tableCount = 0;
  let codeBlockCount = 0;
  let countsCapped = false;
  let match: RegExpExecArray | null;

  while ((match = tagPattern.exec(content)) !== null) {
    approximateNodes += 1;
    const tag = match[1].toLowerCase();
    if (["p", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "ul", "ol", "pre", "table", "figure"].includes(tag)) {
      topLevelBlocks += 1;
    }
    if (tag === "img" || tag === "picture") imageCount += 1;
    if (tag === "a") {
      const nearby = content.slice(match.index, Math.min(content.length, match.index + 256));
      if (/api\/attachments\//i.test(nearby) || /\bdownload\b/i.test(nearby)) attachmentCount += 1;
    }
    if (["iframe", "video", "audio", "object", "embed"].includes(tag)) embedCount += 1;
    if (tag === "table") tableCount += 1;
    if (tag === "pre" || tag === "code") codeBlockCount += 1;
    if (approximateNodes >= MAX_STRUCTURAL_MATCHES) {
      countsCapped = true;
      break;
    }
  }

  return {
    approximateNodes,
    topLevelBlocks,
    imageCount,
    attachmentCount,
    embedCount,
    tableCount,
    codeBlockCount,
    countsCapped,
  };
}

function profileMarkdown(content: string, lines: number) {
  const image = countMatches(content, /!\[[^\]]*\]\([^\n)]*\)/g);
  const attachment = countMatches(content, /\[[^\]]+\]\([^\n)]*(?:api\/attachments\/|attachment:)[^\n)]*\)/gi);
  const embed = countMatches(content, /<(?:iframe|video|audio|object|embed)\b/gi);
  const fence = countMatches(content, /^\s*```/gm);
  const table = countMatches(content, /^\s*\|.*\|\s*$/gm);
  const nonEmpty = countMatches(content, /^\s*\S.*$/gm);

  return {
    approximateNodes: Math.max(1, lines),
    topLevelBlocks: nonEmpty.count,
    imageCount: image.count,
    attachmentCount: attachment.count,
    embedCount: embed.count,
    tableCount: Math.floor(table.count / 2),
    codeBlockCount: Math.ceil(fence.count / 2),
    countsCapped: image.capped || attachment.capped || embed.capped || fence.capped || table.capped || nonEmpty.capped,
  };
}

export function buildEditorComplexityProfile(
  content: string | null | undefined,
  contentFormat: string | null | undefined,
): EditorComplexityProfile {
  const source = content || "";
  const normalizedFormat = normalizeEditorContentFormat(contentFormat);
  const lineMetrics = scanLines(source);
  const structural = normalizedFormat === "markdown"
    ? profileMarkdown(source, lineMetrics.lines)
    : normalizedFormat === "html"
      ? profileHtml(source)
      : profileTiptap(source);

  return {
    contentFormat: normalizedFormat,
    bytes: utf8ByteLength(source),
    characters: source.length,
    ...lineMetrics,
    ...structural,
  };
}
