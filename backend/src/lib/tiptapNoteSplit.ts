export type TiptapSplitHeadingLevel = 1 | 2;

export interface TiptapSplitSection {
  index: number;
  title: string;
  headingLevel: TiptapSplitHeadingLevel;
  headingNode: Record<string, unknown>;
  contentNodes: Array<Record<string, unknown>>;
  fullNodes: Array<Record<string, unknown>>;
  sourceStartNode: number;
  sourceEndNode: number;
  sourceCharacters: number;
}

export interface TiptapSplitPlan {
  headingLevel: TiptapSplitHeadingLevel;
  document: Record<string, unknown>;
  preambleNodes: Array<Record<string, unknown>>;
  sections: TiptapSplitSection[];
  sourceCharacters: number;
}

export interface TiptapDirectorySection {
  index?: number;
  id: string;
  title: string;
}

export class TiptapSplitPlanError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
  }
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function collectNodeText(value: unknown, output: string[]): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectNodeText(item, output);
    return;
  }
  const node = value as Record<string, unknown>;
  if (node.type === "text" && typeof node.text === "string") output.push(node.text);
  if (node.type === "hardBreak") output.push("\n");
  if (Array.isArray(node.content)) collectNodeText(node.content, output);
}

function cleanTitle(node: Record<string, unknown>, fallbackIndex: number): string {
  const output: string[] = [];
  collectNodeText(node, output);
  const cleaned = output
    .join("")
    .replace(/\s+\^blk_[A-Za-z0-9_-]{6,}\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
  return (cleaned || `第 ${fallbackIndex + 1} 节`).slice(0, 200);
}

function parseDocument(serialized: string): {
  document: Record<string, unknown>;
  content: Array<Record<string, unknown>>;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized || "{}");
  } catch {
    throw new TiptapSplitPlanError("富文本内容不是有效 JSON", "INVALID_TIPTAP_JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TiptapSplitPlanError("富文本根节点无效", "INVALID_TIPTAP_DOCUMENT");
  }
  const doc = parsed as Record<string, unknown>;
  if (doc.type !== "doc" || !Array.isArray(doc.content)) {
    throw new TiptapSplitPlanError("富文本根节点必须是 doc 且包含 content 数组", "INVALID_TIPTAP_DOCUMENT");
  }
  const document = cloneJson(doc);
  delete document.content;
  return {
    document,
    content: cloneJson(doc.content as Array<Record<string, unknown>>),
  };
}

function isBoundary(node: Record<string, unknown>, headingLevel: TiptapSplitHeadingLevel): boolean {
  if (node.type !== "heading") return false;
  const attrs = node.attrs;
  if (!attrs || typeof attrs !== "object" || Array.isArray(attrs)) return false;
  return Number((attrs as Record<string, unknown>).level) === headingLevel;
}

export function planTiptapNoteSplit(
  serialized: string,
  headingLevel: TiptapSplitHeadingLevel,
): TiptapSplitPlan {
  const parsed = parseDocument(serialized);
  const boundaries: number[] = [];
  parsed.content.forEach((node, index) => {
    if (isBoundary(node, headingLevel)) boundaries.push(index);
  });

  const sections = boundaries.map((start, index) => {
    const end = boundaries[index + 1] ?? parsed.content.length;
    const headingNode = cloneJson(parsed.content[start]);
    const contentNodes = cloneJson(parsed.content.slice(start + 1, end));
    const fullNodes = cloneJson(parsed.content.slice(start, end));
    return {
      index,
      title: cleanTitle(headingNode, index),
      headingLevel,
      headingNode,
      contentNodes,
      fullNodes,
      sourceStartNode: start,
      sourceEndNode: end,
      sourceCharacters: JSON.stringify(fullNodes).length,
    } satisfies TiptapSplitSection;
  });

  return {
    headingLevel,
    document: parsed.document,
    preambleNodes: cloneJson(parsed.content.slice(0, boundaries[0] ?? parsed.content.length)),
    sections,
    sourceCharacters: serialized.length,
  };
}

export function validateTiptapSplitPlan(plan: TiptapSplitPlan): string | null {
  if (plan.sections.length < 2) return "至少需要两个同级顶层标题才能拆分";
  if (plan.sections.length > 200) return "单次最多拆分 200 个章节";
  if (plan.sections.some((section) => !section.title.trim())) return "章节标题不能为空";
  return null;
}

function textNode(text: string, marks?: Array<Record<string, unknown>>): Record<string, unknown> {
  return marks?.length ? { type: "text", text, marks } : { type: "text", text };
}

function paragraph(text: string): Record<string, unknown> {
  return { type: "paragraph", content: text ? [textNode(text)] : [] };
}

function noticeNode(text: string): Record<string, unknown> {
  return {
    type: "blockquote",
    content: [paragraph(text)],
  };
}

function directoryHeadingNode(level: TiptapSplitHeadingLevel): Record<string, unknown> {
  return {
    type: "heading",
    attrs: { level: Math.min(6, level + 1) },
    content: [textNode("目录")],
  };
}

function directoryListNode(sections: TiptapDirectorySection[]): Record<string, unknown> {
  return {
    type: "orderedList",
    attrs: { start: 1 },
    content: sections.map((section) => ({
      type: "listItem",
      content: [{
        type: "paragraph",
        content: [textNode(section.title, [{
          type: "link",
          attrs: {
            href: `note:${section.id}`,
            target: null,
            rel: "noopener noreferrer nofollow nowen-title-alias",
          },
        }])],
      }],
    })),
  };
}

function serializeDocument(
  document: Record<string, unknown>,
  content: Array<Record<string, unknown>>,
): string {
  return JSON.stringify({ ...cloneJson(document), type: "doc", content: cloneJson(content) });
}

export function serializeTiptapSection(
  plan: TiptapSplitPlan,
  section: TiptapSplitSection,
): string {
  return serializeDocument(plan.document, section.contentNodes);
}

export function buildTiptapSplitSource(options: {
  plan: TiptapSplitPlan;
  preservePreamble: boolean;
  sections: TiptapDirectorySection[];
  operationId: string;
}): string {
  // operationId is persisted in note_split_operations. Tiptap has no hidden comment node, so it
  // must not be rendered into the visible document merely to mirror Markdown's HTML marker.
  void options.operationId;
  const selected = new Set(options.sections.map((section) => section.index));
  const retained = options.plan.sections.filter((section) => !selected.has(section.index));
  const content: Array<Record<string, unknown>> = [];
  if (options.preservePreamble) content.push(...cloneJson(options.plan.preambleNodes));
  content.push(noticeNode(
    retained.length === 0
      ? `已按 H${options.plan.headingLevel} 拆分为 ${options.sections.length} 篇章节笔记。原始正文已保存在版本历史中，可在未继续编辑前撤销。`
      : `已将 ${options.sections.length}/${options.plan.sections.length} 个 H${options.plan.headingLevel} 章节拆分为独立笔记；未选择的 ${retained.length} 个章节继续保留在当前笔记中。`,
  ));
  content.push(directoryHeadingNode(options.plan.headingLevel));
  content.push(directoryListNode(options.sections));
  if (retained.length > 0) {
    content.push(noticeNode(`以下 ${retained.length} 个章节未拆分，仍可在当前笔记中继续编辑。`));
    for (const section of retained) content.push(...cloneJson(section.fullNodes));
  }
  return serializeDocument(options.plan.document, content);
}

export function collectTiptapBlockIds(nodes: Array<Record<string, unknown>>): string[] {
  const ids = new Set<string>();
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const node = value as Record<string, unknown>;
    const attrs = node.attrs;
    if (attrs && typeof attrs === "object" && !Array.isArray(attrs)) {
      const blockId = (attrs as Record<string, unknown>).blockId;
      if (typeof blockId === "string" && /^blk_[A-Za-z0-9_-]{6,}$/.test(blockId)) ids.add(blockId);
    }
    if (Array.isArray(node.content)) visit(node.content);
  };
  visit(nodes);
  return [...ids];
}
