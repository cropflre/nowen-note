export type RemoteImageReferenceKind = "remote" | "local" | "ignored";

export interface RemoteImageReference {
  url: string;
  kind: RemoteImageReferenceKind;
}

export interface RemoteImageScanResult {
  contentFormat: string;
  totalImageReferences: number;
  remoteReferenceCount: number;
  localReferenceCount: number;
  ignoredReferenceCount: number;
  remoteUrls: string[];
  parseError?: string;
}

export interface RemoteImageReplacementResult {
  content: string;
  replacedCount: number;
  changed: boolean;
  parseError?: string;
}

const LOCAL_ATTACHMENT_PATHS = ["/api/attachments/", "/api/files/"];
const MARKDOWN_IMAGE_RE = /!\[[^\]]*\]\(\s*(<[^>\n]+>|(?:\\.|[^)\s])+)(\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;
const HTML_IMAGE_TAG_RE = /<img\b[^>]*>/gi;
const HTML_SRC_RE = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;

export function classifyImageUrl(rawUrl: unknown): RemoteImageReferenceKind {
  if (typeof rawUrl !== "string") return "ignored";
  const value = rawUrl.trim();
  if (!value) return "ignored";
  const lower = value.toLowerCase();
  if (LOCAL_ATTACHMENT_PATHS.some((prefix) => lower.startsWith(prefix))) return "local";
  if (lower.startsWith("data:") || lower.startsWith("blob:") || lower.startsWith("file:")) return "ignored";
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? "remote" : "ignored";
  } catch {
    return "ignored";
  }
}

function markdownReferences(content: string): RemoteImageReference[] {
  const references: RemoteImageReference[] = [];
  for (const match of content.matchAll(MARKDOWN_IMAGE_RE)) {
    const token = match[1] || "";
    const url = token.startsWith("<") && token.endsWith(">") ? token.slice(1, -1).trim() : token.trim();
    references.push({ url, kind: classifyImageUrl(url) });
  }
  return references;
}

function htmlReferences(content: string): RemoteImageReference[] {
  const references: RemoteImageReference[] = [];
  for (const match of content.matchAll(HTML_IMAGE_TAG_RE)) {
    const srcMatch = match[0].match(HTML_SRC_RE);
    const url = (srcMatch?.[1] ?? srcMatch?.[2] ?? srcMatch?.[3] ?? "").trim();
    if (url) references.push({ url, kind: classifyImageUrl(url) });
  }
  return references;
}

type TiptapNode = { type?: string; attrs?: Record<string, unknown>; content?: unknown[] };
function isImageNode(value: unknown): value is TiptapNode {
  if (!value || typeof value !== "object") return false;
  const node = value as TiptapNode;
  return /image/i.test(String(node.type || "")) && Boolean(node.attrs && "src" in node.attrs);
}
function walkTiptapImages(value: unknown, visitor: (node: TiptapNode) => void): void {
  if (!value || typeof value !== "object") return;
  const node = value as TiptapNode;
  if (isImageNode(node)) visitor(node);
  if (Array.isArray(node.content)) for (const child of node.content) walkTiptapImages(child, visitor);
}
function tiptapReferences(content: string): { references: RemoteImageReference[]; parseError?: string } {
  try {
    const parsed = JSON.parse(content || "{}");
    const references: RemoteImageReference[] = [];
    walkTiptapImages(parsed, (node) => {
      const url = typeof node.attrs?.src === "string" ? node.attrs.src.trim() : "";
      if (url) references.push({ url, kind: classifyImageUrl(url) });
    });
    return { references };
  } catch (error) {
    return { references: [], parseError: `Tiptap JSON 解析失败：${error instanceof Error ? error.message : String(error)}` };
  }
}

function detectContentKind(content: string, contentFormat: string): "markdown" | "html" | "tiptap-json" {
  const normalized = String(contentFormat || "").toLowerCase();
  if (normalized === "markdown" || normalized === "md") return "markdown";
  if (normalized === "html" || normalized === "richtext" || normalized === "rich-text") return "html";
  if (normalized === "tiptap-json" || normalized === "tiptap" || normalized === "json") return "tiptap-json";
  const trimmed = content.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return "tiptap-json";
  return /<img\b/i.test(content) ? "html" : "markdown";
}

export function scanRemoteImages(content: string, contentFormat: string): RemoteImageScanResult {
  const kind = detectContentKind(content || "", contentFormat);
  const parsed = kind === "markdown"
    ? { references: markdownReferences(content || "") }
    : kind === "html"
      ? { references: htmlReferences(content || "") }
      : tiptapReferences(content || "");
  const remote = parsed.references.filter((item) => item.kind === "remote");
  const local = parsed.references.filter((item) => item.kind === "local");
  const ignored = parsed.references.filter((item) => item.kind === "ignored");
  return {
    contentFormat: kind,
    totalImageReferences: parsed.references.length,
    remoteReferenceCount: remote.length,
    localReferenceCount: local.length,
    ignoredReferenceCount: ignored.length,
    remoteUrls: [...new Set(remote.map((item) => item.url))],
    ...(parsed.parseError ? { parseError: parsed.parseError } : {}),
  };
}

function replaceMarkdown(content: string, replacements: ReadonlyMap<string, string>): RemoteImageReplacementResult {
  let replacedCount = 0;
  const output = content.replace(MARKDOWN_IMAGE_RE, (fullMatch, destinationToken: string) => {
    const wrapped = destinationToken.startsWith("<") && destinationToken.endsWith(">");
    const originalUrl = wrapped ? destinationToken.slice(1, -1).trim() : destinationToken.trim();
    const localUrl = replacements.get(originalUrl);
    if (!localUrl || localUrl === originalUrl) return fullMatch;
    const offset = fullMatch.indexOf(destinationToken);
    if (offset < 0) return fullMatch;
    replacedCount += 1;
    const next = wrapped ? `<${localUrl}>` : localUrl;
    return fullMatch.slice(0, offset) + next + fullMatch.slice(offset + destinationToken.length);
  });
  return { content: output, replacedCount, changed: replacedCount > 0 };
}
function replaceHtml(content: string, replacements: ReadonlyMap<string, string>): RemoteImageReplacementResult {
  let replacedCount = 0;
  const output = content.replace(HTML_IMAGE_TAG_RE, (tag) => {
    const srcMatch = tag.match(HTML_SRC_RE);
    const original = (srcMatch?.[1] ?? srcMatch?.[2] ?? srcMatch?.[3] ?? "").trim();
    const local = replacements.get(original);
    if (!srcMatch || !original || !local || local === original || srcMatch.index === undefined) return tag;
    const raw = srcMatch[1] ?? srcMatch[2] ?? srcMatch[3] ?? "";
    const valueOffset = srcMatch[0].indexOf(raw);
    if (valueOffset < 0) return tag;
    replacedCount += 1;
    const absolute = srcMatch.index + valueOffset;
    return tag.slice(0, absolute) + local + tag.slice(absolute + raw.length);
  });
  return { content: output, replacedCount, changed: replacedCount > 0 };
}
function replaceTiptap(content: string, replacements: ReadonlyMap<string, string>): RemoteImageReplacementResult {
  try {
    const parsed = JSON.parse(content || "{}");
    let replacedCount = 0;
    walkTiptapImages(parsed, (node) => {
      const original = typeof node.attrs?.src === "string" ? node.attrs.src.trim() : "";
      const local = replacements.get(original);
      if (!original || !local || local === original || !node.attrs) return;
      node.attrs.src = local;
      replacedCount += 1;
    });
    return { content: replacedCount ? JSON.stringify(parsed) : content, replacedCount, changed: replacedCount > 0 };
  } catch (error) {
    return { content, replacedCount: 0, changed: false, parseError: `Tiptap JSON 解析失败：${error instanceof Error ? error.message : String(error)}` };
  }
}
export function replaceRemoteImages(content: string, contentFormat: string, replacements: ReadonlyMap<string, string>): RemoteImageReplacementResult {
  if (!replacements.size) return { content, replacedCount: 0, changed: false };
  const kind = detectContentKind(content || "", contentFormat);
  return kind === "markdown" ? replaceMarkdown(content || "", replacements)
    : kind === "html" ? replaceHtml(content || "", replacements)
      : replaceTiptap(content || "", replacements);
}
