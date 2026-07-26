import type { Editor } from "@tiptap/core";
import type { Mark, MarkType, Node as ProseMirrorNode, NodeType } from "@tiptap/pm/model";
import { CellSelection } from "@tiptap/pm/tables";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import { isValidFontSize } from "@/components/FontSizeExtension";
import { isValidLineHeight } from "@/components/LineHeightExtension";

const BOOLEAN_MARK_NAMES = ["bold", "italic", "underline", "strike"] as const;
type BooleanMarkName = (typeof BOOLEAN_MARK_NAMES)[number];

type TextAlignValue = "left" | "center" | "right" | "justify";
type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

export type CapturedTextFormat = {
  marks: Record<BooleanMarkName, boolean> & {
    fontSize: string | null;
    color: string | null;
    highlight: string | null;
  };
  block: {
    textAlign: TextAlignValue | null;
    lineHeight: string | null;
    nodeType: "paragraph" | "heading";
    headingLevel?: HeadingLevel;
  } | null;
};

export type FormatPainterResult =
  | { ok: true; format?: CapturedTextFormat; degraded?: boolean }
  | { ok: false; reason: "readonly" | "empty-selection" | "no-text" | "unsupported-selection" };

type TextSegment = {
  from: number;
  to: number;
  node: ProseMirrorNode;
  parent: ProseMirrorNode;
};

function isValidAlpha(raw: string | undefined): boolean {
  if (raw === undefined) return true;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

/**
 * Accept only bounded literal colors. CSS variables, url(), calc() and arbitrary
 * style fragments are deliberately rejected so imported content cannot turn the
 * painter into an inline-style injection path.
 */
export function normalizeSafeFormatColor(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim().toLowerCase();
  if (!value || value.length > 64) return null;
  if (value === "transparent") return value;
  if (/^#[0-9a-f]{3,4}$/.test(value) || /^#[0-9a-f]{6}([0-9a-f]{2})?$/.test(value)) {
    return value;
  }

  const rgb = value.match(
    /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*(0|1|0?\.\d+))?\s*\)$/,
  );
  if (rgb) {
    const channels = rgb.slice(1, 4).map(Number);
    if (channels.every((channel) => channel >= 0 && channel <= 255) && isValidAlpha(rgb[4])) {
      return value;
    }
    return null;
  }

  const hsl = value.match(
    /^hsla?\(\s*(-?\d{1,3}(?:\.\d+)?)\s*,\s*(\d{1,3}(?:\.\d+)?)%\s*,\s*(\d{1,3}(?:\.\d+)?)%(?:\s*,\s*(0|1|0?\.\d+))?\s*\)$/,
  );
  if (hsl) {
    const saturation = Number(hsl[2]);
    const lightness = Number(hsl[3]);
    if (saturation <= 100 && lightness <= 100 && isValidAlpha(hsl[4])) return value;
  }

  return null;
}

function normalizeTextAlign(raw: unknown): TextAlignValue | null {
  return raw === "left" || raw === "center" || raw === "right" || raw === "justify"
    ? raw
    : null;
}

function findMark(marks: readonly Mark[], name: string): Mark | undefined {
  return marks.find((mark) => mark.type.name === name);
}

function collectTextSegments(editor: Editor, from: number, to: number): TextSegment[] {
  const segments: TextSegment[] = [];
  editor.state.doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isText || node.nodeSize <= 0) return true;
    const start = Math.max(from, pos);
    const end = Math.min(to, pos + node.nodeSize);
    if (start >= end) return false;
    const parent = editor.state.doc.resolve(start).parent;
    segments.push({ from: start, to: end, node, parent });
    return false;
  });
  return segments;
}

function collectSimpleTextBlocks(editor: Editor, from: number, to: number): Map<number, ProseMirrorNode> {
  const blocks = new Map<number, ProseMirrorNode>();
  const supported = new Set(["paragraph", "heading"]);

  editor.state.doc.nodesBetween(from, to, (node, pos) => {
    if (supported.has(node.type.name)) blocks.set(pos, node);
    return true;
  });

  for (const $pos of [editor.state.doc.resolve(from), editor.state.doc.resolve(to)]) {
    for (let depth = $pos.depth; depth > 0; depth -= 1) {
      const node = $pos.node(depth);
      if (!supported.has(node.type.name)) continue;
      blocks.set($pos.before(depth), node);
      break;
    }
  }

  return blocks;
}

function firstRepresentativeText(segments: TextSegment[]): ProseMirrorNode | null {
  const nonWhitespace = segments.find(({ node }) => Boolean(node.text?.trim()));
  return nonWhitespace?.node ?? segments[0]?.node ?? null;
}

function allowedAttrs(type: NodeType, attrs: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const specAttrs = type.spec.attrs ?? {};
  for (const key of Object.keys(specAttrs)) {
    if (Object.prototype.hasOwnProperty.call(attrs, key)) result[key] = attrs[key];
  }
  return result;
}

function canApplyMark(parent: ProseMirrorNode, markType: MarkType | undefined): markType is MarkType {
  return Boolean(markType && parent.type.allowsMarkType(markType));
}

export function captureTextFormat(editor: Editor): FormatPainterResult {
  if (!editor.isEditable) return { ok: false, reason: "readonly" };
  const { selection } = editor.state;
  if (selection instanceof NodeSelection || selection instanceof CellSelection) {
    return { ok: false, reason: "unsupported-selection" };
  }
  if (!(selection instanceof TextSelection) || selection.empty) {
    return { ok: false, reason: "empty-selection" };
  }

  const segments = collectTextSegments(editor, selection.from, selection.to);
  const representative = firstRepresentativeText(segments);
  if (!representative) return { ok: false, reason: "no-text" };

  const textStyle = findMark(representative.marks, "textStyle");
  const highlight = findMark(representative.marks, "highlight");
  const blocks = collectSimpleTextBlocks(editor, selection.from, selection.to);
  const singleBlock = blocks.size === 1 ? [...blocks.values()][0] : null;

  let block: CapturedTextFormat["block"] = null;
  if (singleBlock) {
    const lineHeight = typeof singleBlock.attrs?.lineHeight === "string"
      && isValidLineHeight(singleBlock.attrs.lineHeight)
      ? singleBlock.attrs.lineHeight
      : null;
    const textAlign = normalizeTextAlign(singleBlock.attrs?.textAlign);
    if (singleBlock.type.name === "heading") {
      const rawLevel = Number(singleBlock.attrs?.level);
      const headingLevel = rawLevel >= 1 && rawLevel <= 6 ? rawLevel as HeadingLevel : 1;
      block = { nodeType: "heading", headingLevel, textAlign, lineHeight };
    } else {
      block = { nodeType: "paragraph", textAlign, lineHeight };
    }
  }

  const format: CapturedTextFormat = {
    marks: {
      bold: Boolean(findMark(representative.marks, "bold")),
      italic: Boolean(findMark(representative.marks, "italic")),
      underline: Boolean(findMark(representative.marks, "underline")),
      strike: Boolean(findMark(representative.marks, "strike")),
      fontSize: typeof textStyle?.attrs?.fontSize === "string" && isValidFontSize(textStyle.attrs.fontSize)
        ? textStyle.attrs.fontSize
        : null,
      color: normalizeSafeFormatColor(textStyle?.attrs?.color),
      highlight: normalizeSafeFormatColor(highlight?.attrs?.color),
    },
    block,
  };

  return { ok: true, format, degraded: blocks.size !== 1 };
}

export function applyCapturedTextFormat(editor: Editor, format: CapturedTextFormat): FormatPainterResult {
  if (!editor.isEditable) return { ok: false, reason: "readonly" };
  const { selection, schema } = editor.state;
  if (selection instanceof NodeSelection || selection instanceof CellSelection) {
    return { ok: false, reason: "unsupported-selection" };
  }
  if (!(selection instanceof TextSelection) || selection.empty) {
    return { ok: false, reason: "empty-selection" };
  }

  const segments = collectTextSegments(editor, selection.from, selection.to);
  if (segments.length === 0) return { ok: false, reason: "no-text" };

  const tr = editor.state.tr;
  const textStyleType = schema.marks.textStyle;
  const highlightType = schema.marks.highlight;

  for (const segment of segments) {
    for (const name of BOOLEAN_MARK_NAMES) {
      const type = schema.marks[name];
      if (!type) continue;
      tr.removeMark(segment.from, segment.to, type);
      if (format.marks[name] && canApplyMark(segment.parent, type)) {
        tr.addMark(segment.from, segment.to, type.create());
      }
    }

    if (highlightType) {
      tr.removeMark(segment.from, segment.to, highlightType);
      if (format.marks.highlight && canApplyMark(segment.parent, highlightType)) {
        tr.addMark(segment.from, segment.to, highlightType.create({ color: format.marks.highlight }));
      }
    }

    if (textStyleType) {
      const existing = findMark(segment.node.marks, "textStyle");
      const nextAttrs: Record<string, unknown> = { ...(existing?.attrs ?? {}) };
      delete nextAttrs.fontSize;
      delete nextAttrs.color;
      if (format.marks.fontSize) nextAttrs.fontSize = format.marks.fontSize;
      if (format.marks.color) nextAttrs.color = format.marks.color;
      for (const [key, value] of Object.entries(nextAttrs)) {
        if (value === null || value === undefined || value === "") delete nextAttrs[key];
      }
      tr.removeMark(segment.from, segment.to, textStyleType);
      if (Object.keys(nextAttrs).length > 0 && canApplyMark(segment.parent, textStyleType)) {
        tr.addMark(segment.from, segment.to, textStyleType.create(nextAttrs));
      }
    }
  }

  const targetBlocks = collectSimpleTextBlocks(editor, selection.from, selection.to);
  const canConvertNodeType = targetBlocks.size === 1;
  let degraded = targetBlocks.size !== 1;
  targetBlocks.forEach((node, pos) => {
    const sourceBlock = format.block;
    if (!sourceBlock) return;

    let nextType = node.type;
    let nextAttrs: Record<string, unknown> = { ...node.attrs };
    nextAttrs.textAlign = sourceBlock.textAlign;
    nextAttrs.lineHeight = sourceBlock.lineHeight;

    if (canConvertNodeType) {
      const desiredType = schema.nodes[sourceBlock.nodeType];
      if (desiredType) {
        if (desiredType === node.type) {
          nextType = desiredType;
          if (sourceBlock.nodeType === "heading") nextAttrs.level = sourceBlock.headingLevel ?? 1;
        } else {
          const $pos = tr.doc.resolve(pos);
          const parent = $pos.parent;
          const index = $pos.index();
          const validReplacement = desiredType.validContent(node.content)
            && parent.canReplaceWith(index, index + 1, desiredType);
          if (validReplacement) {
            nextType = desiredType;
            if (sourceBlock.nodeType === "heading") nextAttrs.level = sourceBlock.headingLevel ?? 1;
          } else {
            degraded = true;
          }
        }
      } else {
        degraded = true;
      }
    }

    nextAttrs = allowedAttrs(nextType, nextAttrs);
    tr.setNodeMarkup(pos, nextType, nextAttrs, node.marks);
  });

  if (!tr.docChanged) return { ok: true, degraded };
  tr.setMeta("formatPainter", true);
  editor.view.dispatch(tr.scrollIntoView());
  return { ok: true, degraded };
}
