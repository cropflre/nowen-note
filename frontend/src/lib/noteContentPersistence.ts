import { extractAttachmentId, getPersistentAttachmentUrl } from "@/lib/noteAttachmentAccessBridge";

type NoteContentFormat = "tiptap-json" | "markdown" | "html" | string | undefined;

export class TransientNoteAttachmentSourceError extends Error {
  readonly source: string;

  constructor(source: string, media: "图片" | "音频") {
    super(`拒绝持久化无法恢复附件身份的临时${media}地址`);
    this.name = "TransientNoteAttachmentSourceError";
    this.source = source;
  }
}

export class TransientNoteImageSourceError extends TransientNoteAttachmentSourceError {
  constructor(source: string) { super(source, "图片"); this.name = "TransientNoteImageSourceError"; }
}
export class TransientNoteAudioSourceError extends TransientNoteAttachmentSourceError {
  constructor(source: string) { super(source, "音频"); this.name = "TransientNoteAudioSourceError"; }
}

const reportedTransientSources = new Set<string>();

export function reportTransientNoteImageSource(
  error: unknown,
  context: Record<string, unknown> = {},
): void {
  if (!(error instanceof TransientNoteAttachmentSourceError)) return;
  const key = error.source;
  if (reportedTransientSources.has(key)) return;
  reportedTransientSources.add(key);
  console.error("[note-persistence] refused transient attachment source", {
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

function stabilizeAudioSource(source: string, attachmentId?: unknown): string {
  const value = source.trim();
  const persistent = getPersistentAttachmentUrl(value);
  if (persistent) return persistent;
  const transient = /^(?:blob:|file:|content:|capacitor:|ionic:|about:blank)|\/_(?:capacitor_file|app_file)_\//i.test(value);
  // 旧设备正文或草稿可能已丢失反向映射，此时以显式附件身份恢复。
  const id = typeof attachmentId === "string" ? extractAttachmentId(`/api/attachments/${attachmentId}`) : null;
  if (id && (transient || !value)) return `/api/attachments/${id}`;
  if (transient) throw new TransientNoteAudioSourceError(value);
  return source;
}

function normalizeTiptapNode(node: unknown): { value: unknown; changed: boolean } {
  if (!node || typeof node !== "object" || Array.isArray(node)) return { value: node, changed: false };
  const current = node as Record<string, unknown>;
  let next = current;
  let changed = false;

  if ((current.type === "image" || current.type === "voiceMemo") && current.attrs && typeof current.attrs === "object") {
    const attrs = current.attrs as Record<string, unknown>;
    if (typeof attrs.src === "string" || (current.type === "voiceMemo" && attrs.src == null && typeof attrs.attachmentId === "string")) {
      const source = typeof attrs.src === "string" ? attrs.src : "";
      const stableSrc = current.type === "voiceMemo" ? stabilizeAudioSource(source, attrs.attachmentId) : stabilizeImageSource(source);
      const audioId = current.type === "voiceMemo" ? extractAttachmentId(stableSrc) : null;
      if (stableSrc !== attrs.src || (audioId && audioId !== attrs.attachmentId)) {
        next = { ...next, attrs: { ...attrs, src: stableSrc, ...(audioId ? { attachmentId: audioId } : {}) } };
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

function stabilizeMarkupAudio(content: string): string {
  return content.replace(/<audio\b[^>]*>(?:[\s\S]*?<\/audio\s*>)?/gi, (block) => {
    const attributeId = (tag: string) => tag.match(/\sdata-attachment-id\s*=\s*(["'])([^"']+)\1/i)?.[2];
    const parentId = attributeId(block.slice(0, block.indexOf(">") + 1));
    return block.replace(/<(?:audio|source)\b[^>]*>/gi, (tag) => tag.replace(
      /(\ssrc\s*=\s*)(["'])([^"']*)(\2)/gi,
      (_match: string, prefix: string, quote: string, source: string) => `${prefix}${quote}${stabilizeAudioSource(source, attributeId(tag) || parentId)}${quote}`,
    ));
  });
}

/**
 * Note 内容落库前的最终边界：附件签名 URL 和已知 Object URL 恢复为稳定身份；
 * 图片及音频均拒绝无法恢复身份的临时地址，调用方必须保留上一份稳定内容。
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
      if (error instanceof TransientNoteAttachmentSourceError) throw error;
      // 历史内容格式标记可能不准确；非 JSON 内容继续走 Markdown/HTML 附件边界。
    }
  }
  return stabilizeMarkupAudio(stabilizeMarkupImages(content));
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
