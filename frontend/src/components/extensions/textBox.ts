/**
 * 文本框（Issue #915）：浮动在正文一侧、正文环绕的块，可拖动、可调宽度，用于图文排版。
 *
 * 数据上它就是 callout（高亮块）节点多了 float / width 两个属性，而不是新的节点类型：
 * 旧版本客户端遇到未知节点类型时，打开笔记的 schema 修复会失败，整篇显示为空；
 * 未知属性则只是被忽略，文本框在旧版本里退化成普通高亮块，内容不会丢。
 */

import { Fragment, Slice, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import { NodeSelection, Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import {
  TEXT_BOX_DEFAULT_WIDTH,
  normalizeTextBoxFloat,
  normalizeTextBoxWidth,
  textBoxMargin,
  type TextBoxFloat,
} from "./textBoxLayout";

export {
  TEXT_BOX_DEFAULT_WIDTH,
  TEXT_BOX_MAX_WIDTH,
  TEXT_BOX_MIN_WIDTH,
  normalizeTextBoxFloat,
  normalizeTextBoxWidth,
  type TextBoxFloat,
} from "./textBoxLayout";

/** 新建文本框：灰色底、靠右、占所在容器 40% 宽。 */
export const TEXT_BOX_DEFAULT_ATTRS = { type: "gray", float: "right", width: TEXT_BOX_DEFAULT_WIDTH } as const;

export function isTextBox(node: ProseMirrorNode | null | undefined): node is ProseMirrorNode {
  return node?.type.name === "callout" && normalizeTextBoxFloat(node.attrs.float) !== null;
}

/**
 * callout 的两个附加属性。静态 HTML 同时写 data-* 和内联样式：
 * data-* 用于往返解析，内联样式让导出文件、分享页和外部 Markdown 查看器也能显示浮动效果。
 */
export const textBoxAttributes = {
  float: {
    default: null,
    parseHTML: (element: HTMLElement) => normalizeTextBoxFloat(element.getAttribute("data-float")),
    renderHTML: (attributes: Record<string, unknown>) => {
      const float = normalizeTextBoxFloat(attributes.float);
      if (!float) return {};
      return { "data-float": float, style: `float:${float};margin:${textBoxMargin(float)};box-sizing:border-box` };
    },
  },
  width: {
    default: null,
    parseHTML: (element: HTMLElement) => {
      const raw = element.getAttribute("data-width");
      return raw ? normalizeTextBoxWidth(raw) : null;
    },
    renderHTML: (attributes: Record<string, unknown>) => {
      if (!normalizeTextBoxFloat(attributes.float)) return {};
      const width = normalizeTextBoxWidth(attributes.width);
      return { "data-width": String(width), style: `width:${width}%` };
    },
  },
};

/**
 * 编辑器里浮动的是 NodeView 的外层元素（ProseMirror 用它计算光标和选中框），
 * 由 ReactNodeViewRenderer 的 attrs 选项写入。该选项只会设置不会删除属性，
 * 所以普通高亮块也要显式写 "off" 和空样式。
 */
export function textBoxNodeViewAttrs(node: ProseMirrorNode): Record<string, string> {
  const float = normalizeTextBoxFloat(node.attrs.float);
  return {
    "data-text-box": float ?? "off",
    style: float ? `--nowen-text-box-width: ${normalizeTextBoxWidth(node.attrs.width)}%` : "",
  };
}

/** 把拖动的文本框改成落点所在一侧；其他内容原样返回。 */
export function applyTextBoxDropSide(slice: Slice, side: TextBoxFloat | null): Slice {
  const node = slice.content.childCount === 1 ? slice.content.firstChild : null;
  if (!side || !isTextBox(node) || node.attrs.float === side) return slice;
  const moved = node.type.create({ ...node.attrs, float: side }, node.content, node.marks);
  return new Slice(Fragment.from(moved), slice.openStart, slice.openEnd);
}

/** 落点位于所在容器（正文、分栏、列表项等）的左半边还是右半边。 */
export function resolveTextBoxDropSide(view: EditorView, clientX: number, clientY: number): TextBoxFloat | null {
  const hit = view.posAtCoords({ left: clientX, top: clientY });
  if (!hit) return null;
  const $pos = view.state.doc.resolve(hit.pos);
  let container: Element = view.dom;
  for (let depth = $pos.depth; depth > 0; depth--) {
    const node = $pos.node(depth);
    // 落在段落或另一个文本框里时，文本框会插到它们的外层。
    if (node.isTextblock || isTextBox(node)) continue;
    const dom = view.nodeDOM($pos.before(depth));
    if (dom instanceof Element) {
      container = dom;
      break;
    }
  }
  const rect = container.getBoundingClientRect();
  if (!rect.width) return null;
  return clientX < rect.left + rect.width / 2 ? "left" : "right";
}

interface TextBoxDrag {
  dragging: unknown;
  side: TextBoxFloat | null;
}

const activeDrags = new WeakMap<EditorView, TextBoxDrag>();

/**
 * 从文本框自己的拖动柄开始拖动。与块拖动柄相同：选中整个文本框并交给 ProseMirror 的
 * 原生拖放移动，落点决定上下位置，落在容器左/右半边决定靠左还是靠右。
 */
export function startTextBoxDrag(view: EditorView, pos: number, event: DragEvent, dragImage?: Element | null): boolean {
  const node = view.state.doc.nodeAt(pos);
  if (!event.dataTransfer || !view.editable || !isTextBox(node)) return false;
  const selection = NodeSelection.create(view.state.doc, pos);
  const slice = selection.content();
  const { dom, text } = view.serializeForClipboard(slice);
  event.dataTransfer.clearData();
  event.dataTransfer.setData("text/html", dom.innerHTML);
  event.dataTransfer.setData("text/plain", text);
  event.dataTransfer.effectAllowed = "copyMove";
  if (dragImage) event.dataTransfer.setDragImage(dragImage, 0, 0);
  view.dispatch(view.state.tr.setSelection(selection));
  const dragging = { slice, move: true, node: selection };
  (view as unknown as { dragging: unknown }).dragging = dragging;
  activeDrags.set(view, { dragging, side: null });
  return true;
}

/**
 * 拖动结束（含取消）。拖动柄在 NodeView 内，ProseMirror 收不到它的 dragend，
 * 这里按 ProseMirror 自己的做法稍后清掉 view.dragging，避免之后拖入的外部文件被当成文本框移动。
 */
export function endTextBoxDrag(view: EditorView): void {
  const drag = activeDrags.get(view);
  activeDrags.delete(view);
  if (!drag) return;
  window.setTimeout(() => {
    const host = view as unknown as { dragging: unknown };
    if (host.dragging === drag.dragging) host.dragging = null;
  }, 50);
}

export const textBoxDragPluginKey = new PluginKey("textBoxDrag");

export function createTextBoxDragPlugin(): Plugin {
  return new Plugin({
    key: textBoxDragPluginKey,
    props: {
      handleDOMEvents: {
        drop(view, event) {
          const drag = activeDrags.get(view);
          if (drag) drag.side = resolveTextBoxDropSide(view, event.clientX, event.clientY);
          return false;
        },
      },
      // ProseMirror 在执行拖放插入前调用 transformPasted；只改本插件发起的文本框拖动。
      transformPasted(slice, view) {
        const drag = activeDrags.get(view);
        if (!drag || (view as unknown as { dragging: unknown }).dragging !== drag.dragging) return slice;
        activeDrags.delete(view);
        return applyTextBoxDropSide(slice, drag.side);
      },
    },
  });
}
