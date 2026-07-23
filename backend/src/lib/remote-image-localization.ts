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
  if (LOCAL_ATTACHMENT_PATHS.some((path) => lower.includes(path))) return "local";
  if (lower.startsWith("data:") || lower.startsWith("blob:") || lower.startsWith("file:")) {
    return "ignored";
  }

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
    const url = token.startsWith("<") && token.endsWith(">")
      ? token.slice(1, -1).trim()
      : token.trim();
    references.push({ url, kind: classifyImageUrl(url) });
  }
  return references;
}

function htmlReferences(content: string): RemoteImageReference[] {
  const references: RemoteImageReference[] = [];
  for (const match of content.matchAll(HTML_IMAGE_TAG_RE)) {
    const srcMatch = match[0].match(HTML_SRC_RE);
    const url = (srcMatch?.[1] ?? srcMatch?.[2] ?? srcMatch?.[3] ?? "").trim();
    if (!url) continue;
    references.push({ url, kind: classifyImageUrl(url) });
  }
  return references;
}

function isImageNode(node: unknown): node is { type?: string; attrs?: Record<string, unknown>; content?: unknown[] } {
  if (!node || typeof node !== "object") return false;
  const type = String((node as { type?: unknown }).type || "");
  const attrs = (node as { attrs?: unknown }).attrs;
  return /image/i.test(type) && Boolean(attrs && typeof attrs === "object" && "src" in (attrs as object));
}

function walkTiptapImages(
  value: unknown,
  visitor: (node: { type?: string; attrs?: Record<string, unknown>; content?: unknown[] }) => void,
): void {
  if (!value || typeof value !== "object") return;
  const node = value as { type?: string; attrs?: Record<string, unknown>; content?: unknown[] };
  if (isImageNode(node)) visitor(node);
  if (Array.isArray(node.content)) {
    for (const child of node.content) walkTiptapImages(child, visitor);
  }
}

function tiptapReferences(content: string): { references: RemoteImageReference[]; parseError?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content || "{}");
  } catch (error) {
    return {
      references: [],
      parseError: `Tiptap JSON 解析失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const references: RemoteImageReference[] = [];
  walkTiptapImages(parsed, (node) => {
    const url = typeof node.attrs?.src === "string" ? node.attrs.src.trim() : "";
    if (!url) return;
    references.push({ url, kind: classifyImageUrl(url) });
  });
  return { references };
}

function detectContentKind(content: string, contentFormat: string): "markdown" | "html" | "tiptap-json" {
  const normalized = String(contentFormat || "").toLowerCase();
  if (normalized === "markdown" || normalized === "md") return "markdown";
  if (normalized === "html" || normalized === "richtext" || normalized === "rich-text") return "html";
  if (normalized === "tiptap-json" || normalized === "tiptap" || normalized === "json") return "tiptap-json";
  const trimmed = content.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return "tiptap-json";
  if (/<img\b/i.test(content)) return "html";
  return "markdown";
}

export function scanRemoteImages(content: string, contentFormat: string): RemoteImageScanResult {
  const kind = detectContentKind(content || "", contentFormat);
  let references: RemoteImageReference[] = [];
  let parseError: string | undefined;

  if (kind === "markdown") references = markdownReferences(content || "");
  else if (kind === "html") references = htmlReferences(content || "");
  else {
    const result = tiptapReferences(content || "");
    references = result.references;
    parseError = result.parseError;
  }

  const remote = references.filter((reference) => reference.kind === "remote");
  const local = references.filter((reference) => reference.kind === "local");
  const ignored = references.filter((reference) => reference.kind === "ignored");

  return {
    contentFormat: kind,
    totalImageReferences: references.length,
    remoteReferenceCount: remote.length,
    localReferenceCount: local.length,
    ignoredReferenceCount: ignored.length,
    remoteUrls: [...new Set(remote.map((reference) => reference.url))],
    ...(parseError ? { parseError } : {}),
  };
}

function replaceMarkdown(content: string, replacements: ReadonlyMap<string, string>): RemoteImageReplacementResult {
  let replacedCount = 0;
  const output = content.replace(MARKDOWN_IMAGE_RE, (fullMatch, destinationToken: string) => {
    const wrapped = destinationToken.startsWith("<") && destinationToken.endsWith(">");
    const originalUrl = wrapped ? destinationToken.slice(1, -1).trim() : destinationToken.trim();
    const localUrl = replacements.get(originalUrl);
    if (!localUrl || localUrl === originalUrl) return fullMatch;
    replacedCount += 1;
    const nextToken = wrapped ? `<${localUrl}>` : localUrl;
    const tokenOffset = fullMatch.indexOf(destinationToken);
    if (tokenOffset < 0) return fullMatch;
    return fullMatch.slice(0, tokenOffset) + nextToken + fullMatch.slice(tokenOffset + destinationToken.length);
  });
  return { content: output, replacedCount, changed: replacedCount > 0 };
}

function replaceHtml(content: string, replacements: ReadonlyMap<string, string>): RemoteImageReplacementResult {
  let replacedCount = 0;
  const output = content.replace(HTML_IMAGE_TAG_RE, (tag) => {
    const srcMatch = tag.match(HTML_SRC_RE);
    const originalUrl = (srcMatch?.[1] ?? srcMatch?.[2] ?? srcMatch?.[3] ?? "").trim();
    const localUrl = replacements.get(originalUrl);
    if (!srcMatch || !originalUrl || !localUrl || localUrl === originalUrl) return tag;
    const rawValue = srcMatch[1] ?? srcMatch[2] ?? srcMatch[3] ?? "";
    const valueOffset = srcMatch[0].indexOf(rawValue);
    if (valueOffset < 0 || srcMatch.index === undefined) return tag;
    const absoluteOffset = srcMatch.index + valueOffset;
    replacedCount += 1;
    return tag.slice(0, absoluteOffset) + localUrl + tag.slice(absoluteOffset + rawValue.length);
  });
  return { content: output, replacedCount, changed: replacedCount > 0 };
}

function replaceTiptap(content: string, replacements: ReadonlyMap<string, string>): RemoteImageReplacementResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content || "{}");
  } catch (error) {
    return {
      content,
      replacedCount: 0,
      changed: false,
      parseError: `Tiptap JSON 解析失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }

  let replacedCount = 0;
  walkTiptapImages(parsed, (node) => {
    const originalUrl = typeof node.attrs?.src === "string" ? node.attrs.src.trim() : "";
    const localUrl = replacements.get(originalUrl);
    if (!originalUrl || !localUrl || localUrl === originalUrl || !node.attrs) return;
    node.attrs.src = localUrl;
    replacedCount += 1;
  });

  return {
    content: replacedCount > 0 ? JSON.stringify(parsed) : content,
    replacedCount,
    changed: replacedCount > 0,
  };
}

export function replaceRemoteImages(
  content: string,
  contentFormat: string,
  replacements: ReadonlyMap<string, string>,
): RemoteImageReplacementResult {
  if (replacements.size === 0) return { content, replacedCount: 0, changed: false };
  const kind = detectContentKind(content || "", contentFormat);
  if (kind === "markdown") return replaceMarkdown(content || "", replacements);
  if (kind === "html") return replaceHtml(content || "", replacements);
  return replaceTiptap(content || "", replacements);
}
