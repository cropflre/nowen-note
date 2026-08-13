const ATTACHMENT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class TransientPersistedImageSourceError extends Error {
  readonly source: string;

  constructor(source: string) {
    super("拒绝持久化无法恢复附件身份的临时图片地址");
    this.name = "TransientPersistedImageSourceError";
    this.source = source;
  }
}

const reportedTransientSources = new Set<string>();

export function reportTransientPersistedImageSource(
  error: unknown,
  context: Record<string, unknown> = {},
): void {
  if (!(error instanceof TransientPersistedImageSourceError)) return;
  if (reportedTransientSources.has(error.source)) return;
  reportedTransientSources.add(error.source);
  console.error("[note-persistence] refused transient image source", {
    ...context,
    source: error.source,
  });
}

function persistentAttachmentUrl(source: string): string | null {
  const match = source.match(/\/api\/attachments\/([^/?#]+)/i);
  const id = match?.[1] || "";
  return ATTACHMENT_ID_RE.test(id) ? `/api/attachments/${id}` : null;
}

function stabilizeImageSource(source: string): string {
  const value = source.trim();
  const persistent = persistentAttachmentUrl(value);
  if (persistent) return persistent;
  if (/^(?:blob:|file:)/i.test(value)) throw new TransientPersistedImageSourceError(value);
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

export function stabilizePersistedNoteContent(content: string, contentFormat: string): string {
  if (!content) return content;
  if (contentFormat === "tiptap-json") {
    try {
      const parsed = JSON.parse(content);
      const normalized = normalizeTiptapNode(parsed).value;
      return normalized === parsed ? content : JSON.stringify(normalized);
    } catch (error) {
      if (error instanceof TransientPersistedImageSourceError) throw error;
      // 格式标记错误的历史正文继续按 Markdown/HTML 图片边界处理。
    }
  }
  return stabilizeMarkupImages(content);
}
