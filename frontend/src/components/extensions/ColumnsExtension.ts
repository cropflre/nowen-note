/**
 * ColumnsExtension —— 分栏扩展。
 *
 * 拖拽调宽能力直接复用社区插件 tiptap-extension-multi-column 验证过的
 * gridResizingPlugin（也正是当初“好用”的版本）：在编辑器事件层用
 * handleDOMEvents 监听 mousemove/mousedown，命中“某列右缘 ±handleWidth”即视为
 * 抓住该列边界，mousedown 起拖时只改“被抓那一根列”的 colWidth，其余列 flex 自动吸收
 * （不联动其他栏结构）。嵌套定位用 $pos.before()（当前列之前），对 doc>container>column
 * 三层结构正确。
 *
 * 与旧包的差异（仅为适配本项目样式，不改变交互模型）：
 *  - 列被拖拽后写入 resized=true（配合 dragHandle.css 里
 *    .prosemirror-column[data-resized="true"]{flex:0 0 auto}，让 colWidth 像素宽生效）；
 *    未拖拽列仍 flex:1 1 0 等比，旧文档视觉不变。
 *  - 去掉旧包对宽度的 -24 偏移（本项目列 box-sizing:border-box，colWidth 即可视像素宽）。
 *
 * 节点名 / 属性（column / column_container / colWidth / resized）完全沿用旧包，
 * 保证已存笔记 JSON 在 repairTiptapJson 的 round-trip 中不丢节点。
 */

import { Node, Extension, mergeAttributes } from "@tiptap/core";
import type { Editor } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { keymap } from "@tiptap/pm/keymap";
import { TextSelection } from "@tiptap/pm/state";
import {
  chainCommands,
  newlineInCode,
  createParagraphNear,
  splitBlock,
} from "@tiptap/pm/commands";
import { liftTarget, canSplit } from "@tiptap/pm/transform";

const MIN_COL_WIDTH = 50;

/* ------------------------------------------------------------------ */
/*  栏内空段落不 lift 出 column（防止分栏结构被破坏）                  */
/* ------------------------------------------------------------------ */

function findParentColumn($pos: any): { node: any; depth: number } | null {
  for (let depth = $pos.depth; depth > 0; depth--) {
    const node = $pos.node(depth);
    if (node.type.name === "column") return { node, depth };
  }
  return null;
}

const liftEmptyBlockInColumn = (state: any, dispatch?: any): boolean => {
  const { $cursor } = state.selection;
  if (!$cursor || $cursor.parent.content.size) return false;
  if ($cursor.node($cursor.depth - 1)?.type.name === "column") return false;
  if ($cursor.depth > 1 && $cursor.after() !== $cursor.end(-1)) {
    const before = $cursor.before();
    if (canSplit(state.doc, before)) {
      if (dispatch) dispatch(state.tr.split(before).scrollIntoView());
      return true;
    }
  }
  const range = $cursor.blockRange();
  const target = range && liftTarget(range);
  if (target == null) return false;
  if (dispatch) dispatch(state.tr.lift(range, target).scrollIntoView());
  return true;
};

const columnsKeymap = keymap({
  Enter: chainCommands(
    newlineInCode,
    createParagraphNear,
    liftEmptyBlockInColumn,
    splitBlock
  ),
  "Mod-a": (state, dispatch) => {
    const { $from } = state.selection;
    const found = findParentColumn($from);
    if (found) {
      const { depth } = found;
      const start = $from.start(depth);
      const end = $from.end(depth);
      if (dispatch)
        dispatch(state.tr.setSelection(TextSelection.create(state.doc, start, end)));
      return true;
    }
    return false;
  },
});

/* ------------------------------------------------------------------ */
/*  列宽拖拽（gridResizingPlugin —— 社区验证过的实现，原样复用）      */
/* ------------------------------------------------------------------ */

const gridResizingPluginKey = new PluginKey("gridResizingPlugin");

class GridResizeState {
  activeHandle: number;
  dragging: { startX: number; startWidth: number } | false;
  constructor(activeHandle: number, dragging: { startX: number; startWidth: number } | false) {
    this.activeHandle = activeHandle;
    this.dragging = dragging;
  }
  apply(tr: any): GridResizeState {
    const action = tr.getMeta(gridResizingPluginKey);
    if (!action) return this;
    if (typeof action.setHandle === "number") {
      return new GridResizeState(action.setHandle, false);
    }
    if (action.setDragging !== void 0) {
      return new GridResizeState(this.activeHandle, action.setDragging);
    }
    return this;
  }
}

/** 找鼠标当前落在哪一列的右缘（命中即返回该列起始 pos，否则 -1） */
function findBoundaryPosition(view: any, event: any, handleWidth: number): number {
  const path: any[] = event.composedPath ? event.composedPath() : [];
  const gridDOM = path.find(
    (el) => el && el.classList && el.classList.contains("prosemirror-column-container")
  );
  if (!gridDOM) return -1;
  const children = Array.from(gridDOM.children).filter(
    (el: any) => el.classList && el.classList.contains("prosemirror-column")
  );
  for (let i = 0; i < children.length; i++) {
    const colEl = children[i] as HTMLElement;
    const rect = colEl.getBoundingClientRect();
    if (
      event.clientX >= rect.right - handleWidth - 2 &&
      event.clientX <= rect.right + 10 + handleWidth
    ) {
      const pos = view.posAtDOM(colEl, 0);
      if (pos != null) return pos;
    }
  }
  return -1;
}

function draggedWidth(dragging: any, event: any, minWidth: number): number {
  const offset = event.clientX - dragging.startX;
  return Math.max(minWidth, dragging.startWidth + offset);
}

/** 把最终/实时列宽写回文档：标记 resized=true 让 CSS 切到 flex:0 0 auto，colWidth 像素宽生效 */
function updateColumnNodeWidth(view: any, pos: number, attrs: any, width: number): void {
  view.dispatch(
    view.state.tr.setNodeMarkup(pos, undefined, {
      ...attrs,
      resized: true,
      colWidth: Math.max(MIN_COL_WIDTH, Math.round(width)),
    })
  );
}

function getColumnInfoAtPos(view: any, boundaryPos: number): any {
  const $pos = view.state.doc.resolve(boundaryPos);
  const node = $pos.parent;
  if (!node || node.type.name !== "column") return null;
  const dom = view.domAtPos($pos.pos);
  if (!dom.node) return null;
  const columnEl =
    dom.node instanceof HTMLElement ? dom.node : dom.node.childNodes[dom.offset];
  const domWidth = (columnEl as HTMLElement).offsetWidth;
  return { $pos, node, columnEl, domWidth };
}

function updateActiveHandle(view: any, value: number): void {
  view.dispatch(
    view.state.tr.setMeta(gridResizingPluginKey, { setHandle: value })
  );
}

function handleMouseMove(view: any, event: any, handleWidth: number): boolean {
  const pluginState = gridResizingPluginKey.getState(view.state);
  if (!pluginState) return false;
  if (pluginState.dragging) return false;
  const boundaryPos = findBoundaryPosition(view, event, handleWidth);
  if (boundaryPos !== pluginState.activeHandle) {
    updateActiveHandle(view, boundaryPos);
  }
  return false;
}

function handleMouseLeave(view: any): boolean {
  const pluginState = gridResizingPluginKey.getState(view.state);
  if (!pluginState) return false;
  if (pluginState.activeHandle > -1 && !pluginState.dragging) {
    updateActiveHandle(view, -1);
  }
  return false;
}

function handleMouseDown(view: any, event: any, columnMinWidth: number): boolean {
  const pluginState = gridResizingPluginKey.getState(view.state);
  if (!pluginState) return false;
  if (pluginState.activeHandle === -1) return false;
  if (pluginState.dragging) return false;
  const columnInfo = getColumnInfoAtPos(view, pluginState.activeHandle);
  if (!columnInfo) return false;
  const { domWidth, $pos, node } = columnInfo;
  const nodeAttrs = { ...node.attrs };
  const nodePos = $pos.before(); // 当前列之前（嵌套 depth 正确）
  view.dispatch(
    view.state.tr.setMeta(gridResizingPluginKey, {
      setDragging: { startX: event.clientX, startWidth: domWidth },
    })
  );
  const win = view.dom.ownerDocument.defaultView || window;
  const finish = (e: any) => {
    win.removeEventListener("mouseup", finish);
    win.removeEventListener("mousemove", move);
    const ps: any = gridResizingPluginKey.getState(view.state);
    if (!(ps && ps.dragging)) return;
    const finalWidth = draggedWidth(ps.dragging, e, columnMinWidth);
    updateColumnNodeWidth(view, nodePos, nodeAttrs, finalWidth);
    view.dispatch(
      view.state.tr.setMeta(gridResizingPluginKey, { setDragging: null })
    );
  };
  const move = (e: any) => {
    if (!e.buttons) {
      finish(e);
      return;
    }
    const ps: any = gridResizingPluginKey.getState(view.state);
    if (!(ps && ps.dragging)) return;
    const newWidth = draggedWidth(ps.dragging, e, columnMinWidth);
    updateColumnNodeWidth(view, nodePos, nodeAttrs, newWidth);
  };
  win.addEventListener("mouseup", finish);
  win.addEventListener("mousemove", move);
  updateColumnNodeWidth(view, nodePos, nodeAttrs, domWidth);
  event.preventDefault();
  return true;
}

/** 柱间加号按钮（插入新列），纯装饰；本项目另有 ColumnToolbar 提供加列，这里隐藏其视觉 */
function handleGridDecorations(state: any, boundaryPos: number): any {
  const decorations: any[] = [];
  const $pos = state.doc.resolve(boundaryPos);
  if ($pos.nodeAfter !== null) {
    const widget = document.createElement("div");
    widget.className = "grid-resize-handle";
    const circleButton = document.createElement("div");
    circleButton.className = "circle-button";
    widget.appendChild(circleButton);
    const plusIcon = document.createElement("div");
    plusIcon.className = "plus";
    circleButton.appendChild(plusIcon);
    decorations.push(Decoration.widget(boundaryPos, widget));
  }
  return DecorationSet.create(state.doc, decorations);
}

function handleMouseUp(view: any, event: any): boolean {
  const div = event.target;
  if (!div) return false;
  if (div.className !== "circle-button" && div.className !== "plus") return false;
  const column = div.closest(".prosemirror-column");
  if (!column) return false;
  const boundryPos = view.posAtDOM(column, 0);
  if (!boundryPos) return false;
  const $pos = view.state.doc.resolve(boundryPos);
  const { state } = view;
  view.dispatch(
    state.tr.insert(
      $pos.pos + $pos.parent.nodeSize - 1,
      state.schema.nodes.column.create(
        { colWidth: 100 },
        state.schema.nodes.paragraph.create()
      )
    )
  );
  return true;
}

function gridResizingPlugin(options?: { handleWidth?: number; columnMinWidth?: number }): any {
  const handleWidth = options?.handleWidth != null ? options.handleWidth : 4;
  const columnMinWidth = options?.columnMinWidth != null ? options.columnMinWidth : MIN_COL_WIDTH;
  return new Plugin({
    key: gridResizingPluginKey,
    state: {
      init: () => new GridResizeState(-1, false),
      apply: (tr: any, prev: GridResizeState) => prev.apply(tr),
    },
    props: {
      attributes: (state: any) => {
        const pluginState = gridResizingPluginKey.getState(state);
        if (pluginState && pluginState.activeHandle > -1) {
          return { class: "resize-cursor" };
        }
        return {};
      },
      handleDOMEvents: {
        mousemove: (view, event) => handleMouseMove(view, event, handleWidth),
        mouseleave: (view) => handleMouseLeave(view),
        mousedown: (view, event) => handleMouseDown(view, event, columnMinWidth),
        mouseup: (view, event) => handleMouseUp(view, event),
      },
      decorations: (state: any) => {
        const pluginState = gridResizingPluginKey.getState(state);
        if (!pluginState) return null;
        if (pluginState.activeHandle === -1) return null;
        return handleGridDecorations(state, pluginState.activeHandle);
      },
    },
  });
}

/* ------------------------------------------------------------------ */
/*  节点定义（column / column_container）                              */
/* ------------------------------------------------------------------ */

const Column = Node.create({
  name: "column",
  group: "block",
  content: "block+",
  addAttributes() {
    return {
      colWidth: {
        default: 200,
        parseHTML: (element: HTMLElement) => {
          const width = element.style.width.replace("px", "");
          return Number(width) || 200;
        },
        renderHTML: (attributes: any) => {
          const style = attributes.colWidth ? `width: ${attributes.colWidth}px;` : "";
          return { style };
        },
      },
      resized: {
        default: false,
        parseHTML: (element: HTMLElement) =>
          element.getAttribute("data-resized") === "true",
        renderHTML: (attributes: any) =>
          attributes.resized ? { "data-resized": "true" } : {},
      },
    };
  },
  parseHTML() {
    return [{ tag: "div.prosemirror-column" }];
  },
  renderHTML({ HTMLAttributes }: any) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, { class: "prosemirror-column" }),
      0,
    ];
  },
});

const ColumnContainer = Node.create({
  name: "column_container",
  group: "block",
  content: "column+",
  parseHTML() {
    return [{ tag: "div.prosemirror-column-container" }];
  },
  renderHTML({ HTMLAttributes }: any) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, { class: "prosemirror-column-container" }),
      0,
    ];
  },
});

export const ColumnsExtension = Extension.create({
  name: "columns",
  addExtensions() {
    return [Column, ColumnContainer];
  },
  addProseMirrorPlugins() {
    return [
      gridResizingPlugin({ handleWidth: 4, columnMinWidth: MIN_COL_WIDTH }),
      columnsKeymap,
    ];
  },
});

/** 便捷构造一个空栏（供 SlashCommands / ColumnToolbar 复用） */
export function createEmptyColumn(colWidth = 200) {
  return {
    type: "column",
    attrs: { colWidth },
    content: [{ type: "paragraph" }],
  };
}
