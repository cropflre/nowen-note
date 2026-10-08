/**
 * blockMenuActions —— 统一块菜单的编辑器命令层。
 *
 * 这些函数操作「当前块」（位置由激活时的 from 决定），与 SlashCommands 的插入命令解耦：
 *  - convertBlock   把当前块转化为 正文/标题/列表/引用/代码块/高亮/折叠块/分栏
 *  - deleteBlock    删除当前块（保证父容器非空，避免 schema 非法）
 *  - cutBlock       复制文本到剪贴板并删除当前块
 *  - addBelowBlock  在当前块下方插入空段落，返回新位置
 *
 * 分栏内（column）操作复用「只动最内层 textblock / 安全 replaceWith」策略，
 * 不触发 ProseMirror 的 lift，避免分栏结构解体（与 ColumnsExtension 的
 * safeToggleBlockTypeInColumn 思路一致）。
 */

import type { Editor } from "@tiptap/react";
import { TextSelection, Selection } from "@tiptap/pm/state";
import { Slice, Fragment } from "@tiptap/pm/model";
import { copyText } from "@/lib/clipboard";
import { sanitizeForPaste } from "@/lib/sanitizeHtml";

export type BlockTypeName =
  | "paragraph"
  | "heading"
  | "bulletList"
  | "orderedList"
  | "taskList"
  | "blockquote"
  | "codeBlock"
  | "callout"
  | "details"
  | "columns";

export interface BlockTarget {
  type: BlockTypeName;
  level?: number;
}

export interface LocatedBlock {
  node: import("@tiptap/pm/model").Node;
  start: number;
  end: number;
  depth: number;
  typeName: string;
  inColumn: boolean;
}

/** 定位光标 from 处所属的「操作目标块」。preferColumn=true 时若处于分栏内则返回 column 节点。 */
export function locateBlock(
  editor: Editor,
  from: number,
  opts?: { preferColumn?: boolean },
): LocatedBlock | null {
  const { state } = editor;
  if (from < 0 || from > state.doc.content.size) return null;
  const $pos = state.doc.resolve(from);
  const leaf = state.doc.nodeAt(from);
  if (leaf?.isBlock && leaf.isLeaf) {
    return { node: leaf, start: from, end: from + leaf.nodeSize, depth: $pos.depth + 1,
      typeName: leaf.type.name, inColumn: Array.from({ length: $pos.depth }, (_, i) => $pos.node(i + 1)).some((node) => node.type.name === "column") };
  }

  // 优先找最内层的 textblock（段落/标题/代码块等）
  let textDepth = $pos.depth;
  while (textDepth > 0 && !$pos.node(textDepth).isTextblock) textDepth--;
  if (textDepth === 0) {
    // 位置不在 textblock 内：拖拽柄激活时 from = 外层块起点 + 1，
    // 从 from 的祖先中找「起点 == from - 1」的那个块（列表/表格/图片/
    // 分栏/折叠块等）。否则这些块上的删除/复制/剪切会静默失败。
    // 注意用 start(d)（节点真正起点）而非 before(d)（首个块的 before 是 0）。
    const $r = state.doc.resolve(from);
    let d = $r.depth;
    while (d > 0) {
      const s = $r.start(d);
      if (s === from - 1) {
        // 情形B（旧）：from-1 是块起点 —— 列表/表格/图片等柄场景。
        break;
      }
      if (s === from) {
        // 情形A（新）：from 正好是某容器的 content 起点
        //   ——callout/details/columns 的柄在容器上时 from = before+1 = content 起点，
        //   旧兜底只认 from-1，此处返回 null，导致「高亮想转别的转不了」。
        //   仅当该节点是 doc/column 直接子块（顶层操作单元）时命中，
        //   避免把 listItem 等嵌套块误当操作单元（保持列表整块语义）。
        const parent = d > 0 ? $r.node(d - 1) : null;
        if (parent && (parent.type.name === "doc" || parent.type.name === "column")) break;
      }
      d--;
    }
    if (d > 0) textDepth = d;
    if (textDepth === 0) return null;
  }

  let depth = textDepth;
  if (opts?.preferColumn) {
    for (let d = textDepth; d >= 1; d--) {
      if ($pos.node(d).type.name === "column") {
        depth = d;
        break;
      }
    }
  }

  const node = $pos.node(depth);
  let inColumn = false;
  for (let d = $pos.depth; d >= 1; d--) {
    if ($pos.node(d).type.name === "column") {
      inColumn = true;
      break;
    }
  }

  return {
    node,
    start: $pos.before(depth),
    end: $pos.after(depth),
    depth,
    typeName: node.type.name,
    inColumn,
  };
}

/** 当前块类型信息，用于禁用「转化为」里已经相同的目标。 */
export function getBlockTypeAt(
  editor: Editor,
  from: number,
): { type: string; level?: number } | null {
  const info = locateTopBlock(editor, from);
  if (!info) return null;
  return { type: info.typeName, level: (info.node.attrs as { level?: number }).level };
}

/**
 * 定位「顶层块」：从光标处向上回溯，返回作为独立块操作单元的那个节点
 * （doc / column 的直接子块）。遇到 list / blockquote / callout / details / table 等
 * 结构性包裹节点时继续上溯，直到父节点是 doc 或 column 为止。
 *
 * 与 locateBlock（返回最内层 textblock）的区别：本函数把"整段列表/引用/容器"
 * 当成操作单元，保证「在下方添加」「当前类型判断」作用在正确层级，不会把新块
 * 插进列表项内部，也不会把列表项误判成段落。
 */
export function locateTopBlock(
  editor: Editor,
  from: number,
): LocatedBlock | null {
  const { state } = editor;
  if (from < 0 || from > state.doc.content.size) return null;
  const $pos = state.doc.resolve(from);
  const CONTAINERS = new Set(["doc", "column"]);
  const direct = state.doc.nodeAt(from);
  if (CONTAINERS.has($pos.parent.type.name) && direct?.isBlock) {
    return { node: direct, start: from, end: from + direct.nodeSize, depth: $pos.depth + 1,
      typeName: direct.type.name, inColumn: $pos.parent.type.name === "column" };
  }
  // 先落到 from 处最近的块节点（可能是最内层 textblock，也可能是 from 指向的块本身）
  let d = $pos.depth;
  while (d > 0 && !$pos.node(d).isBlock) d--;
  if (d === 0) return null;
  while (d > 1) {
    const parent = $pos.node(d - 1);
    if (CONTAINERS.has(parent.type.name)) break;
    d--;
  }
  const node = $pos.node(d);
  let inColumn = false;
  for (let dd = $pos.depth; dd >= 1; dd--) {
    if ($pos.node(dd).type.name === "column") {
      inColumn = true;
      break;
    }
  }
  return {
    node,
    start: $pos.before(d),
    end: $pos.after(d),
    depth: d,
    typeName: node.type.name,
    inColumn,
  };
}

/** Replace only the selected block; never lift a column or flatten media to text. */
export function convertBlock(editor: Editor, target: BlockTarget, from: number): boolean {
  if (!editor.isEditable) return false;
  let info = locateBlock(editor, from, { preferColumn: false });
  if (!info) return false;
  const anchored = editor.state.doc.resolve(from);
  const direct = editor.state.doc.nodeAt(from);
  if (anchored.parent.type.name === "column" && direct?.isBlock) {
    info = { node: direct, start: from, end: from + direct.nodeSize, depth: anchored.depth + 1, typeName: direct.type.name, inColumn: true };
  }
  if (info.node.type.name === "column" && info.node.firstChild) {
    const child = info.node.firstChild;
    info = { ...info, node: child, start: info.start + 1, end: info.start + 1 + child.nodeSize, depth: info.depth + 1, typeName: child.type.name };
  }
  if (target.type === "columns" && info.inColumn) return false;
  const $from = editor.state.doc.resolve(from);
  for (let depth = $from.depth; depth > 0; depth--) {
    if ($from.node(depth).type.name === target.type && (target.type === "callout" || target.type === "details")) return false;
  }
  const { node, start, end } = info;
  const { state, view } = editor;
  const schema = state.schema;
  const children = (parent: import("@tiptap/pm/model").Node) => {
    const result: import("@tiptap/pm/model").Node[] = [];
    parent.forEach((child) => result.push(child));
    return result;
  };
  const paragraph = (block: import("@tiptap/pm/model").Node) => schema.nodes.paragraph.create(block.attrs, block.content);
  const unpack = (block: import("@tiptap/pm/model").Node): import("@tiptap/pm/model").Node[] => {
    switch (block.type.name) {
      case "callout": case "blockquote": case "column": return children(block);
      case "details": {
        const summary = block.firstChild!;
        return [...(summary.content.size ? [paragraph(summary)] : []), ...children(block.child(1))];
      }
      case "column_container": return children(block).flatMap(children);
      case "bulletList": case "orderedList": case "taskList": return children(block).flatMap(children);
      default: return [block];
    }
  };
  const blocks = node.type.name === "mathBlock" && !node.attrs.latex ? [schema.nodes.paragraph.create()] : unpack(node);
  let replacement: import("@tiptap/pm/model").Node[];
  const sameType = node.type.name === target.type;
  if (target.type === "paragraph" || (sameType && ["bulletList", "orderedList", "taskList", "blockquote", "codeBlock"].includes(target.type))) {
    replacement = blocks.map((block) => block.isTextblock ? paragraph(block) : block);
  } else if (target.type === "heading") {
    replacement = blocks.map((block) => !block.isTextblock ? block
      : block.type.name === "heading" && block.attrs.level === (target.level ?? 1) ? paragraph(block)
      : schema.nodes.heading.create({ ...block.attrs, level: target.level ?? 1 }, block.content));
  } else if (target.type === "codeBlock") {
    // A code block cannot represent images, tables or multiple structured blocks.
    if (blocks.length !== 1 || !blocks[0].isTextblock) return false;
    let hasMedia = false;
    blocks[0].descendants((child) => { if (child.isLeaf && !child.isText && child.type.name !== "hardBreak") hasMedia = true; });
    if (hasMedia) return false;
    const text = blocks[0].textBetween(0, blocks[0].content.size, "\n", "\n");
    replacement = [schema.nodes.codeBlock.create({}, text ? schema.text(text) : undefined)];
  } else if (["bulletList", "orderedList", "taskList"].includes(target.type)) {
    const item = schema.nodes[target.type === "taskList" ? "taskItem" : "listItem"];
    const list = schema.nodes[target.type];
    if (!item || !list) return false;
    replacement = [list.create({}, blocks.map((block) => item.create({}, block.isTextblock ? [paragraph(block)] : [schema.nodes.paragraph.create(), block])))];
  } else if (target.type === "blockquote" || target.type === "callout") {
    if (sameType) return false;
    const type = schema.nodes[target.type];
    if (!type) return false;
    replacement = [type.create({}, blocks)];
  } else if (target.type === "details") {
    if (sameType) return false;
    if (!schema.nodes.details) return false;
    replacement = [schema.nodes.details.create({}, [schema.nodes.detailsSummary.create(), schema.nodes.detailsContent.create({}, blocks)])];
  } else if (target.type === "columns") {
    if (node.type.name === "column_container") return false;
    if (!schema.nodes.column_container) return false;
    replacement = [schema.nodes.column_container.create({}, [schema.nodes.column.create({}, blocks), schema.nodes.column.create({}, [schema.nodes.paragraph.create()])])];
  } else return false;
  try {
    replacement.forEach((block) => block.check());
    const tr = state.tr.replace(start, end, new Slice(Fragment.fromArray(replacement), 0, 0));
    tr.doc.check();
    if (tr.doc.eq(state.doc)) return node.isTextblock;
    tr.setSelection(Selection.near(tr.doc.resolve(Math.min(start + 1, tr.doc.content.size))));
    view.dispatch(tr);
    return true;
  } catch { return false; }
}


/**
 * 块操作定位兜底：优先用激活时传入的 from；若 from 已失效（文档被删除斜杠词等
 * 事务改动后位置漂移 / 拖拽柄 pos 为 -1 等），回退到当前光标位置再定位。
 * 保证删除/复制/剪切在 from 异常时不会静默失败。
 */
function resolveActionBlock(editor: Editor, from: number): LocatedBlock | null {
  const locate = (pos: number) => {
    if (pos >= 0 && pos <= editor.state.doc.content.size) {
      return locateBlock(editor, pos, { preferColumn: false });
    }
    return null;
  };
  const fromInfo = locate(from);
  if (fromInfo) return fromInfo;
  const selFrom = editor.state.selection.from;
  if (selFrom !== from) {
    const selInfo = locate(selFrom);
    if (selInfo) return selInfo;
  }
  return fromInfo; // 仍为 null 时返回 null（调用方静默忽略）
}

/** 删除当前块，保证父容器（doc / column）至少留一个空段落。 */
export function deleteBlock(editor: Editor, from: number): void {
  if (!editor.isEditable) return;
  const info = resolveActionBlock(editor, from);
  if (!info) return;
  const { state, view } = editor;

  const tr = state.tr.delete(info.start, info.end);
  const doc = tr.doc;
  const probe = Math.min(info.start, doc.content.size - 1);
  const $p = doc.resolve(probe > 0 ? probe : 0);
  const parentDepth = info.depth - 1;
  // 父容器（doc / column）被删空时补一个空段落，避免 schema 非法
  if (parentDepth >= 0 && $p.node(parentDepth).childCount === 0) {
    tr.insert($p.start(parentDepth), state.schema.nodes["paragraph"].create());
  }
  view.dispatch(tr);
  editor.commands.setTextSelection(Math.min(info.start, tr.doc.content.size - 1));
}

/**
 * 复制当前块到系统剪贴板（不改文档）。
 *
 * 关键修复：必须用「节点选择(NodeSelection)」选中整块，再走浏览器原生 copy
 * （document.execCommand("copy")，复用 ProseMirror 自身的 copy 管线）。
 *
 * 旧实现的错误：用 TextSelection 选中块的 before/after 边界——这两个位置不是合法
 * 文本位置，会被 ProseMirror 夹成「块内文字选区」，导致序列化只产出内联内容、缺少
 * 块级 data-pm-slice，于是 Ctrl+V 粘不出整块（甚至粘不出）。
 * NodeSelection + 原生 copy 写出的剪贴板数据与编辑器 Ctrl+C 完全一致（含块级
 * data-pm-slice），Ctrl+V 可原样还原整块（含高亮/折叠等自定义块）。
 *
 * 降级：原生 copy 失败时退化为纯文本 copyText（仍保留文字）。
 */
export async function copyBlock(editor: Editor, from: number, richTextOnly = false): Promise<boolean> {
  const info = resolveActionBlock(editor, from);
  if (!info) return false;
  const { start } = info;

  // 先记住原光标，复制后还原
  const prevFrom = editor.state.selection.from;
  const prevTo = editor.state.selection.to;

  // 用 NodeSelection 选中「整块」：start 即块节点的位置（before(depth)）
  try {
    editor.commands.focus(undefined, { scrollIntoView: false });
    editor.commands.setNodeSelection(start);
  } catch {
    return false;
  }

  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  } finally {
    // 还原光标，避免菜单打开时整段高亮残留
    try { editor.commands.setTextSelection({ from: prevFrom, to: prevTo }); } catch { /* ignore */ }
  }

  if (!ok) {
    if (richTextOnly) return false;
    // 极端降级：至少保留纯文本
    return copyText(info.node.textContent);
  }
  return true;
}

/**
 * 复制当前块（富文本）到剪贴板并删除（剪切）。
 * 只有富文本复制成功且文档未改变时才删除，避免丢失正文和嵌套媒体。
 */
export async function cutBlock(editor: Editor, from: number): Promise<boolean> {
  if (!editor.isEditable) return false;
  const info = resolveActionBlock(editor, from);
  if (!info) return false;
  const snapshot = editor.state.doc;
  if (!await copyBlock(editor, from, true)) return false;
  if (editor.isDestroyed || !editor.isEditable || !editor.state.doc.eq(snapshot)) return false;
  deleteBlock(editor, from);
  return true;
}

/**
 * 从系统剪贴板读取内容，粘贴到「我们点击的那一行」：
 *  - 空块  → 删除空块后把内容插到该位置（粘在点击行，而不是它的下一行）
 *  - 非空块 → 插到点击块「之前」（绝不插到「之后」，避免「粘到下一行」）
 * 优先富文本 HTML，降级纯文本。需浏览器授予 clipboard-read 权限（菜单点击属用户手势）。
 */
export async function pasteBlock(editor: Editor, from: number): Promise<boolean> {
  if (!editor.isEditable || typeof navigator === "undefined" || !navigator.clipboard) return false;
  const snapshot = editor.state.doc;
  let html = "";
  let text = "";
  try {
    const items = navigator.clipboard.read ? await navigator.clipboard.read() : [];
    for (const item of items) {
      if (item.types.includes("text/html")) {
        html = await (await item.getType("text/html")).text();
      } else if (item.types.includes("text/plain")) {
        text = await (await item.getType("text/plain")).text();
      }
    }
    if (!html && !text && navigator.clipboard.readText) text = await navigator.clipboard.readText();
  } catch {
    return false;
  }
  if (editor.isDestroyed || !editor.isEditable || !editor.state.doc.eq(snapshot)) return false;
  const content = html ? sanitizeForPaste(html) : text.split(/\r?\n/).map((line) => ({ type: "paragraph", content: line ? [{ type: "text", text: line }] : [] }));
  if (!html && !text) return false;
  if (html && typeof content === "string" && !content.trim()) return false;

  const info = resolveActionBlock(editor, from);
  // 始终作用于点击的那一行，而非它的下一行：
  //  - 空块：删掉空块，内容插到原位置 → 内容就在我们点击的那一行
  //  - 非空块：插到点击块「之前」→ 不会落到下一行
  if (!info) {
    // 兜底：解析失败时插到当前光标处
    return editor.chain().focus().insertContentAt(editor.state.selection.from, content).run();
  }
  const { start, end, node } = info;
  const isEmpty = node.isTextblock && node.content.size === 0;
  if (isEmpty) {
    return editor.chain().focus().insertContentAt({ from: start, to: end }, content).run();
  } else {
    return editor.chain().focus().insertContentAt(start, content).run();
  }
}

/** 当前块下方插入空段落，返回新位置（供「在下方添加」打开插入面板）。 */
export function addBelowBlock(editor: Editor, from: number): number | null {
  if (!editor.isEditable) return null;
  const info = resolveActionBlock(editor, from);
  if (!info) return null;
  const { state, view } = editor;

  const tr = state.tr.insert(info.end, state.schema.nodes["paragraph"].create());
  view.dispatch(tr);
  const newPos = Math.min(info.end + 1, tr.doc.content.size - 1);
  editor.commands.setTextSelection(newPos);
  return newPos;
}

/* ------------------------------------------------------------------ */
/*  缩进 / 减少缩进（listItem 升降级；非列表项不操作，安全无副作用）   */
/* ------------------------------------------------------------------ */

export function indentBlock(editor: Editor, from: number): boolean {
  if (!editor.isEditable) return false;
  const info = locateBlock(editor, from, { preferColumn: false });
  if (!info) return false;
  const { state, view } = editor;
  view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, Math.min(from + 1, state.doc.content.size - 1))));
  // sinkListItem 在非列表项上返回 false，safe
  return editor.commands.sinkListItem(info.typeName);
}

export function outdentBlock(editor: Editor, from: number): boolean {
  if (!editor.isEditable) return false;
  const info = locateBlock(editor, from, { preferColumn: false });
  if (!info) return false;
  const { state, view } = editor;
  view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, Math.min(from + 1, state.doc.content.size - 1))));
  return editor.commands.liftListItem(info.typeName);
}

/* ------------------------------------------------------------------ */
/*  addBlockBelow：「在下方添加」二级菜单选块类型时调用               */
/*  - 空段落直接替换；非空则在当前块后插入新节点                       */
/*  - 返回新节点起始位置（光标落在新节点内）                            */
/* ------------------------------------------------------------------ */

export type AddBelowType =
  | "paragraph"
  | "heading1"
  | "heading2"
  | "heading3"
  | "heading4"
  | "heading5"
  | "heading6"
  | "bulletList"
  | "orderedList"
  | "taskList"
  | "blockquote"
  | "codeBlock"
  | "details"
  | "callout"
  | "columns"
  | "table"
  | "math"
  | "mermaid"
  | "horizontalRule";

/** 根据 AddBelowType 构建可插入的节点。 */
function buildBelowNode(
  schema: import("@tiptap/pm/model").Schema,
  type: AddBelowType,
): import("@tiptap/pm/model").Node | null {
  const paragraph = () => schema.nodes["paragraph"].create();
  switch (type) {
    case "paragraph":
      return paragraph();
    case "heading1":
      return schema.nodes["heading"].create({ level: 1 });
    case "heading2":
      return schema.nodes["heading"].create({ level: 2 });
    case "heading3":
      return schema.nodes["heading"].create({ level: 3 });
    case "heading4":
      return schema.nodes["heading"].create({ level: 4 });
    case "heading5":
      return schema.nodes["heading"].create({ level: 5 });
    case "heading6":
      return schema.nodes["heading"].create({ level: 6 });
    case "bulletList": {
      const listItem = schema.nodes["listItem"];
      return schema.nodes["bulletList"].create({}, [listItem.create({}, [paragraph()])]);
    }
    case "orderedList": {
      const listItem = schema.nodes["listItem"];
      return schema.nodes["orderedList"].create({}, [listItem.create({}, [paragraph()])]);
    }
    case "taskList": {
      const taskItem = schema.nodes["taskItem"];
      return schema.nodes["taskList"].create({}, [taskItem.create({ checked: false }, [paragraph()])]);
    }
    case "blockquote":
      return schema.nodes["blockquote"].create({}, [paragraph()]);
    case "codeBlock":
      return schema.nodes["codeBlock"].create();
    case "details": {
      const summary = schema.nodes["detailsSummary"];
      const content = schema.nodes["detailsContent"];
      return schema.nodes["details"].create({}, [summary.create(), content.create({}, [paragraph()])]);
    }
    case "callout":
      return schema.nodes["callout"].create({ type: "blue" }, [paragraph()]);
    case "columns": {
      const col = schema.nodes["column"];
      return schema.nodes["column_container"].create(
        {},
        [
          col.create({ colWidth: null }, [paragraph()]),
          col.create({ colWidth: null }, [paragraph()]),
        ],
      );
    }
    case "table": {
      const row = schema.nodes["tableRow"];
      const cell = schema.nodes["tableCell"];
      const headerCell = schema.nodes["tableHeader"];
      const headerRow = row.create({}, [headerCell.create({}, [paragraph()]), headerCell.create({}, [paragraph()]), headerCell.create({}, [paragraph()])]);
      const bodyRows = [1, 2].map(() =>
        row.create({}, [cell.create({}, [paragraph()]), cell.create({}, [paragraph()]), cell.create({}, [paragraph()])]),
      );
      return schema.nodes["table"].create({}, [headerRow, ...bodyRows]);
    }
    case "math":
      return schema.nodes["mathBlock"].create({ latex: "" });
    case "mermaid": {
      const sample = "graph TD\n  A[开始] --> B{判断}\n  B -->|是| C[继续]\n  B -->|否| D[结束]";
      return schema.nodes["codeBlock"].create({ language: "mermaid" }, schema.text(sample));
    }
    case "horizontalRule":
      return schema.nodes["horizontalRule"].create();
  }
}

export function addBlockBelow(
  editor: Editor,
  type: AddBelowType,
  from: number,
): number | null {
  if (!editor.isEditable) return null;
  // 用「顶层块」定位：列表/引用/容器的操作单元是整段，插入位置算到整段之后，
  // 而不是嵌套进列表项内部。
  const info = locateTopBlock(editor, from);
  if (!info) return null;
  const { state, view } = editor;
  const node = buildBelowNode(state.schema, type);
  if (!node) return null;

  const isEmpty = info.node.isTextblock && info.node.content.size === 0;
  let tr: import("@tiptap/pm/state").Transaction;
  let anchor: number;
  if (isEmpty) {
    // 空段落（如刚打 `/` 的占位行）：直接替换
    tr = state.tr.replaceWith(info.start, info.end, node);
    anchor = info.start + 1;
  } else {
    // 非空：在当前块之后插入新节点
    tr = state.tr.insert(info.end, node);
    anchor = info.end + 1;
  }
  tr.setSelection(Selection.near(tr.doc.resolve(Math.min(anchor, tr.doc.content.size))));
  view.dispatch(tr);
  return Math.min(anchor, tr.doc.content.size - 1);
}
