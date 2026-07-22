const BLOCK_ID_RE = /^blk_[A-Za-z0-9_-]{6,}$/;
const BLOCK_TYPES = new Set(["paragraph", "heading", "codeBlock"]);
const SIMPLE_MARKS = new Set(["bold", "italic", "underline", "strike", "code"]);
const NODE_KEYS = new Set(["type", "attrs", "content"]);
const INLINE_KEYS = new Set(["type", "text", "marks"]);
const MARK_KEYS = new Set(["type", "attrs"]);
const HEX_COLOR_RE = /^#[0-9a-f]{3,8}$/i;
const FONT_SIZE_RE = /^(?:\d+(?:\.\d+)?)(?:px|em|rem|%)$/;
const LANGUAGE_RE = /^[A-Za-z0-9_+.#-]{0,64}$/;
const SAFE_REL_RE = /^[A-Za-z0-9_\s-]{0,256}$/;
const SAFE_CLASS_RE = /^[A-Za-z0-9_\s-]{0,128}$/;

export interface TiptapPatchMark {
  type: string;
  attrs?: Record<string, unknown> | null;
}

export interface TiptapPatchJsonNode {
  type: "paragraph" | "heading" | "codeBlock";
  attrs: Record<string, unknown>;
  content?: Array<{
    type: "text" | "hardBreak";
    text?: string;
    marks?: TiptapPatchMark[];
  }>;
}

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
    if (attrs.target != null && !["_blank", "_self", "_parent", "_top"].includes(String(attrs.target))) {
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
  type: TiptapPatchJsonNode["type"],
  raw: unknown,
  expectedBlockId: string,
): Record<string, unknown> {
  if (!isRecord(raw)) throw new TiptapBlockNodeValidationError("node.attrs 必须是对象");
  if (raw.blockId !== expectedBlockId || !BLOCK_ID_RE.test(expectedBlockId)) {
    throw new TiptapBlockNodeValidationError("node.attrs.blockId 必须与目标块一致");
  }

  if (type === "paragraph") {
    assertOnlyKeys(raw, new Set(["blockId", "textAlign", "lineHeight"]), "node.attrs");
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

  if (raw.textAlign != null && !["left", "center", "right", "justify"].includes(String(raw.textAlign))) {
    throw new TiptapBlockNodeValidationError("node.attrs.textAlign 无效");
  }
  if (!isValidLineHeight(raw.lineHeight)) {
    throw new TiptapBlockNodeValidationError("node.attrs.lineHeight 无效");
  }
  return { ...raw };
}

export function normalizeTiptapReplacementNode(
  raw: unknown,
  expectedBlockId: string,
): TiptapPatchJsonNode {
  if (!isRecord(raw) || typeof raw.type !== "string" || !BLOCK_TYPES.has(raw.type)) {
    throw new TiptapBlockNodeValidationError("replace.node 仅支持 paragraph、heading、codeBlock");
  }
  assertOnlyKeys(raw, NODE_KEYS, "replace.node");
  const type = raw.type as TiptapPatchJsonNode["type"];
  const attrs = validateAttrs(type, raw.attrs, expectedBlockId);
  const content = raw.content == null ? [] : raw.content;
  if (!Array.isArray(content) || content.length > 10_000) {
    throw new TiptapBlockNodeValidationError("replace.node.content 必须是受限数组");
  }

  const normalizedContent = content.map((child, index) => {
    const label = `replace.node.content[${index}]`;
    if (!isRecord(child) || typeof child.type !== "string") {
      throw new TiptapBlockNodeValidationError(`${label} 无效`);
    }
    assertOnlyKeys(child, INLINE_KEYS, label);
    if (child.type === "hardBreak") {
      if (type === "codeBlock" || child.text != null || child.marks != null) {
        throw new TiptapBlockNodeValidationError(`${label} 在当前块中无效`);
      }
      return { type: "hardBreak" as const };
    }
    if (child.type !== "text" || typeof child.text !== "string") {
      throw new TiptapBlockNodeValidationError(`${label} 仅支持 text/hardBreak`);
    }
    if (child.text.length > 1_000_000) {
      throw new TiptapBlockNodeValidationError(`${label}.text 过长`);
    }
    const marks = child.marks == null ? [] : child.marks;
    if (!Array.isArray(marks) || marks.length > 16) {
      throw new TiptapBlockNodeValidationError(`${label}.marks 无效`);
    }
    if (type === "codeBlock" && marks.length > 0) {
      throw new TiptapBlockNodeValidationError("codeBlock 不支持 inline marks");
    }
    const normalizedMarks = marks.map((mark, markIndex) => validateMark(mark, `${label}.marks[${markIndex}]`));
    return {
      type: "text" as const,
      text: child.text,
      ...(normalizedMarks.length > 0 ? { marks: normalizedMarks } : {}),
    };
  });

  const normalized: TiptapPatchJsonNode = {
    type,
    attrs,
    ...(normalizedContent.length > 0 ? { content: normalizedContent } : {}),
  };
  if (JSON.stringify(normalized).length > 256_000) {
    throw new TiptapBlockNodeValidationError("单个 replace.node 不能超过 256 KB");
  }
  return normalized;
}
