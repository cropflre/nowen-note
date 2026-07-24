const BLOCK_ID_RE = /^blk_[A-Za-z0-9_-]{6,}$/;
const BLOCK_TYPES = new Set(["paragraph", "heading", "codeBlock", "table", "video", "blockEmbed", "mathBlock"]);
const SIMPLE_MARKS = new Set(["bold", "italic", "underline", "strike", "code"]);
const NODE_KEYS = new Set(["type", "attrs", "content"]);
const INLINE_KEYS = new Set(["type", "text", "marks"]);
const INLINE_ATOM_KEYS = new Set(["type", "attrs"]);
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
  | TiptapPatchImageNode
  | {
      type: "mathInline";
      attrs: { latex: string };
    };

export interface TiptapPatchTextBlockNode {
  type: "paragraph" | "heading" | "codeBlock";
  attrs: Record<string, unknown>;
  content?: TiptapPatchInlineNode[];
}

export interface TiptapPatchAtomNode {
  type: "video" | "blockEmbed" | "mathBlock";
  attrs: Record<string, unknown>;
}

export interface TiptapPatchTableCellNode {
  type: "tableCell" | "tableHeader";
  attrs: Record<string, unknown>;
  content: TiptapPatchTextBlockNode[];
}

export interface TiptapPatchTableRowNode {
  type: "tableRow";
  attrs: Record<string, unknown>;
  content: TiptapPatchTableCellNode[];
}

export interface TiptapPatchTableNode {
  type: "table";
  attrs: Record<string, unknown>;
  content: TiptapPatchTableRowNode[];
}

export type TiptapPatchJsonNode = TiptapPatchTextBlockNode | TiptapPatchTableNode | TiptapPatchAtomNode;

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
    if (attrs.target != null && (
      typeof attrs.target !== "string" || !["_blank", "_self", "_parent", "_top"].includes(attrs.target)
    )) return null;
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
  type: TiptapPatchTextBlockNode["type"],
  raw: unknown,
  expectedBlockId: string,
): Record<string, unknown> | null {
  if (!isRecord(raw) || raw.blockId !== expectedBlockId || !BLOCK_ID_RE.test(expectedBlockId)) return null;
  if (type === "paragraph") {
    if (!hasOnlyKeys(raw, new Set(["blockId", "textAlign", "lineHeight", "indent"]))) return null;
  } else if (type === "heading") {
    if (!hasOnlyKeys(raw, new Set(["blockId", "level", "textAlign", "lineHeight"]))) return null;
    if (!Number.isInteger(raw.level) || Number(raw.level) < 1 || Number(raw.level) > 6) return null;
  } else {
    if (!hasOnlyKeys(raw, new Set(["blockId", "language", "indent"]))) return null;
    if (raw.language != null && (typeof raw.language !== "string" || !LANGUAGE_RE.test(raw.language))) return null;
    if (raw.indent != null && (!Number.isInteger(raw.indent) || Number(raw.indent) < 0 || Number(raw.indent) > 8)) return null;
  }
  if (raw.textAlign != null && (
    typeof raw.textAlign !== "string" || !["left", "center", "right", "justify"].includes(raw.textAlign)
  )) return null;
  if (!isValidLineHeight(raw.lineHeight)) return null;
  if (raw.indent != null && (!Number.isInteger(raw.indent) || Number(raw.indent) < 0 || Number(raw.indent) > 8)) return null;
  return { ...raw };
}

function isSafeMediaUrl(value: unknown, allowDataImage = false): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 8192 || /[\u0000-\u001f\u007f]/.test(value)) return false;
  const trimmed = value.trim();
  if (allowDataImage && /^data:image\/(?:png|jpe?g|gif|webp|svg\+xml);base64,/i.test(trimmed)) return trimmed.length <= 256_000;
  return /^(?:https?:)?\/\//i.test(trimmed)
    || trimmed.startsWith("/api/attachments/")
    || trimmed.startsWith("./")
    || trimmed.startsWith("../");
}

function safeOptionalText(value: unknown, maxLength: number): boolean {
  return value == null || (typeof value === "string" && value.length <= maxLength && !/[\u0000-\u001f\u007f]/.test(value));
}

function normalizeInlineAtom(raw: Record<string, unknown>) {
  if (!isRecord(raw.attrs)) return null;
  if (raw.type === "mathInline") {
    if (!hasOnlyKeys(raw.attrs, new Set(["latex"]))) return null;
    if (typeof raw.attrs.latex !== "string" || raw.attrs.latex.length > 16_384 || /\u0000/.test(raw.attrs.latex)) return null;
    return { type: "mathInline" as const, attrs: { latex: raw.attrs.latex } };
  }
  return null;
}

function normalizeMetadata(value: unknown, depth = 0): unknown | undefined {
  if (depth > 4) return undefined;
  if (value == null || typeof value === "boolean") return value;
  if (typeof value === "string") return value.length <= 256 ? value : undefined;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) {
    if (value.length > 128) return undefined;
    const output: unknown[] = [];
    for (const item of value) {
      const normalized = normalizeMetadata(item, depth + 1);
      if (normalized === undefined) return undefined;
      output.push(normalized);
    }
    return output;
  }
  if (!isRecord(value) || Object.keys(value).length > 128) return undefined;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!key || key.length > 64 || ["__proto__", "prototype", "constructor"].includes(key)) return undefined;
    const normalized = normalizeMetadata(item, depth + 1);
    if (normalized === undefined) return undefined;
    output[key] = normalized;
  }
  return output;
}

function normalizeTextBlock(
  raw: unknown,
  expectedBlockId: string,
): TiptapPatchTextBlockNode | null {
  if (!isRecord(raw) || typeof raw.type !== "string" || !["paragraph", "heading", "codeBlock"].includes(raw.type)) return null;
  if (!hasOnlyKeys(raw, NODE_KEYS)) return null;
  const type = raw.type as TiptapPatchTextBlockNode["type"];
  const attrs = normalizeAttrs(type, raw.attrs, expectedBlockId);
  if (!attrs) return null;
  const content = raw.content == null ? [] : raw.content;
  if (!Array.isArray(content) || content.length > 10_000) return null;

  const normalizedContent: NonNullable<TiptapPatchTextBlockNode["content"]> = [];
  for (const child of content) {
    if (!isRecord(child) || typeof child.type !== "string") return null;
    if (child.type === "image") {
      if (type === "codeBlock") return null;
      const image = normalizeImage(child);
      if (!image) return null;
      normalizedContent.push(image);
      continue;
    }
    if (child.type === "mathInline") {
      if (!hasOnlyKeys(child, INLINE_ATOM_KEYS) || type === "codeBlock" || child.text != null || child.marks != null) return null;
      const normalized = normalizeInlineAtom(child);
      if (!normalized) return null;
      normalizedContent.push(normalized);
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
  return { type, attrs, ...(normalizedContent.length > 0 ? { content: normalizedContent } : {}) };
}

function normalizeAtom(raw: Record<string, unknown>, expectedBlockId: string): TiptapPatchAtomNode | null {
  if (!hasOnlyKeys(raw, new Set(["type", "attrs"])) || !isRecord(raw.attrs)
    || raw.attrs.blockId !== expectedBlockId || !BLOCK_ID_RE.test(expectedBlockId)) return null;
  if (raw.type === "video") {
    if (!hasOnlyKeys(raw.attrs, new Set([
      "blockId", "src", "platform", "kind", "originalUrl", "attachmentId", "filename", "mimeType", "size",
    ]))) return null;
    if (!isSafeMediaUrl(raw.attrs.src) || !isSafeMediaUrl(raw.attrs.originalUrl)) return null;
    if (typeof raw.attrs.kind !== "string" || !["file", "iframe"].includes(raw.attrs.kind)) return null;
    if (typeof raw.attrs.platform !== "string" || !/^[A-Za-z0-9_-]{1,32}$/.test(raw.attrs.platform)) return null;
    if (typeof raw.attrs.attachmentId !== "string" || raw.attrs.attachmentId.length > 128
      || (raw.attrs.attachmentId && !/^[A-Za-z0-9_-]{6,128}$/.test(raw.attrs.attachmentId))) return null;
    if (!safeOptionalText(raw.attrs.filename, 512)) return null;
    if (typeof raw.attrs.mimeType !== "string" || raw.attrs.mimeType.length > 128
      || (raw.attrs.kind === "file" && !/^video\/[A-Za-z0-9.+-]+$/i.test(raw.attrs.mimeType))) return null;
    if (!Number.isInteger(raw.attrs.size) || Number(raw.attrs.size) < 0 || Number(raw.attrs.size) > 2_147_483_648) return null;
    return { type: "video", attrs: { ...raw.attrs } };
  }
  if (raw.type === "blockEmbed") {
    if (!hasOnlyKeys(raw.attrs, new Set(["blockId", "href"]))) return null;
    if (typeof raw.attrs.href !== "string" || raw.attrs.href.length > 2048
      || !/^note:[0-9a-f-]{36}(?:#blk:blk_[A-Za-z0-9_-]{6,})?$/i.test(raw.attrs.href)) return null;
    return { type: "blockEmbed", attrs: { ...raw.attrs } };
  }
  if (!hasOnlyKeys(raw.attrs, new Set(["blockId", "latex"]))) return null;
  if (typeof raw.attrs.latex !== "string" || raw.attrs.latex.length > 65_536 || /\u0000/.test(raw.attrs.latex)) return null;
  return { type: "mathBlock", attrs: { ...raw.attrs } };
}

function normalizeTable(raw: Record<string, unknown>, expectedBlockId: string): TiptapPatchTableNode | null {
  if (!hasOnlyKeys(raw, NODE_KEYS)) return null;
  if (!isRecord(raw.attrs) || raw.attrs.blockId !== expectedBlockId || !BLOCK_ID_RE.test(expectedBlockId)) return null;
  if (!hasOnlyKeys(raw.attrs, new Set(["blockId", "tableAligns", "colgroup"]))) return null;
  if (raw.attrs.tableAligns != null && (
    !Array.isArray(raw.attrs.tableAligns)
    || raw.attrs.tableAligns.length > 128
    || raw.attrs.tableAligns.some((value) => value != null && (
      typeof value !== "string" || !["left", "center", "right"].includes(value)
    ))
  )) return null;
  const metadata = raw.attrs.colgroup === undefined ? undefined : normalizeMetadata(raw.attrs.colgroup);
  if (raw.attrs.colgroup !== undefined && metadata === undefined) return null;
  const attrs = { ...raw.attrs, ...(raw.attrs.colgroup !== undefined ? { colgroup: metadata } : {}) };
  if (!Array.isArray(raw.content) || raw.content.length < 1 || raw.content.length > 500) return null;

  const seenIds = new Set([expectedBlockId]);
  let cellCount = 0;
  const rows: TiptapPatchTableRowNode[] = [];
  for (const row of raw.content) {
    if (!isRecord(row) || row.type !== "tableRow" || !hasOnlyKeys(row, NODE_KEYS)) return null;
    const rowAttrs = row.attrs == null ? {} : row.attrs;
    if (!isRecord(rowAttrs) || !hasOnlyKeys(rowAttrs, new Set(["height"]))) return null;
    if (rowAttrs.height != null && (!Number.isInteger(rowAttrs.height) || Number(rowAttrs.height) < 1 || Number(rowAttrs.height) > 5_000)) return null;
    if (!Array.isArray(row.content) || row.content.length < 1 || row.content.length > 200) return null;
    cellCount += row.content.length;
    if (cellCount > 10_000) return null;

    const cells: TiptapPatchTableCellNode[] = [];
    for (const cell of row.content) {
      if (!isRecord(cell) || typeof cell.type !== "string" || !["tableCell", "tableHeader"].includes(cell.type) || !hasOnlyKeys(cell, NODE_KEYS)) return null;
      if (!isRecord(cell.attrs) || !hasOnlyKeys(cell.attrs, new Set(["colspan", "rowspan", "colwidth", "align"]))) return null;
      const colspan = cell.attrs.colspan;
      const rowspan = cell.attrs.rowspan;
      if (typeof colspan !== "number" || !Number.isInteger(colspan) || colspan < 1 || colspan > 200
        || typeof rowspan !== "number" || !Number.isInteger(rowspan) || rowspan < 1 || rowspan > 500) return null;
      if (cell.attrs.colwidth != null && (
        !Array.isArray(cell.attrs.colwidth)
        || cell.attrs.colwidth.length !== colspan
        || cell.attrs.colwidth.some((value) => !Number.isInteger(value) || Number(value) < 1 || Number(value) > 10_000)
      )) return null;
      if (cell.attrs.align != null && (
        typeof cell.attrs.align !== "string" || !["left", "center", "right"].includes(cell.attrs.align)
      )) return null;
      if (!Array.isArray(cell.content) || cell.content.length < 1 || cell.content.length > 100) return null;

      const paragraphs: TiptapPatchTextBlockNode[] = [];
      for (const paragraph of cell.content) {
        if (!isRecord(paragraph) || paragraph.type !== "paragraph" || !isRecord(paragraph.attrs)) return null;
        const blockId = paragraph.attrs.blockId;
        if (typeof blockId !== "string" || !BLOCK_ID_RE.test(blockId) || seenIds.has(blockId)) return null;
        seenIds.add(blockId);
        const normalized = normalizeTextBlock(paragraph, blockId);
        if (!normalized) return null;
        paragraphs.push(normalized);
      }
      cells.push({ type: cell.type as "tableCell" | "tableHeader", attrs: { ...cell.attrs }, content: paragraphs });
    }
    rows.push({ type: "tableRow", attrs: { ...rowAttrs }, content: cells });
  }
  return { type: "table", attrs, content: rows };
}

export function normalizeSafeTiptapReplacementNode(
  raw: unknown,
  expectedBlockId: string,
): TiptapPatchJsonNode | null {
  if (!isRecord(raw) || typeof raw.type !== "string" || !BLOCK_TYPES.has(raw.type)) return null;
  const normalized = raw.type === "table"
    ? normalizeTable(raw, expectedBlockId)
    : ["video", "blockEmbed", "mathBlock"].includes(raw.type)
      ? normalizeAtom(raw, expectedBlockId)
      : normalizeTextBlock(raw, expectedBlockId);
  if (!normalized) return null;
  return new TextEncoder().encode(JSON.stringify(normalized)).byteLength <= 256_000 ? normalized : null;
}
