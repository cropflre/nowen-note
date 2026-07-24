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

export class TiptapBlockNodeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TiptapBlockNodeValidationError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: Set<string>, label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TiptapBlockNodeValidationError(`${label} 包含不支持的字段: ${key}`);
  }
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
  if (!trimmed) return false;
  if (/^(?:javascript|vbscript|data|file):/i.test(trimmed)) return false;
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

function normalizeOptionalLabel(value: unknown, label: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string" || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TiptapBlockNodeValidationError(`${label} 无效`);
  }
  return value;
}

function normalizeImageDimension(value: unknown, label: string): number | string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const numeric = typeof value === "number"
    ? value
    : typeof value === "string" && /^\d+$/.test(value)
      ? Number(value)
      : Number.NaN;
  if (!Number.isInteger(numeric) || numeric < 1 || numeric > 10_000) {
    throw new TiptapBlockNodeValidationError(`${label} 必须为 1-10000 的整数`);
  }
  return value as number | string;
}

function normalizeImage(raw: Record<string, unknown>, label: string): TiptapPatchImageNode {
  assertOnlyKeys(raw, IMAGE_KEYS, label);
  const attrs = raw.attrs;
  if (!isRecord(attrs)) throw new TiptapBlockNodeValidationError(`${label}.attrs 必须是对象`);
  assertOnlyKeys(attrs, IMAGE_ATTR_KEYS, `${label}.attrs`);
  if (!isSafeImageSrc(attrs.src)) throw new TiptapBlockNodeValidationError(`${label}.attrs.src 协议或大小不安全`);

  const normalized: TiptapPatchImageNode["attrs"] = { src: attrs.src.trim() };
  const alt = normalizeOptionalLabel(attrs.alt, `${label}.attrs.alt`);
  const title = normalizeOptionalLabel(attrs.title, `${label}.attrs.title`);
  const width = normalizeImageDimension(attrs.width, `${label}.attrs.width`);
  const height = normalizeImageDimension(attrs.height, `${label}.attrs.height`);
  if (alt !== undefined) normalized.alt = alt;
  if (title !== undefined) normalized.title = title;
  if (width !== undefined) normalized.width = width;
  if (height !== undefined) normalized.height = height;

  if (attrs.rotation !== undefined) {
    const rotation = Number(attrs.rotation);
    if (![0, 90, 180, 270].includes(rotation)) {
      throw new TiptapBlockNodeValidationError(`${label}.attrs.rotation 仅支持 0/90/180/270`);
    }
    normalized.rotation = rotation as 0 | 90 | 180 | 270;
  }
  if (attrs.flipX !== undefined) {
    if (typeof attrs.flipX !== "boolean") {
      throw new TiptapBlockNodeValidationError(`${label}.attrs.flipX 必须是布尔值`);
    }
    normalized.flipX = attrs.flipX;
  }
  return { type: "image", attrs: normalized };
}

function validateMark(raw: unknown, label: string): TiptapPatchMark {
  if (!isRecord(raw) || typeof raw.type !== "string") {
    throw new TiptapBlockNodeValidationError(`${label} 必须是合法 mark`);
  }
  assertOnlyKeys(raw, MARK_KEYS, label);
  const attrs = raw.attrs == null ? {} : raw.attrs;
  if (!isRecord(attrs)) throw new TiptapBlockNodeValidationError(`${label}.attrs 必须是对象`);

  if (SIMPLE_MARKS.has(raw.type)) {
    if (Object.keys(attrs).length > 0) {
      throw new TiptapBlockNodeValidationError(`${label}.${raw.type} 不接受 attrs`);
    }
    return { type: raw.type };
  }

  if (raw.type === "link") {
    assertOnlyKeys(attrs, new Set(["href", "target", "rel", "class"]), `${label}.attrs`);
    if (!isSafeHref(attrs.href)) throw new TiptapBlockNodeValidationError(`${label}.attrs.href 协议不安全`);
    if (attrs.target != null && (
      typeof attrs.target !== "string" || !["_blank", "_self", "_parent", "_top"].includes(attrs.target)
    )) {
      throw new TiptapBlockNodeValidationError(`${label}.attrs.target 无效`);
    }
    if (attrs.rel != null && (typeof attrs.rel !== "string" || !SAFE_REL_RE.test(attrs.rel))) {
      throw new TiptapBlockNodeValidationError(`${label}.attrs.rel 无效`);
    }
    if (attrs.class != null && (typeof attrs.class !== "string" || !SAFE_CLASS_RE.test(attrs.class))) {
      throw new TiptapBlockNodeValidationError(`${label}.attrs.class 无效`);
    }
    return { type: "link", attrs: { ...attrs } };
  }

  if (raw.type === "highlight") {
    assertOnlyKeys(attrs, new Set(["color"]), `${label}.attrs`);
    if (attrs.color != null && (typeof attrs.color !== "string" || !HEX_COLOR_RE.test(attrs.color))) {
      throw new TiptapBlockNodeValidationError(`${label}.attrs.color 无效`);
    }
    return { type: "highlight", attrs: { ...attrs } };
  }

  if (raw.type === "textStyle") {
    assertOnlyKeys(attrs, new Set(["color", "fontSize"]), `${label}.attrs`);
    if (attrs.color != null && (typeof attrs.color !== "string" || !HEX_COLOR_RE.test(attrs.color))) {
      throw new TiptapBlockNodeValidationError(`${label}.attrs.color 无效`);
    }
    if (!isValidFontSize(attrs.fontSize)) {
      throw new TiptapBlockNodeValidationError(`${label}.attrs.fontSize 无效`);
    }
    return { type: "textStyle", attrs: { ...attrs } };
  }

  throw new TiptapBlockNodeValidationError(`${label}.type 不支持: ${raw.type}`);
}

function validateAttrs(
  type: TiptapPatchTextBlockNode["type"],
  raw: unknown,
  expectedBlockId: string,
): Record<string, unknown> {
  if (!isRecord(raw)) throw new TiptapBlockNodeValidationError("node.attrs 必须是对象");
  if (raw.blockId !== expectedBlockId || !BLOCK_ID_RE.test(expectedBlockId)) {
    throw new TiptapBlockNodeValidationError("node.attrs.blockId 必须与目标块一致");
  }

  if (type === "paragraph") {
    assertOnlyKeys(raw, new Set(["blockId", "textAlign", "lineHeight", "indent"]), "node.attrs");
  } else if (type === "heading") {
    assertOnlyKeys(raw, new Set(["blockId", "level", "textAlign", "lineHeight"]), "node.attrs");
    if (!Number.isInteger(raw.level) || Number(raw.level) < 1 || Number(raw.level) > 6) {
      throw new TiptapBlockNodeValidationError("node.attrs.level 必须为 1-6");
    }
  } else {
    assertOnlyKeys(raw, new Set(["blockId", "language", "indent"]), "node.attrs");
    if (raw.language != null && (typeof raw.language !== "string" || !LANGUAGE_RE.test(raw.language))) {
      throw new TiptapBlockNodeValidationError("node.attrs.language 无效");
    }
    if (raw.indent != null && (!Number.isInteger(raw.indent) || Number(raw.indent) < 0 || Number(raw.indent) > 8)) {
      throw new TiptapBlockNodeValidationError("node.attrs.indent 必须为 0-8");
    }
  }

  if (raw.textAlign != null && (
    typeof raw.textAlign !== "string" || !["left", "center", "right", "justify"].includes(raw.textAlign)
  )) {
    throw new TiptapBlockNodeValidationError("node.attrs.textAlign 无效");
  }
  if (!isValidLineHeight(raw.lineHeight)) {
    throw new TiptapBlockNodeValidationError("node.attrs.lineHeight 无效");
  }
  if (raw.indent != null && (!Number.isInteger(raw.indent) || Number(raw.indent) < 0 || Number(raw.indent) > 8)) {
    throw new TiptapBlockNodeValidationError("node.attrs.indent 必须为 0-8");
  }
  return { ...raw };
}

function isSafeMediaUrl(value: unknown, allowDataImage = false): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 8192) return false;
  if (/[\u0000-\u001f\u007f]/.test(value)) return false;
  const trimmed = value.trim();
  if (allowDataImage && /^data:image\/(?:png|jpe?g|gif|webp|svg\+xml);base64,/i.test(trimmed)) {
    return trimmed.length <= 256_000;
  }
  return /^(?:https?:)?\/\//i.test(trimmed)
    || trimmed.startsWith("/api/attachments/")
    || trimmed.startsWith("./")
    || trimmed.startsWith("../");
}

function validateOptionalText(value: unknown, label: string, maxLength: number): string | null {
  if (value == null) return null;
  if (typeof value !== "string" || value.length > maxLength || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TiptapBlockNodeValidationError(`${label} 无效`);
  }
  return value;
}

function validateInlineAtom(raw: Record<string, unknown>, label: string) {
  if (!isRecord(raw.attrs)) throw new TiptapBlockNodeValidationError(`${label}.attrs 必须是对象`);
  if (raw.type === "mathInline") {
    assertOnlyKeys(raw.attrs, new Set(["latex"]), `${label}.attrs`);
    if (typeof raw.attrs.latex !== "string" || raw.attrs.latex.length > 16_384 || /\u0000/.test(raw.attrs.latex)) {
      throw new TiptapBlockNodeValidationError(`${label}.attrs.latex 无效`);
    }
    return { type: "mathInline" as const, attrs: { latex: raw.attrs.latex } };
  }
  throw new TiptapBlockNodeValidationError(`${label}.type 不支持`);
}

function validateMetadata(value: unknown, depth = 0): unknown {
  if (depth > 4) throw new TiptapBlockNodeValidationError("table.attrs.colgroup 嵌套过深");
  if (value == null || typeof value === "boolean" || typeof value === "string") {
    if (typeof value === "string" && value.length > 256) {
      throw new TiptapBlockNodeValidationError("table.attrs.colgroup 字符串过长");
    }
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TiptapBlockNodeValidationError("table.attrs.colgroup 数字无效");
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 128) throw new TiptapBlockNodeValidationError("table.attrs.colgroup 数组过长");
    return value.map((item) => validateMetadata(item, depth + 1));
  }
  if (!isRecord(value) || Object.keys(value).length > 128) {
    throw new TiptapBlockNodeValidationError("table.attrs.colgroup 无效");
  }
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!key || key.length > 64 || ["__proto__", "prototype", "constructor"].includes(key)) {
      throw new TiptapBlockNodeValidationError("table.attrs.colgroup 键名无效");
    }
    output[key] = validateMetadata(item, depth + 1);
  }
  return output;
}

function validateTextBlock(
  raw: unknown,
  expectedBlockId: string,
  label = "replace.node",
): TiptapPatchTextBlockNode {
  if (!isRecord(raw) || typeof raw.type !== "string" || !["paragraph", "heading", "codeBlock"].includes(raw.type)) {
    throw new TiptapBlockNodeValidationError(`${label} 仅支持 paragraph、heading、codeBlock`);
  }
  assertOnlyKeys(raw, NODE_KEYS, label);
  const type = raw.type as TiptapPatchTextBlockNode["type"];
  const attrs = validateAttrs(type, raw.attrs, expectedBlockId);
  const content = raw.content == null ? [] : raw.content;
  if (!Array.isArray(content) || content.length > 10_000) {
    throw new TiptapBlockNodeValidationError(`${label}.content 必须是受限数组`);
  }

  const normalizedContent = content.map((child, index): TiptapPatchInlineNode => {
    const childLabel = `${label}.content[${index}]`;
    if (!isRecord(child) || typeof child.type !== "string") {
      throw new TiptapBlockNodeValidationError(`${childLabel} 无效`);
    }
    if (child.type === "image") {
      if (type === "codeBlock") throw new TiptapBlockNodeValidationError(`${childLabel} 在 codeBlock 中无效`);
      return normalizeImage(child, childLabel);
    }
    if (child.type === "mathInline") {
      assertOnlyKeys(child, INLINE_ATOM_KEYS, childLabel);
      if (type === "codeBlock" || child.text != null || child.marks != null) {
        throw new TiptapBlockNodeValidationError(`${childLabel} 在当前块中无效`);
      }
      return validateInlineAtom(child, childLabel);
    }
    assertOnlyKeys(child, INLINE_KEYS, childLabel);
    if (child.type === "hardBreak") {
      if (type === "codeBlock" || child.text != null || child.marks != null) {
        throw new TiptapBlockNodeValidationError(`${childLabel} 在当前块中无效`);
      }
      return { type: "hardBreak" as const };
    }
    if (child.type !== "text" || typeof child.text !== "string") {
      throw new TiptapBlockNodeValidationError(`${childLabel} 仅支持 text/hardBreak/image/mathInline`);
    }
    if (child.text.length > 1_000_000) {
      throw new TiptapBlockNodeValidationError(`${childLabel}.text 过长`);
    }
    const marks = child.marks == null ? [] : child.marks;
    if (!Array.isArray(marks) || marks.length > 16) {
      throw new TiptapBlockNodeValidationError(`${childLabel}.marks 无效`);
    }
    if (type === "codeBlock" && marks.length > 0) {
      throw new TiptapBlockNodeValidationError("codeBlock 不支持 inline marks");
    }
    const normalizedMarks = marks.map((mark, markIndex) => validateMark(mark, `${childLabel}.marks[${markIndex}]`));
    return {
      type: "text" as const,
      text: child.text,
      ...(normalizedMarks.length > 0 ? { marks: normalizedMarks } : {}),
    };
  });

  return {
    type,
    attrs,
    ...(normalizedContent.length > 0 ? { content: normalizedContent } : {}),
  };
}

function validateAtom(raw: Record<string, unknown>, expectedBlockId: string): TiptapPatchAtomNode {
  assertOnlyKeys(raw, new Set(["type", "attrs"]), "replace.node");
  if (!isRecord(raw.attrs) || raw.attrs.blockId !== expectedBlockId || !BLOCK_ID_RE.test(expectedBlockId)) {
    throw new TiptapBlockNodeValidationError("node.attrs.blockId 必须与目标块一致");
  }
  if (raw.type === "video") {
    assertOnlyKeys(raw.attrs, new Set([
      "blockId", "src", "platform", "kind", "originalUrl", "attachmentId", "filename", "mimeType", "size",
    ]), "video.attrs");
    if (!isSafeMediaUrl(raw.attrs.src) || !isSafeMediaUrl(raw.attrs.originalUrl)) {
      throw new TiptapBlockNodeValidationError("video URL 无效");
    }
    if (typeof raw.attrs.kind !== "string" || !["file", "iframe"].includes(raw.attrs.kind)) {
      throw new TiptapBlockNodeValidationError("video.attrs.kind 无效");
    }
    if (typeof raw.attrs.platform !== "string" || !/^[A-Za-z0-9_-]{1,32}$/.test(raw.attrs.platform)) {
      throw new TiptapBlockNodeValidationError("video.attrs.platform 无效");
    }
    if (typeof raw.attrs.attachmentId !== "string" || raw.attrs.attachmentId.length > 128
      || (raw.attrs.attachmentId && !/^[A-Za-z0-9_-]{6,128}$/.test(raw.attrs.attachmentId))) {
      throw new TiptapBlockNodeValidationError("video.attrs.attachmentId 无效");
    }
    validateOptionalText(raw.attrs.filename, "video.attrs.filename", 512);
    if (typeof raw.attrs.mimeType !== "string" || raw.attrs.mimeType.length > 128
      || (raw.attrs.kind === "file" && !/^video\/[A-Za-z0-9.+-]+$/i.test(raw.attrs.mimeType))) {
      throw new TiptapBlockNodeValidationError("video.attrs.mimeType 无效");
    }
    if (!Number.isInteger(raw.attrs.size) || Number(raw.attrs.size) < 0 || Number(raw.attrs.size) > 2_147_483_648) {
      throw new TiptapBlockNodeValidationError("video.attrs.size 无效");
    }
    return { type: "video", attrs: { ...raw.attrs } };
  }
  if (raw.type === "blockEmbed") {
    assertOnlyKeys(raw.attrs, new Set(["blockId", "href"]), "blockEmbed.attrs");
    if (typeof raw.attrs.href !== "string" || raw.attrs.href.length > 2048 || !/^note:[0-9a-f-]{36}(?:#blk:blk_[A-Za-z0-9_-]{6,})?$/i.test(raw.attrs.href)) {
      throw new TiptapBlockNodeValidationError("blockEmbed.attrs.href 无效");
    }
    return { type: "blockEmbed", attrs: { ...raw.attrs } };
  }
  assertOnlyKeys(raw.attrs, new Set(["blockId", "latex"]), "mathBlock.attrs");
  if (typeof raw.attrs.latex !== "string" || raw.attrs.latex.length > 65_536 || /\u0000/.test(raw.attrs.latex)) {
    throw new TiptapBlockNodeValidationError("mathBlock.attrs.latex 无效");
  }
  return { type: "mathBlock", attrs: { ...raw.attrs } };
}

function validateTable(raw: Record<string, unknown>, expectedBlockId: string): TiptapPatchTableNode {
  assertOnlyKeys(raw, NODE_KEYS, "replace.node");
  if (!isRecord(raw.attrs) || raw.attrs.blockId !== expectedBlockId || !BLOCK_ID_RE.test(expectedBlockId)) {
    throw new TiptapBlockNodeValidationError("node.attrs.blockId 必须与目标块一致");
  }
  assertOnlyKeys(raw.attrs, new Set(["blockId", "tableAligns", "colgroup"]), "table.attrs");
  if (raw.attrs.tableAligns != null && (
    !Array.isArray(raw.attrs.tableAligns)
    || raw.attrs.tableAligns.length > 128
    || raw.attrs.tableAligns.some((value) => value != null && (
      typeof value !== "string" || !["left", "center", "right"].includes(value)
    ))
  )) {
    throw new TiptapBlockNodeValidationError("table.attrs.tableAligns 无效");
  }
  const attrs = {
    ...raw.attrs,
    ...(raw.attrs.colgroup !== undefined ? { colgroup: validateMetadata(raw.attrs.colgroup) } : {}),
  };
  if (!Array.isArray(raw.content) || raw.content.length < 1 || raw.content.length > 500) {
    throw new TiptapBlockNodeValidationError("table.content 行数必须为 1-500");
  }

  const seenIds = new Set([expectedBlockId]);
  let cellCount = 0;
  const rows = raw.content.map((row, rowIndex): TiptapPatchTableRowNode => {
    const rowLabel = `table.content[${rowIndex}]`;
    if (!isRecord(row) || row.type !== "tableRow") {
      throw new TiptapBlockNodeValidationError(`${rowLabel} 必须是 tableRow`);
    }
    assertOnlyKeys(row, NODE_KEYS, rowLabel);
    const rowAttrs = row.attrs == null ? {} : row.attrs;
    if (!isRecord(rowAttrs)) throw new TiptapBlockNodeValidationError(`${rowLabel}.attrs 必须是对象`);
    assertOnlyKeys(rowAttrs, new Set(["height"]), `${rowLabel}.attrs`);
    if (rowAttrs.height != null && (!Number.isInteger(rowAttrs.height) || Number(rowAttrs.height) < 1 || Number(rowAttrs.height) > 5_000)) {
      throw new TiptapBlockNodeValidationError(`${rowLabel}.attrs.height 无效`);
    }
    if (!Array.isArray(row.content) || row.content.length < 1 || row.content.length > 200) {
      throw new TiptapBlockNodeValidationError(`${rowLabel}.content 单元格数量无效`);
    }
    cellCount += row.content.length;
    if (cellCount > 10_000) throw new TiptapBlockNodeValidationError("table 单元格总数超过 10000");

    const cells = row.content.map((cell, cellIndex): TiptapPatchTableCellNode => {
      const cellLabel = `${rowLabel}.content[${cellIndex}]`;
      if (!isRecord(cell) || typeof cell.type !== "string" || !["tableCell", "tableHeader"].includes(cell.type)) {
        throw new TiptapBlockNodeValidationError(`${cellLabel} 必须是 tableCell/tableHeader`);
      }
      assertOnlyKeys(cell, NODE_KEYS, cellLabel);
      if (!isRecord(cell.attrs)) throw new TiptapBlockNodeValidationError(`${cellLabel}.attrs 必须是对象`);
      assertOnlyKeys(cell.attrs, new Set(["colspan", "rowspan", "colwidth", "align"]), `${cellLabel}.attrs`);
      const colspan = cell.attrs.colspan;
      const rowspan = cell.attrs.rowspan;
      if (typeof colspan !== "number" || !Number.isInteger(colspan) || colspan < 1 || colspan > 200
        || typeof rowspan !== "number" || !Number.isInteger(rowspan) || rowspan < 1 || rowspan > 500) {
        throw new TiptapBlockNodeValidationError(`${cellLabel} 跨行列属性无效`);
      }
      if (cell.attrs.colwidth != null && (
        !Array.isArray(cell.attrs.colwidth)
        || cell.attrs.colwidth.length !== colspan
        || cell.attrs.colwidth.some((value) => !Number.isInteger(value) || Number(value) < 1 || Number(value) > 10_000)
      )) {
        throw new TiptapBlockNodeValidationError(`${cellLabel}.attrs.colwidth 无效`);
      }
      if (cell.attrs.align != null && (
        typeof cell.attrs.align !== "string" || !["left", "center", "right"].includes(cell.attrs.align)
      )) {
        throw new TiptapBlockNodeValidationError(`${cellLabel}.attrs.align 无效`);
      }
      if (!Array.isArray(cell.content) || cell.content.length < 1 || cell.content.length > 100) {
        throw new TiptapBlockNodeValidationError(`${cellLabel}.content 无效`);
      }
      const paragraphs = cell.content.map((paragraph, paragraphIndex) => {
        if (!isRecord(paragraph) || paragraph.type !== "paragraph" || !isRecord(paragraph.attrs)) {
          throw new TiptapBlockNodeValidationError(`${cellLabel}.content[${paragraphIndex}] 必须是 paragraph`);
        }
        const blockId = paragraph.attrs.blockId;
        if (typeof blockId !== "string" || !BLOCK_ID_RE.test(blockId) || seenIds.has(blockId)) {
          throw new TiptapBlockNodeValidationError(`${cellLabel}.content[${paragraphIndex}].attrs.blockId 无效或重复`);
        }
        seenIds.add(blockId);
        return validateTextBlock(paragraph, blockId, `${cellLabel}.content[${paragraphIndex}]`);
      });
      return { type: cell.type as "tableCell" | "tableHeader", attrs: { ...cell.attrs }, content: paragraphs };
    });
    return { type: "tableRow", attrs: { ...rowAttrs }, content: cells };
  });
  return { type: "table", attrs, content: rows };
}

export function normalizeTiptapReplacementNode(
  raw: unknown,
  expectedBlockId: string,
): TiptapPatchJsonNode {
  if (!isRecord(raw) || typeof raw.type !== "string" || !BLOCK_TYPES.has(raw.type)) {
    throw new TiptapBlockNodeValidationError("replace.node 仅支持 paragraph、heading、codeBlock、table");
  }
  const normalized = raw.type === "table"
    ? validateTable(raw, expectedBlockId)
    : ["video", "blockEmbed", "mathBlock"].includes(raw.type)
      ? validateAtom(raw, expectedBlockId)
      : validateTextBlock(raw, expectedBlockId);
  if (Buffer.byteLength(JSON.stringify(normalized), "utf8") > 256_000) {
    throw new TiptapBlockNodeValidationError("单个 replace.node 不能超过 256 KB");
  }
  return normalized;
}
