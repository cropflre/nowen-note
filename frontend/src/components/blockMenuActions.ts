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
import { TextSelection } from "@tiptap/pm/state";
import { Slice } from "@tiptap/pm/model";
import { copyText } from "@/lib/clipboard";

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

/** 在分栏内构建容器节点（callout / details）。支持任意内节点（含 image/table 等非文本块）。 */
function buildColumnContainer(
  editor: Editor,
  type: "callout" | "details",
  innerBlock: import("@tiptap/pm/model").Node,
) {
  const schema = editor.state.schema;
  if (type === "callout") {
    const callout = schema.nodes["callout"];
    return callout.create({}, [innerBlock]);
  }
  const details = schema.nodes["details"];
  const summary = schema.nodes["detailsSummary"];
  const content = schema.nodes["detailsContent"];
  return details.create({}, [summary.create(), content.create([innerBlock])]);
}

/**
 * 计算容器解包后的替换内容：
 * - details 结构是 [detailsSummary, detailsContent[block+]]，内容主体在 detailsContent，
 *   直接取 firstChild 会只剩 summary 标题行、正文丢失 → 展开 detailsContent 全部子块。
 * - callout 等其它容器取首个子节点（文本块或 image/table 等非文本块）。
 * - 容器为空时退回空段落。
 */
function unwrapContainerNode(
  schema: import("@tiptap/pm/model").Schema,
  cn: import("@tiptap/pm/model").Node,
): import("@tiptap/pm/model").Node | Slice {
  if (cn.type.name === "details" && cn.childCount > 1) {
    const body = cn.child(1); // detailsContent
    if (body.childCount > 0) return new Slice(body.content, 0, 0);
  }
  const firstChild = cn.firstChild;
  if (firstChild) return firstChild;
  return schema.nodes["paragraph"].create();
}

/** 按替换内容类型分发：多块 Slice 用 tr.replace（replaceWith 不接受多块 Slice）。 */
function replaceRange(
  tr: import("@tiptap/pm/state").Transaction,
  start: number,
  end: number,
  content: import("@tiptap/pm/model").Node | Slice,
): void {
  if (content instanceof Slice) tr.replace(start, end, content);
  else tr.replaceWith(start, end, content);
}

/** 顶层块转化为容器（callout / details / columns）。支持任意源节点（含 image/table/math 等非文本块）。 */
function wrapInContainer(
  editor: Editor,
  target: BlockTarget,
  start: number,
  end: number,
): boolean {
  const { state, view } = editor;
  const schema = state.schema;
  // start 是顶层块的 before 位置，紧跟其后的节点即待包裹的块（可能是 image/table 等非文本块）
  const blockNode = state.doc.nodeAt(start + 1) ?? state.doc.resolve(start).nodeAfter;
  if (!blockNode) return false;

  let containerNode: import("@tiptap/pm/model").Node | null = null;
  if (target.type === "callout") {
    containerNode = schema.nodes["callout"].create({}, [blockNode]);
  } else if (target.type === "details") {
    containerNode = schema.nodes["details"].create(
      {},
      [
        schema.nodes["detailsSummary"].create(),
        schema.nodes["detailsContent"].create([blockNode]),
      ],
    );
  } else if (target.type === "columns") {
    const colType = schema.nodes["column"];
    const para = schema.nodes["paragraph"];
    containerNode = schema.nodes["column_container"].create(
      {},
      [
        colType.create({ colWidth: null }, [blockNode]),
        colType.create({ colWidth: null }, [para.create()]),
      ],
    );
  }
  if (!containerNode) return false;

  const tr = state.tr.replaceWith(start, end, containerNode);
  try {
    tr.setSelection(TextSelection.create(tr.doc, Math.min(start + 2, tr.doc.content.size - 1)));
  } catch {
    /* ignore */
  }
  view.dispatch(tr);
  return true;
}

/**
 * 将任意节点转为段落（提取文本内容）。
 * - 文本块 → 段落（保留内容）
 * - 非文本块（image/table/math 等）→ 空段落或包含其文本描述的段落
 */
function nodeToParagraph(
  schema: import("@tiptap/pm/model").Schema,
  node: import("@tiptap/pm/model").Node,
): import("@tiptap/pm/model").Node {
  if (node.type.name === "paragraph") return node;
  if (node.isTextblock) return schema.nodes["paragraph"].create(null, node.content);
  // 非文本块：尝试提取文本内容
  const text = node.textContent;
  return schema.nodes["paragraph"].create(null, text ? schema.text(text) : undefined);
}

/** 顶层块转化：把当前块变成目标类型（含从 callout/details 解包）。支持非文本块（image/table/math 等）。 */
export function convertBlock(editor: Editor, target: BlockTarget, from: number): boolean {
  // 用 let：unwrapContainer 会 dispatch 改变文档，之后必须重新取 editor.state，
  // 否则继续用过期 state.tr 会抛 "Applying a mismatched transaction"
  // （例如 callout 内「段落→段落」）。
  let { state, view } = editor;
  if (from < 0 || from > state.doc.content.size) return false;

  const info = locateBlock(editor, from, { preferColumn: false });
  if (!info) return false;
  if (info.inColumn) return convertInColumn(editor, target, from);

  const $pos = state.doc.resolve(from);

  // 当前块是否包在 callout / details 容器里
  let containerDepth = -1;
  let containerName = "";
  for (let d = $pos.depth; d >= 1; d--) {
    const n = $pos.node(d);
    if (n.type.name === "callout" || n.type.name === "details") {
      containerName = n.type.name;
      containerDepth = d;
      break;
    }
  }

  const isContainerTarget = target.type === "callout" || target.type === "details" || target.type === "columns";

  // 解包容器为段落（保留首个子节点的内容）
  const unwrapContainer = () => {
    if (containerDepth < 0) return;
    const cStart = $pos.before(containerDepth);
    const cEnd = $pos.after(containerDepth);
    const cn = $pos.node(containerDepth);
    // details 结构是 [detailsSummary, detailsContent[block+]]：内容主体在
    // detailsContent 里，直接取 firstChild 会只剩 summary 标题行、正文丢失。
    // 展开 detailsContent 的所有子块到文档层；callout 等其它容器取首个子节点
    // （不管是文本块还是 image/table 等非文本块）。
    if (cn.type.name === "details" && cn.childCount > 1) {
      const body = cn.child(1); // detailsContent
      if (body.childCount > 0) {
        replaceRange(state.tr, cStart, cEnd, new Slice(body.content, 0, 0));
        return;
      }
    }
    const firstChild = cn.firstChild;
    if (firstChild) {
      replaceRange(state.tr, cStart, cEnd, firstChild);
    } else {
      replaceRange(state.tr, cStart, cEnd, state.schema.nodes["paragraph"].create());
    }
  };

  // ---- 目标是容器（callout / details / columns）----
  if (isContainerTarget) {
    if (containerName === target.type) return false; // 已是该容器 → 解包
    if (containerDepth >= 0) { unwrapContainer(); state = editor.state; }
    // 重新定位（解包后文档变了）；容器目标按「顶层块」定位，避免把列表/容器
    // 的内层段落单独包进容器而破坏外层结构
    const info2 = locateTopBlock(editor, Math.min(from, editor.state.doc.content.size - 1));
    if (!info2) return false;
    return wrapInContainer(editor, target, info2.start, info2.end);
  }

  // ---- 目标是基本块（paragraph / heading / list / blockquote / codeBlock）----

  // 先解包容器（如果在里面）
  if (containerDepth >= 0) { unwrapContainer(); state = editor.state; }

  // 重新定位（解包后文档可能变了）
  const info3 = locateBlock(editor, Math.min(from, editor.state.doc.content.size - 1), {
    preferColumn: false,
  });
  if (!info3) return false;

  const currentNode = info3.node;
  const { start: blockStart, end: blockEnd } = info3;

  // 如果当前节点就是目标类型（标题检查等级）→ 转回正文
  const typeMap: Record<string, string> = {
    heading: "heading", bulletList: "bulletList", orderedList: "orderedList",
    taskList: "taskList", blockquote: "blockquote", codeBlock: "codeBlock",
  };
  const targetSchemaName = typeMap[target.type] ?? target.type;
  if (currentNode.type.name === targetSchemaName) {
    if (target.type === "heading") {
      const level = target.level ?? 1;
      if ((currentNode.attrs as { level?: number }).level === level) {
        // 同级标题 → 转正文
        const para = nodeToParagraph(state.schema, currentNode);
        view.dispatch(state.tr.replaceWith(blockStart, blockEnd, para));
        return true;
      }
      // 不同级 → 改等级
      view.dispatch(state.tr.setNodeMarkup(blockStart, undefined, { level: target.level ?? 1 }));
      return true;
    }
    // 同类型非标题 → 转正文
    const para = nodeToParagraph(state.schema, currentNode);
    view.dispatch(state.tr.replaceWith(blockStart, blockEnd, para));
    return true;
  }

  // 用 clearNodes + toggle 处理文本块互转（paragraph ↔ heading/list/blockquote/codeBlock）
  if (currentNode.isTextblock) {
    const chain = editor
      .chain()
      .focus()
      .setTextSelection(Math.min(blockStart + 1, state.doc.content.size - 1))
      .clearNodes();
    switch (target.type) {
      case "paragraph": break;
      case "heading": chain.setNode("heading", { level: target.level ?? 1 }); break;
      case "bulletList": chain.toggleBulletList(); break;
      case "orderedList": chain.toggleOrderedList(); break;
      case "taskList": chain.toggleTaskList(); break;
      case "blockquote": chain.toggleBlockquote(); break;
      case "codeBlock": chain.toggleCodeBlock(); break;
    }
    chain.run();
    return true;
  }

  // 非文本块（image/table/math 等）→ 转为目标基本块
  // 策略：提取文本内容，构建目标节点
  const para = nodeToParagraph(state.schema, currentNode);
  const schema = state.schema;
  let newNode: import("@tiptap/pm/model").Node | null = null;
  switch (target.type) {
    case "paragraph":
      newNode = para;
      break;
    case "heading":
      newNode = schema.nodes["heading"].create({ level: target.level ?? 1 }, para.content);
      break;
    case "bulletList": {
      const li = schema.nodes["listItem"].create({}, [para]);
      newNode = schema.nodes["bulletList"].create({}, [li]);
      break;
    }
    case "orderedList": {
      const li = schema.nodes["listItem"].create({}, [para]);
      newNode = schema.nodes["orderedList"].create({}, [li]);
      break;
    }
    case "taskList": {
      const ti = schema.nodes["taskItem"].create({ checked: false }, [para]);
      newNode = schema.nodes["taskList"].create({}, [ti]);
      break;
    }
    case "blockquote":
      newNode = schema.nodes["blockquote"].create({}, [para]);
      break;
    case "codeBlock":
      newNode = schema.nodes["codeBlock"].create({}, para.textContent ? schema.text(para.textContent) : undefined);
      break;
  }
  if (!newNode) return false;
  view.dispatch(state.tr.replaceWith(blockStart, blockEnd, newNode));
  return true;
}

/**
 * 在分栏内稳健定位「当前块」（文本块或叶子/容器非文本块）。
 *
 * 关键：当 `from` 落在空文本块 / 非文本块（图片、公式、表格等）边界时，
 * ProseMirror 会把 `$pos` 解析到 column / column_container 层（而非块内层），
 * 此时若按 `$pos.depth` 递减找文本块会得到 textDepth === 0，再 `$pos.before(0)`
 * 直接抛 "There is no position before the top-level node" —— 表现为「空文本无法转换」。
 * 这里在解析点不在文本块内时改取紧随 `from` 之后的块（nodeAt），兼容空块边界。
 */
function resolveColumnInnerBlock(
  editor: Editor,
  from: number,
): { node: import("@tiptap/pm/model").Node; blockStart: number; blockEnd: number; parentDepth: number } | null {
  const { state } = editor;
  if (from < 0 || from > state.doc.content.size) return null;
  const $from = state.doc.resolve(from);

  let depth = $from.depth;
  let node = $from.node(depth);
  if (node.isTextblock) {
    return { node, blockStart: $from.before(depth), blockEnd: $from.after(depth), parentDepth: depth - 1 };
  }

  // 边界情况：解析点落在 column 等容器层（空文本块 / 非文本块边界）。
  // 取紧随 from 之后的块作为操作目标（空段落 / 图片 / 公式 / 表格 / 折叠块等）。
  const after = state.doc.nodeAt(from);
  if (after && after.isBlock) {
    return { node: after, blockStart: from, blockEnd: from + after.nodeSize, parentDepth: depth };
  }

  // 兜底：向下找第一个文本块子孙
  for (let d = depth; d >= 1; d--) {
    if ($from.node(d).isTextblock) {
      return { node: $from.node(d), blockStart: $from.before(d), blockEnd: $from.after(d), parentDepth: d - 1 };
    }
  }
  return null;
}

/** 分栏内的块转化（安全 replaceWith，不破坏 column 结构）。支持非文本块（image/table 等）。 */
function convertInColumn(editor: Editor, target: BlockTarget, from: number): boolean {
  const { state, view } = editor;
  const schema = state.schema;

  const located = resolveColumnInnerBlock(editor, from);
  if (!located) return false;
  const { node: currentNode, blockStart, blockEnd, parentDepth } = located;
  const currentTypeName = currentNode.type.name;
  const $b = state.doc.resolve(blockStart);

  // 把任意当前节点归一到段落
  const toParagraph = (node: import("@tiptap/pm/model").Node) => nodeToParagraph(schema, node);

  const dispatchReplace = (newNode: import("@tiptap/pm/model").Node, cursorOffset: number) => {
    // 用 editor.state 而非捕获的 state：本函数内可能已 dispatch 过（容器解包），
    // 捕获的 state 会过期，直接用它构建事务会抛 "Applying a mismatched transaction"。
    const tr = editor.state.tr.replaceWith(blockStart, blockEnd, newNode);
    try {
      tr.setSelection(TextSelection.create(tr.doc, Math.min(blockStart + cursorOffset, tr.doc.content.size - 1)));
    } catch {
      /* ignore */
    }
    view.dispatch(tr);
  };

  // ---- 目标是容器（callout / details）----
  if (target.type === "callout" || target.type === "details") {
    // 检查是否已在某个容器里
    let parentContainerDepth = -1;
    let parentContainerName = "";
    for (let d = parentDepth; d >= 1; d--) {
      const n = $b.node(d);
      if (n.type.name === "callout" || n.type.name === "details") {
        parentContainerName = n.type.name;
        parentContainerDepth = d;
        break;
      }
    }
    if (parentContainerName === target.type) {
      // 已是该容器 → 解包为段落（details 展开 detailsContent 内容主体，避免只剩 summary）
      const cStart = $b.before(parentContainerDepth);
      const cEnd = $b.after(parentContainerDepth);
      const cn = $b.node(parentContainerDepth);
      const tr = editor.state.tr;
      replaceRange(tr, cStart, cEnd, unwrapContainerNode(schema, cn));
      view.dispatch(tr);
      return true;
    }
    if (parentContainerDepth >= 0) {
      // 先解包另一个容器
      const cStart = $b.before(parentContainerDepth);
      const cEnd = $b.after(parentContainerDepth);
      const cn = $b.node(parentContainerDepth);
      const tr = editor.state.tr;
      replaceRange(tr, cStart, cEnd, unwrapContainerNode(schema, cn));
      view.dispatch(tr);
      // 重新定位并包成目标容器（必须用 editor.state：上面刚 dispatch 过，捕获的 state 已过期）
      const $p = editor.state.doc.resolve(cStart + 1);
      let nd = $p.depth;
      while (nd > 0 && !$p.node(nd).isTextblock) nd--;
      const bs = $p.before(nd);
      const be = $p.after(nd);
      const pn = $p.node(nd);
      const containerNode = buildColumnContainer(editor, target.type, pn);
      const wrapTr = editor.state.tr.replaceWith(bs, be, containerNode);
      try {
        wrapTr.setSelection(TextSelection.create(wrapTr.doc, Math.min(bs + 2, wrapTr.doc.content.size - 1)));
      } catch { /* ignore */ }
      view.dispatch(wrapTr);
      return true;
    }
    // 直接把当前节点包成容器（支持 image/table 等非文本块）
    const containerNode = buildColumnContainer(editor, target.type, currentNode);
    const tr = state.tr.replaceWith(blockStart, blockEnd, containerNode);
    try {
      tr.setSelection(TextSelection.create(tr.doc, Math.min(blockStart + 2, tr.doc.content.size - 1)));
    } catch { /* ignore */ }
    view.dispatch(tr);
    return true;
  }

  // ---- 目标是基本块（paragraph / heading / list / blockquote / codeBlock）----
  const blockTypes = ["paragraph", "heading", "bulletList", "orderedList", "taskList", "blockquote", "codeBlock"];
  if (!blockTypes.includes(target.type)) return false;

  const map: Record<string, string> = {
    paragraph: "paragraph", heading: "heading", bulletList: "bulletList",
    orderedList: "orderedList", taskList: "taskList",
    blockquote: "blockquote", codeBlock: "codeBlock",
  };
  const targetName = map[target.type];

  // 当前就是目标类型 → 转回正文（标题检查等级）
  if (currentTypeName === targetName && target.type !== "paragraph") {
    if (target.type === "heading") {
      const level = target.level ?? 1;
      if (currentNode.attrs.level === level) {
        dispatchReplace(toParagraph(currentNode), 1);
      } else {
        dispatchReplace(schema.nodes["heading"].create({ level }, currentNode.content), 1);
      }
    } else {
      dispatchReplace(toParagraph(currentNode), 1);
    }
    return true;
  }

  // 文本块互转：走结构化路径
  if (currentNode.isTextblock) {
    const inner = toParagraph(currentNode);
    let newNode: import("@tiptap/pm/model").Node | null = null;
    if (target.type === "paragraph") {
      newNode = inner;
    } else if (target.type === "heading") {
      newNode = schema.nodes["heading"].create({ level: target.level ?? 1 }, inner.content);
    } else if (target.type === "codeBlock") {
      newNode = schema.nodes["codeBlock"].create({}, inner.textContent ? schema.text(inner.textContent) : undefined);
    } else if (target.type === "blockquote") {
      newNode = schema.nodes["blockquote"].create({}, [inner]);
    } else {
      const listNodeType = schema.nodes[targetName];
      if (!listNodeType) return false;
      const itemNode =
        target.type === "taskList"
          ? schema.nodes["taskItem"].create({ checked: false }, [inner])
          : schema.nodes["listItem"].create({}, [inner]);
      newNode = listNodeType.create({}, [itemNode]);
    }
    if (!newNode) return false;
    dispatchReplace(newNode, 1);
    return true;
  }

  // 非文本块（image/table 等）→ 提取文本内容转目标类型
  const inner = toParagraph(currentNode);
  let newNode: import("@tiptap/pm/model").Node | null = null;
  switch (target.type) {
    case "paragraph": newNode = inner; break;
    case "heading": newNode = schema.nodes["heading"].create({ level: target.level ?? 1 }, inner.content); break;
    case "codeBlock": newNode = schema.nodes["codeBlock"].create({}, inner.textContent ? schema.text(inner.textContent) : undefined); break;
    case "blockquote": newNode = schema.nodes["blockquote"].create({}, [inner]); break;
    default: {
      const listNodeType = schema.nodes[targetName];
      if (!listNodeType) return false;
      const itemNode =
        target.type === "taskList"
          ? schema.nodes["taskItem"].create({ checked: false }, [inner])
          : schema.nodes["listItem"].create({}, [inner]);
      newNode = listNodeType.create({}, [itemNode]);
    }
  }
  if (!newNode) return false;
  dispatchReplace(newNode, 1);
  return true;

  // columns 内再套 columns：跳过（保留原 return false）
}

/**
 * 块操作定位兜底：优先用激活时传入的 from；若 from 已失效（文档被删除斜杠词等
 * 事务改动后位置漂移 / 拖拽柄 pos 为 -1 等），回退到当前光标位置再定位。
 * 保证删除/复制/剪切在 from 异常时不会静默失败。
 */
function resolveActionBlock(editor: Editor, from: number): LocatedBlock | null {
  const locate = (pos: number) => {
    if (pos > 0 && pos <= editor.state.doc.content.size) {
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
export async function copyBlock(editor: Editor, from: number): Promise<boolean> {
  const info = resolveActionBlock(editor, from);
  if (!info) return false;
  const { start } = info;

  // 先记住原光标，复制后还原
  const prevFrom = editor.state.selection.from;
  const prevTo = editor.state.selection.to;

  // 用 NodeSelection 选中「整块」：start 即块节点的位置（before(depth)）
  try {
    editor.commands.focus();
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
    // 极端降级：至少保留纯文本
    return copyText(info.node.textContent);
  }
  return true;
}

/**
 * 复制当前块（富文本）到剪贴板并删除（剪切）。
 * 复制是「尽力而为」——即使剪贴板写入失败（无 ClipboardItem / 权限被拒），
 * 也必须删除原块，否则表现为「剪切没反应」。
 */
export async function cutBlock(editor: Editor, from: number): Promise<boolean> {
  const info = resolveActionBlock(editor, from);
  if (!info) return false;
  await copyBlock(editor, from);
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
  if (typeof navigator === "undefined" || !navigator.clipboard?.read) return false;
  let html = "";
  let text = "";
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      if (item.types.includes("text/html")) {
        html = await (await item.getType("text/html")).text();
      } else if (item.types.includes("text/plain")) {
        text = await (await item.getType("text/plain")).text();
      }
    }
  } catch {
    return false;
  }
  const content = html || text;
  if (!content) return false;

  const info = resolveActionBlock(editor, from);
  // 始终作用于点击的那一行，而非它的下一行：
  //  - 空块：删掉空块，内容插到原位置 → 内容就在我们点击的那一行
  //  - 非空块：插到点击块「之前」→ 不会落到下一行
  if (!info) {
    // 兜底：解析失败时插到当前光标处
    editor.chain().focus().insertContentAt(editor.state.selection.from, content).run();
    return true;
  }
  const { start, end, node } = info;
  const isEmpty = node.childCount === 0 && node.textContent.length === 0;
  if (isEmpty) {
    editor.chain().focus().deleteRange({ from: start, to: end }).insertContentAt(start, content).run();
  } else {
    editor.chain().focus().insertContentAt(start, content).run();
  }
  return true;
}

/** 当前块下方插入空段落，返回新位置（供「在下方添加」打开插入面板）。 */
export function addBelowBlock(editor: Editor, from: number): number | null {
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
  const info = locateBlock(editor, from, { preferColumn: false });
  if (!info) return false;
  const { state, view } = editor;
  view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, Math.min(from + 1, state.doc.content.size - 1))));
  // sinkListItem 在非列表项上返回 false，safe
  return editor.commands.sinkListItem(info.typeName);
}

export function outdentBlock(editor: Editor, from: number): boolean {
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
      return schema.nodes["details"].create({}, [summary.create(), content.create([paragraph()])]);
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
  // 用「顶层块」定位：列表/引用/容器的操作单元是整段，插入位置算到整段之后，
  // 而不是嵌套进列表项内部。
  const info = locateTopBlock(editor, from);
  if (!info) return null;
  const { state, view } = editor;
  const node = buildBelowNode(state.schema, type);
  if (!node) return null;

  const isEmpty = info.node.childCount === 0 && info.node.textContent.length === 0;
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
  try {
    tr.setSelection(TextSelection.create(tr.doc, Math.min(anchor, tr.doc.content.size - 1)));
  } catch {
    /* 非文本节点可能抛错，忽略 */
  }
  view.dispatch(tr);
  return Math.min(anchor, tr.doc.content.size - 1);
}
