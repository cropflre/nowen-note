import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/react";

interface BadgeState {
  level: number;
  top: number;
  left: number;
}

/**
 * 标题等级标记（H1-H6）。
 *
 * 与 DragHandle 完全解耦：这是一个独立浮动元素，不是 DragHandle 的子节点，
 * 也不使用其 portal / children。它只读取「当前可见拖拽柄」的屏幕位置，
 * 把自己对齐到拖拽柄的左侧。这样既满足「显示在块柄左边」，又满足
 * 「不和 DragHandle 绑定」的约束。
 *
 * 定位方式：挂在拖拽柄真正的 offsetParent（定位祖先）下，与拖拽柄共用同一套
 * 绝对定位参照系，因此会随拖拽柄一起随光标/滚动移动，且必然对齐。
 */
export function HeadingLevelBadge({ editor }: { editor: Editor }) {
  const [state, setState] = useState<BadgeState | null>(null);

  useEffect(() => {
    if (!editor) return;
    const root = editor.view.dom.parentElement;
    if (!root) return;

    let raf = 0;
    const compute = () => {
      raf = 0;
      // 当前选区所在的最顶层标题
      const { $from } = editor.state.selection;
      let level: number | null = null;
      for (let d = $from.depth; d > 0; d--) {
        const node = $from.node(d);
        if (node.type.name === "heading") {
          level = node.attrs.level as number;
          break;
        }
      }
      if (level == null) {
        setState(null);
        return;
      }
      // 读取当前可见拖拽柄的位置，把它作为定位基准
      const handle = root.querySelector(
        ".tiptap-drag-handle:not(.tiptap-drag-handle--hidden)",
      ) as HTMLElement | null;
      if (!handle) {
        setState(null);
        return;
      }
      const offsetParent = handle.offsetParent as HTMLElement | null;
      if (!offsetParent) {
        setState(null);
        return;
      }
      const hRect = handle.getBoundingClientRect();
      const oRect = offsetParent.getBoundingClientRect();
      setState({
        level,
        // 与拖拽柄共用 offsetParent 坐标基准，必然对齐（含滚动偏移）
        top: hRect.top - oRect.top + offsetParent.scrollTop,
        left: hRect.left - oRect.left + offsetParent.scrollLeft,
      });
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(compute);
    };
    const onScroll = () => schedule();

    editor.on("selectionUpdate", schedule);
    editor.on("transaction", schedule);
    editor.on("update", schedule);
    root.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    schedule();

    return () => {
      if (raf) cancelAnimationFrame(raf);
      editor.off("selectionUpdate", schedule);
      editor.off("transaction", schedule);
      editor.off("update", schedule);
      root.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [editor]);

  if (!editor || !state) return null;

  // portal 目标取拖拽柄的 offsetParent（定位祖先），与拖拽柄同一参照系
  const handle = editor.view.dom.parentElement?.querySelector(
    ".tiptap-drag-handle:not(.tiptap-drag-handle--hidden)",
  ) as HTMLElement | null;
  const mount = (handle?.offsetParent ?? editor.view.dom.parentElement) as HTMLElement;

  return createPortal(
    <div
      className="nowen-heading-level-badge"
      style={{
        position: "absolute",
        top: state.top,
        left: state.left,
        // 把徽标整体移到拖拽柄左侧：右边缘距拖拽柄左缘 6px
        transform: "translateX(calc(-100% - 6px))",
        pointerEvents: "none",
      }}
    >
      H{state.level}
    </div>,
    mount,
  );
}
