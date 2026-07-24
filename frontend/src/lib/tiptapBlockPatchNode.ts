const BLOCK_ID_RE = /^blk_[A-Za-z0-9_-]{6,}$/;
const BLOCK_TYPES = new Set(["paragraph", "heading", "codeBlock"]);
const SIMPLE_MARKS = new Set(["bold", "italic", "underline", "strike", "code"]);
const NODE_KEYS = new Set(["type", "attrs", "content"]);
const INLINE_KEYS = new Set(["type", "text", "marks"]);
const IMAGE_KEYS = new Set(["type", "attrs"]);
const IMAGE_ATTR_KEYS = new Set(["src", "alt", "title", "width", "height", "rotation", "flipX"]);
const MARK_KEYS = new Set(["type", "attrs"]);
const HEX_COLOR_RE = /^#[0-9a-f]{3,8}$/i;
const FONT_SIZE_RE = /^(?:\d+(?:\.\d+)?)(?:px|em|rem|%)$/;
const LANGUAGE_RE = /^[A-Za-z0-9_+.#-]{0,64}$/;
const SAFE_REL_RE = /^[A-Za-z0-9_\s-]{0,256}$/;
const SAFE_CLASS_RE = /^[A-Za-z0-9_\s-]{0,128}$/;
const SAFE_DATA_IMAGE_RE = /^data:image\/(?:png|jpe?g|gif|webp);base64,[a-z0-9+/=\r\n]+$/i;

export interface TiptapPatchMark {
  type: string;
  attrs?: Record<string, unknown> | null;
}

export interface TiptapPatchImageNode {
  type: "image";
  attrs: {
    src: string;
    alt?: string | null;
    title?: string | null;
    width?: number | string | null;
    height?: number | string | null;
    rotation?: 0 | 90 | 180 | 270;
    flipX?: boolean;
  };
}

export type TiptapPatchInlineNode =
  | {
      type: "text" | "hardBreak";
      text?: string;
      marks?: TiptapPatchMark[];
    }
  | TiptapPatchImageNode;

export interface TiptapPatchJsonNode {
  type: "paragraph" | "heading" | "codeBlock";
  attrs: Record<string, unknown>;
  content?: TiptapPatchInlineNode[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isValidLineHeight(value: unknown): boolean {
  if (value == null) return true;
  if (typeof value !== "string" || !/^\d(?:\.\d{1,2})?$/.test(value)) return false;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 1 && numeric <= 3;
}

function isValidFontSize(value: unknown): boolean {
  if (value == null) return true;
  if (typeof value !== "string" || value.length > 12 || !FONT_SIZE_RE.test(value)) return false;
  const match = value.match(/^([\d.]+)(px|em|rem|%)$/);
  if (!match) return false;
  const numeric = Number(match[1]);
  if (!Number.isFinite(numeric) || numeric <= 0) return false;
  if (match[2] === "px") return numeric >= 8 && numeric <= 96;
  if (match[2] === "%") return numeric >= 50 && numeric <= 600;
  return numeric >= 0.5 && numeric <= 6;
}

function isSafeHref(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 2048) return false;
  if (/[\u0000-\u001f\u007f]/.test(value)) return false;
  const trimmed = value.trim();
  if (!trimmed || /^(?:javascript|vbscript|data|file):/i.test(trimmed)) return false;
  return /^(?:https?:|mailto:|tel:|sms:|note:)/i.test(trimmed)
    || trimmed.startsWith("#")
    || trimmed.startsWith("/")
    || trimmed.startsWith("./")
    || trimmed.startsWith("../");
}

function isSafeImageSrc(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 240_000) return false;
  if (/[\u0000-\u001f\u007f]/.test(value.replace(/[\r\n]/g, ""))) return false;
  const trimmed = value.trim();
  if (!trimmed || /^(?:javascript|vbscript|file|blob):/i.test(trimmed)) return false;
  return /^https?:/i.test(trimmed)
    || trimmed.startsWith("/")
    || trimmed.startsWith("./")
    || trimmed.startsWith("../")
    || SAFE_DATA_IMAGE_RE.test(trimmed);
}

function normalizeOptionalLabel(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string" || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) return undefined;
  return value;
}

function normalizeImageDimension(value: unknown): number | string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const numeric = typeof value === "number"
    ? value
    : typeof value === "string" && /^\d+$/.test(value)
      ? Number(value)
      : Number.NaN;
  if (!Number.isInteger(numeric) || numeric < 1 || numeric > 10_000) return undefined;
  return value as number | string;
}

function normalizeImage(raw: Record<string, unknown>): TiptapPatchImageNode | null {
  if (!hasOnlyKeys(raw, IMAGE_KEYS) || !isRecord(raw.attrs) || !hasOnlyKeys(raw.attrs, IMAGE_ATTR_KEYS)) return null;
  if (!isSafeImageSrc(raw.attrs.src)) return null;
  const normalized: TiptapPatchImageNode["attrs"] = { src: raw.attrs.src.trim() };

  for (const key of ["alt", "title"] as const) {
    if (!(key in raw.attrs)) continue;
    const value = normalizeOptionalLabel(raw.attrs[key]);
    if (value === undefined && raw.attrs[key] !== undefined) return null;
    if (value !== undefined) normalized[key] = value;
  }
  for (const key of ["width", "height"] as const) {
    if (!(key in raw.attrs)) continue;
    const value = normalizeImageDimension(raw.attrs[key]);
    if (value === undefined && raw.attrs[key] !== undefined) return null;
    if (value !== undefined) normalized[key] = value;
  }
  if ("rotation" in raw.attrs) {
    const rotation = Number(raw.attrs.rotation);
    if (![0, 90, 180, 270].includes(rotation)) return null;
    normalized.rotation = rotation as 0 | 90 | 180 | 270;
  }
  if ("flipX" in raw.attrs) {
    if (typeof raw.attrs.flipX !== "boolean") return null;
    normalized.flipX = raw.attrs.flipX;
  }
  return { type: "image", attrs: normalized };
}

function normalizeMark(raw: unknown): TiptapPatchMark | null {
  if (!isRecord(raw) || typeof raw.type !== "string" || !hasOnlyKeys(raw, MARK_KEYS)) return null;
  const attrs = raw.attrs == null ? {} : raw.attrs;
  if (!isRecord(attrs)) return null;

  if (SIMPLE_MARKS.has(raw.type)) {
    return Object.keys(attrs).length === 0 ? { type: raw.type } : null;
  }
  if (raw.type === "link") {
    if (!hasOnlyKeys(attrs, new Set(["href", "target", "rel", "class"]))) return null;
    if (!isSafeHref(attrs.href)) return null;
    if (attrs.target != null && !["_blank", "_self", "_parent", "_top"].includes(String(attrs.target))) return null;
    if (attrs.rel != null && (typeof attrs.rel !== "string" || !SAFE_REL_RE.test(attrs.rel))) return null;
    if (attrs.class != null && (typeof attrs.class !== "string" || !SAFE_CLASS_RE.test(attrs.class))) return null;
    return { type: "link", attrs: { ...attrs } };
  }
  if (raw.type === "highlight") {
    if (!hasOnlyKeys(attrs, new Set(["color"]))) return null;
    if (attrs.color != null && (typeof attrs.color !== "string" || !HEX_COLOR_RE.test(attrs.color))) return null;
    return { type: "highlight", attrs: { ...attrs } };
  }
  if (raw.type === "textStyle") {
    if (!hasOnlyKeys(attrs, new Set(["color", "fontSize"]))) return null;
    if (attrs.color != null && (typeof attrs.color !== "string" || !HEX_COLOR_RE.test(attrs.color))) return null;
    if (!isValidFontSize(attrs.fontSize)) return null;
    return { type: "textStyle", attrs: { ...attrs } };
  }
  return null;
}

function normalizeAttrs(
  type: TiptapPatchJsonNode["type"],
  raw: unknown,
  expectedBlockId: string,
): Record<string, unknown> | null {
  if (!isRecord(raw) || raw.blockId !== expectedBlockId || !BLOCK_ID_RE.test(expectedBlockId)) return null;
  if (type === "paragraph") {
    if (!hasOnlyKeys(raw, new Set(["blockId", "textAlign", "lineHeight"]))) return null;
  } else if (type === "heading") {
    if (!hasOnlyKeys(raw, new Set(["blockId", "level", "textAlign", "lineHeight"]))) return null;
    if (!Number.isInteger(raw.level) || Number(raw.level) < 1 || Number(raw.level) > 6) return null;
  } else {
    if (!hasOnlyKeys(raw, new Set(["blockId", "language", "indent"]))) return null;
    if (raw.language != null && (typeof raw.language !== "string" || !LANGUAGE_RE.test(raw.language))) return null;
    if (raw.indent != null && (!Number.isInteger(raw.indent) || Number(raw.indent) < 0 || Number(raw.indent) > 8)) return null;
  }
  if (raw.textAlign != null && !["left", "center", "right", "justify"].includes(String(raw.textAlign))) return null;
  if (!isValidLineHeight(raw.lineHeight)) return null;
  return { ...raw };
}

export function normalizeSafeTiptapReplacementNode(
  raw: unknown,
  expectedBlockId: string,
): TiptapPatchJsonNode | null {
  if (!isRecord(raw) || typeof raw.type !== "string" || !BLOCK_TYPES.has(raw.type)) return null;
  if (!hasOnlyKeys(raw, NODE_KEYS)) return null;
  const type = raw.type as TiptapPatchJsonNode["type"];
  const attrs = normalizeAttrs(type, raw.attrs, expectedBlockId);
  if (!attrs) return null;
  const content = raw.content == null ? [] : raw.content;
  if (!Array.isArray(content) || content.length > 10_000) return null;

  const normalizedContent: NonNullable<TiptapPatchJsonNode["content"]> = [];
  for (const child of content) {
    if (!isRecord(child) || typeof child.type !== "string") return null;
    if (child.type === "image") {
      if (type === "codeBlock") return null;
      const image = normalizeImage(child);
      if (!image) return null;
      normalizedContent.push(image);
      continue;
    }
    if (!hasOnlyKeys(child, INLINE_KEYS)) return null;
    if (child.type === "hardBreak") {
      if (type === "codeBlock" || child.text != null || child.marks != null) return null;
      normalizedContent.push({ type: "hardBreak" });
      continue;
    }
    if (child.type !== "text" || typeof child.text !== "string" || child.text.length > 1_000_000) return null;
    const marks = child.marks == null ? [] : child.marks;
    if (!Array.isArray(marks) || marks.length > 16 || (type === "codeBlock" && marks.length > 0)) return null;
    const normalizedMarks: TiptapPatchMark[] = [];
    for (const mark of marks) {
      const normalized = normalizeMark(mark);
      if (!normalized) return null;
      normalizedMarks.push(normalized);
    }
    normalizedContent.push({
      type: "text",
      text: child.text,
      ...(normalizedMarks.length > 0 ? { marks: normalizedMarks } : {}),
    });
  }

  const normalized: TiptapPatchJsonNode = {
    type,
    attrs,
    ...(normalizedContent.length > 0 ? { content: normalizedContent } : {}),
  };
  return JSON.stringify(normalized).length <= 256_000 ? normalized : null;
}
