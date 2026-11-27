// office/serializers/ir-to-tiptap.ts —— DocxIR → Tiptap JSON
//
// 补齐自研 Office 双向闭环：docx → parseDocx() → DocxIR → irToTiptap() → Tiptap JSON。
// 与 tiptap-to-ir.ts 共享同一套 DocxIR 语义，保留字号、字体、颜色、高亮、对齐、
// 首行缩进、块缩进、行距、多级列表、合并表格、分页符以及页面设置（尺寸/方向/边距/页眉页脚）。

import type {
  BlockNode,
  DocxIR,
  InlineNode,
  ParagraphNode,
  RunProps,
  Section,
  TableNode,
} from "../ir/document";

export interface TiptapJsonNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: TiptapJsonNode[];
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
  text?: string;
}

export interface IrToTiptapOptions {
  /**
   * 将 IR 中的图片 src（通常为 parseDocx 生成的 blob URL）转为持久地址（如附件 URL 或 data URL）。
   * 若返回 null，降级为可辨识文本占位，避免把失效 blob URL 持久化进笔记。
   */
  resolveImageSrc?: (src: string, alt?: string) => Promise<string | null>;
}

export interface IrToTiptapResult {
  doc: TiptapJsonNode;
  warnings: string[];
}

const PT_TO_PX = 96 / 72;

const HIGHLIGHT_TO_HEX: Record<string, string> = {
  yellow: "#fef08a",
  green: "#bbf7d0",
  cyan: "#a5f3fc",
  magenta: "#fbcfe8",
  blue: "#bfdbfe",
  red: "#fecaca",
  darkblue: "#bfdbfe",
  darkcyan: "#a5f3fc",
  darkgreen: "#bbf7d0",
  darkmagenta: "#ddd6fe",
  darkred: "#fecaca",
  darkyellow: "#fde68a",
  darkgray: "#e5e7eb",
  lightgray: "#f3f4f6",
  black: "#e5e7eb",
  white: "#ffffff",
};

function inferPaperSize(section: Section): {
  paperSize: "A4" | "A5" | "Letter";
  orientation: "portrait" | "landscape";
} {
  const w = section.pageSize?.w ?? 595;
  const h = section.pageSize?.h ?? 842;
  const orientation: "portrait" | "landscape" =
    section.orientation === "landscape" || w > h ? "landscape" : "portrait";
  const shortEdge = Math.min(w, h);
  const longEdge = Math.max(w, h);

  if (Math.abs(shortEdge - 420) <= 25 && Math.abs(longEdge - 595) <= 25) {
    return { paperSize: "A5", orientation };
  }
  if (Math.abs(shortEdge - 612) <= 20 && Math.abs(longEdge - 792) <= 25) {
    return { paperSize: "Letter", orientation };
  }
  return { paperSize: "A4", orientation };
}

function buildPageSetupNode(section: Section): TiptapJsonNode {
  const { paperSize, orientation } = inferPaperSize(section);
  const margins = section.margins ?? { top: 72, right: 72, bottom: 72, left: 72 };
  return {
    type: "wordPageSetup",
    attrs: {
      paperSize,
      orientation,
      marginTop: Math.round(margins.top),
      marginRight: Math.round(margins.right),
      marginBottom: Math.round(margins.bottom),
      marginLeft: Math.round(margins.left),
      headerText: section.headerText || "",
      footerText: section.footerText || "",
    },
  };
}

function ptToPxStr(pt: number): string {
  const px = Math.max(8, Math.min(96, Math.round(pt * PT_TO_PX)));
  return `${px}px`;
}

function buildRunMarks(
  props: RunProps | undefined,
  paraDefault: RunProps | undefined,
  linkHref?: string,
): Array<{ type: string; attrs?: Record<string, unknown> }> {
  const merged: RunProps = { ...(paraDefault ?? {}), ...(props ?? {}) };
  const marks: Array<{ type: string; attrs?: Record<string, unknown> }> = [];

  if (merged.bold) marks.push({ type: "bold" });
  if (merged.italic) marks.push({ type: "italic" });
  if (merged.underline) marks.push({ type: "underline" });
  if (merged.strike) marks.push({ type: "strike" });

  const textStyleAttrs: Record<string, unknown> = {};
  if (merged.color && merged.color !== "auto") {
    const hex = merged.color.replace(/^#/, "").trim();
    if (/^[0-9a-fA-F]{6}$/.test(hex)) {
      textStyleAttrs.color = `#${hex}`;
    }
  }
  if (merged.fontSize && merged.fontSize > 0) {
    textStyleAttrs.fontSize = ptToPxStr(merged.fontSize);
  }
  if (merged.fontFamily && merged.fontFamily.trim()) {
    textStyleAttrs.fontFamily = merged.fontFamily.trim();
  }
  if (Object.keys(textStyleAttrs).length > 0) {
    marks.push({ type: "textStyle", attrs: textStyleAttrs });
  }

  if (merged.highlight && merged.highlight !== "none") {
    const color = HIGHLIGHT_TO_HEX[merged.highlight.toLowerCase()] ?? "#fef08a";
    marks.push({ type: "highlight", attrs: { color } });
  }

  if (linkHref && !linkHref.startsWith("#")) {
    marks.push({
      type: "link",
      attrs: {
        href: linkHref,
        target: "_blank",
        rel: "noopener noreferrer nofollow",
      },
    });
  }
  return marks;
}

function appendTextWithHardBreaks(
  out: TiptapJsonNode[],
  text: string,
  marks: Array<{ type: string; attrs?: Record<string, unknown> }>,
): void {
  if (!text) return;
  const parts = text.split("\n");
  parts.forEach((segment, index) => {
    if (segment.length > 0) {
      out.push(marks.length > 0 ? { type: "text", text: segment, marks } : { type: "text", text: segment });
    }
    if (index < parts.length - 1) {
      out.push({ type: "hardBreak" });
    }
  });
}

async function convertInlines(
  inlines: InlineNode[],
  paraDefault: RunProps | undefined,
  opts: IrToTiptapOptions,
  warnings: Set<string>,
): Promise<TiptapJsonNode[]> {
  const nodes: TiptapJsonNode[] = [];
  for (const inline of inlines) {
    if (inline.type === "run") {
      const marks = buildRunMarks(inline.props, paraDefault);
      appendTextWithHardBreaks(nodes, inline.text, marks);
    } else if (inline.type === "hyperlink") {
      for (const run of inline.runs) {
        const marks = buildRunMarks(run.props, paraDefault, inline.href);
        appendTextWithHardBreaks(nodes, run.text, marks);
      }
    } else if (inline.type === "image") {
      let finalSrc: string | null = inline.src;
      if (opts.resolveImageSrc) {
        finalSrc = await opts.resolveImageSrc(inline.src, inline.alt);
      } else if (inline.src.startsWith("blob:")) {
        // 未提供解析器时，避免持久化失效 blob URL
        finalSrc = null;
      }
      if (finalSrc) {
        const attrs: Record<string, unknown> = { src: finalSrc };
        if (inline.alt) attrs.alt = inline.alt;
        if (inline.widthPt) attrs.width = Math.round(inline.widthPt * PT_TO_PX);
        if (inline.heightPt) attrs.height = Math.round(inline.heightPt * PT_TO_PX);
        nodes.push({ type: "image", attrs });
      } else {
        warnings.add("部分文档内嵌图片未能完成转存，已保留占位文本");
        nodes.push({ type: "text", text: inline.alt ? `[图片：${inline.alt}]` : "[图片]" });
      }
    }
  }
  return nodes;
}

function paragraphAttrsFromIr(para: ParagraphNode): Record<string, unknown> {
  const attrs: Record<string, unknown> = {};
  if (para.alignment) {
    attrs.textAlign = para.alignment;
  }
  if (para.indent) {
    if (!para.list && para.indent.left && para.indent.left >= 18) {
      attrs.indent = Math.max(1, Math.min(8, Math.round(para.indent.left / 24)));
    }
    if (
      (para.indent.firstLineChars && para.indent.firstLineChars >= 1.5) ||
      (para.indent.firstLine && para.indent.firstLine >= 18)
    ) {
      attrs.firstLineIndent = 2;
    }
  }
  if (para.spacing?.line && (!para.spacing.lineRule || para.spacing.lineRule === "auto")) {
    const rounded = Math.round(para.spacing.line * 100) / 100;
    if (rounded >= 1 && rounded <= 3) {
      attrs.lineHeight = String(rounded);
    }
  }
  return attrs;
}

async function convertParagraph(
  para: ParagraphNode,
  opts: IrToTiptapOptions,
  warnings: Set<string>,
): Promise<TiptapJsonNode> {
  const content = await convertInlines(para.runs, para.defaultRun, opts, warnings);
  const attrs = paragraphAttrsFromIr(para);
  if (para.headingLevel && para.headingLevel >= 1 && para.headingLevel <= 6) {
    return {
      type: "heading",
      attrs: { ...attrs, level: para.headingLevel },
      ...(content.length > 0 ? { content } : {}),
    };
  }
  return {
    type: "paragraph",
    ...(Object.keys(attrs).length > 0 ? { attrs } : {}),
    ...(content.length > 0 ? { content } : {}),
  };
}

async function convertTable(
  table: TableNode,
  opts: IrToTiptapOptions,
  warnings: Set<string>,
): Promise<TiptapJsonNode> {
  const rows: TiptapJsonNode[] = [];
  for (let rIdx = 0; rIdx < table.rows.length; rIdx++) {
    const row = table.rows[rIdx];
    const cells: TiptapJsonNode[] = [];
    for (const cell of row.cells) {
      const cellParagraphs: TiptapJsonNode[] = [];
      for (const p of cell.body) {
        cellParagraphs.push(await convertParagraph(p, opts, warnings));
      }
      if (cellParagraphs.length === 0) {
        cellParagraphs.push({ type: "paragraph" });
      }
      const isHeader = rIdx === 0 && Boolean(cell.shading);
      const attrs: Record<string, unknown> = {
        colspan: Math.max(1, cell.gridSpan || 1),
        rowspan: Math.max(1, cell.rowSpan || 1),
      };
      cells.push({
        type: isHeader ? "tableHeader" : "tableCell",
        attrs,
        content: cellParagraphs,
      });
    }
    if (cells.length > 0) {
      rows.push({ type: "tableRow", content: cells });
    }
  }

  const tableAttrs: Record<string, unknown> = {};
  if (table.alignment) tableAttrs.tableLayoutAlign = table.alignment;
  if (table.widthMode) tableAttrs.tableWidthMode = table.widthMode;

  return {
    type: "table",
    ...(Object.keys(tableAttrs).length > 0 ? { attrs: tableAttrs } : {}),
    content: rows.length > 0 ? rows : [{ type: "tableRow", content: [{ type: "tableCell", content: [{ type: "paragraph" }] }] }],
  };
}

/**
 * 将连续列表段落组装成规范嵌套的 bulletList / orderedList。
 */
async function convertBlocks(
  blocks: BlockNode[],
  opts: IrToTiptapOptions,
  warnings: Set<string>,
): Promise<TiptapJsonNode[]> {
  const out: TiptapJsonNode[] = [];
  let i = 0;
  while (i < blocks.length) {
    const block = blocks[i];
    if (block.type === "pageBreak") {
      out.push({ type: "pageBreak" });
      i += 1;
      continue;
    }
    if (block.type === "table") {
      out.push(await convertTable(block, opts, warnings));
      i += 1;
      continue;
    }
    if (block.list) {
      const listRuns: ParagraphNode[] = [];
      while (i < blocks.length) {
        const candidate = blocks[i];
        if (candidate.type === "paragraph" && candidate.list) {
          listRuns.push(candidate);
          i += 1;
        } else {
          break;
        }
      }
      const listNodes = await buildNestedLists(listRuns, opts, warnings);
      out.push(...listNodes);
      continue;
    }
    out.push(await convertParagraph(block, opts, warnings));
    i += 1;
  }
  return out;
}

async function buildNestedLists(
  items: ParagraphNode[],
  opts: IrToTiptapOptions,
  warnings: Set<string>,
): Promise<TiptapJsonNode[]> {
  const roots: TiptapJsonNode[] = [];
  const stack: Array<{ level: number; kind: "bulletList" | "orderedList"; listNode: TiptapJsonNode }> = [];

  for (const para of items) {
    const kind: "bulletList" | "orderedList" =
      para.list?.numFmt === "bullet" ? "bulletList" : "orderedList";
    const level = Math.max(0, Math.min(8, para.list?.ilvl ?? 0));
    const paraNode = await convertParagraph({ ...para, list: undefined }, opts, warnings);
    const listItem: TiptapJsonNode = { type: "listItem", content: [paraNode] };

    while (stack.length > 0 && stack[stack.length - 1].level > level) {
      stack.pop();
    }

    if (stack.length === 0) {
      const listNode: TiptapJsonNode = { type: kind, content: [listItem] };
      roots.push(listNode);
      stack.push({ level, kind, listNode });
      continue;
    }

    const top = stack[stack.length - 1];
    if (top.level === level) {
      if (top.kind === kind) {
        top.listNode.content!.push(listItem);
      } else {
        stack.pop();
        const listNode: TiptapJsonNode = { type: kind, content: [listItem] };
        if (stack.length === 0) {
          roots.push(listNode);
        } else {
          const parentItems = stack[stack.length - 1].listNode.content!;
          const parentItem = parentItems[parentItems.length - 1];
          parentItem.content!.push(listNode);
        }
        stack.push({ level, kind, listNode });
      }
    } else {
      // 更深一层：挂到父级最后一个 listItem 下
      const parentItems = top.listNode.content!;
      const parentItem = parentItems[parentItems.length - 1];
      const childList: TiptapJsonNode = { type: kind, content: [listItem] };
      parentItem.content!.push(childList);
      stack.push({ level, kind, listNode: childList });
    }
  }

  return roots;
}

export async function irToTiptap(
  ir: DocxIR,
  opts: IrToTiptapOptions = {},
): Promise<IrToTiptapResult> {
  const warnings = new Set<string>(ir.warnings ?? []);
  const sections = ir.sections?.length ? ir.sections : [{ body: [] } as Section];
  const primarySection = sections[0];
  const allBlocks: BlockNode[] = [];
  sections.forEach((sec, idx) => {
    if (idx > 0) allBlocks.push({ type: "pageBreak" });
    allBlocks.push(...(sec.body || []));
  });

  const bodyNodes = await convertBlocks(allBlocks, opts, warnings);
  const content: TiptapJsonNode[] = [
    buildPageSetupNode(primarySection),
    ...(bodyNodes.length > 0 ? bodyNodes : [{ type: "paragraph" }]),
  ];

  return {
    doc: { type: "doc", content },
    warnings: Array.from(warnings),
  };
}
