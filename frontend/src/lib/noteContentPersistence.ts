import { getPersistentAttachmentUrl } from "@/lib/noteAttachmentAccessBridge";

type NoteContentFormat = "tiptap-json" | "markdown" | "html" | string | undefined;

export class TransientNoteImageSourceError extends Error {
  readonly source: string;

  constructor(source: string) {
    super("拒绝持久化无法恢复附件身份的临时图片地址");
    this.name = "TransientNoteImageSourceError";
    this.source = source;
  }
}

const reportedTransientSources = new Set<string>();

export function reportTransientNoteImageSource(
  error: unknown,
  context: Record<string, unknown> = {},
): void {
  if (!(error instanceof TransientNoteImageSourceError)) return;
  const key = error.source;
  if (reportedTransientSources.has(key)) return;
  reportedTransientSources.add(key);
  console.error("[note-persistence] refused transient image source", {
    ...context,
    source: error.source,
  });
}

function stabilizeImageSource(source: string): string {
  const value = source.trim();
  const persistent = getPersistentAttachmentUrl(value);
  if (persistent) return persistent;
  if (/^(?:blob:|file:)/i.test(value)) throw new TransientNoteImageSourceError(value);
  return source;
}

function normalizeTiptapNode(node: unknown): { value: unknown; changed: boolean } {
  if (!node || typeof node !== "object" || Array.isArray(node)) return { value: node, changed: false };
  const current = node as Record<string, unknown>;
  let next = current;
  let changed = false;

  if (current.type === "image" && current.attrs && typeof current.attrs === "object") {
    const attrs = current.attrs as Record<string, unknown>;
    if (typeof attrs.src === "string") {
      const stableSrc = stabilizeImageSource(attrs.src);
      if (stableSrc !== attrs.src) {
        next = { ...next, attrs: { ...attrs, src: stableSrc } };
        changed = true;
      }
    }
  }

  if (Array.isArray(current.content)) {
    let contentChanged = false;
    const content = current.content.map((child) => {
      const normalized = normalizeTiptapNode(child);
      if (normalized.changed) contentChanged = true;
      return normalized.value;
    });
    if (contentChanged) {
      next = { ...next, content };
      changed = true;
    }
  }

  return { value: next, changed };
}

export function normalizeTiptapAttachmentSources<T>(document: T): T {
  return normalizeTiptapNode(document).value as T;
}

function stabilizeMarkupImages(content: string): string {
  let result = content.replace(
    /(<img\b[^>]*?\bsrc\s*=\s*)(["'])([^"']+)(\2)/gi,
    (_match, prefix: string, quote: string, source: string) => (
      `${prefix}${quote}${stabilizeImageSource(source)}${quote}`
    ),
  );
  result = result.replace(
    /(!\[[^\]]*\]\(\s*<?)([^\s)>]+)(>?\s*(?:["'][^"']*["'])?\s*\))/g,
    (_match, prefix: string, source: string, suffix: string) => (
      `${prefix}${stabilizeImageSource(source)}${suffix}`
    ),
  );
  return result;
}

/**
 * Note 内容落库前的最终边界：附件签名 URL 和已知 Object URL 恢复为稳定身份；
 * 无法反查 attachmentId 的 blob/file 图片直接拒绝，调用方必须保留上一份稳定内容。
 */
export function stabilizeNoteContentForPersistence(
  content: string,
  contentFormat?: NoteContentFormat,
): string {
  if (!content) return content;
  const trimmed = content.trim();
  const shouldParseJson = contentFormat === "tiptap-json"
    || (!contentFormat && (trimmed.startsWith("{") || trimmed.startsWith("[")));
  if (shouldParseJson) {
    try {
      const parsed = JSON.parse(content);
      const normalized = normalizeTiptapAttachmentSources(parsed);
      return normalized === parsed ? content : JSON.stringify(normalized);
    } catch (error) {
      if (error instanceof TransientNoteImageSourceError) throw error;
      // 历史内容格式标记可能不准确；非 JSON 内容继续走 Markdown/HTML 图片边界。
    }
  }
  return stabilizeMarkupImages(content);
}

export function stabilizeNoteMutationPayload<T extends {
  content?: unknown;
  contentFormat?: unknown;
}>(payload: T): T {
  if (typeof payload.content !== "string") return payload;
  const contentFormat = typeof payload.contentFormat === "string" ? payload.contentFormat : undefined;
  const content = stabilizeNoteContentForPersistence(payload.content, contentFormat);
  return content === payload.content ? payload : { ...payload, content };
}
