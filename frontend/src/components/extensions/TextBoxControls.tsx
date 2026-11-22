/**
 * 文本框（Issue #915）的编辑控件：拖动柄、靠左/靠右切换、宽度拖拽柄。
 * 只在可编辑时由 CalloutNodeView 渲染；序列化仍走 CalloutExtension 的 renderHTML。
 */

import React, { useEffect, useRef } from "react";
import type { Editor } from "@tiptap/react";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { GripHorizontal, PanelLeft, PanelRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import {
  TEXT_BOX_MAX_WIDTH,
  TEXT_BOX_MIN_WIDTH,
  endTextBoxDrag,
  normalizeTextBoxFloat,
  normalizeTextBoxWidth,
  startTextBoxDrag,
  type TextBoxFloat,
} from "./textBox";

const KEYBOARD_STEP = 5;
const WIDTH_VARIABLE = "--nowen-text-box-width";

interface TextBoxControlsProps {
  editor: Editor;
  node: ProseMirrorNode;
  getPos: () => number | undefined;
  updateAttributes: (attributes: Record<string, unknown>) => void;
}

/** NodeView 外层元素：ProseMirror 的节点 DOM，浮动和宽度都作用在它上面。 */
const outerElement = (from: Element) => from.closest<HTMLElement>(".node-callout");

export function TextBoxControls({ editor, node, getPos, updateAttributes }: TextBoxControlsProps) {
  const { t } = useTranslation();
  const float = normalizeTextBoxFloat(node.attrs.float) ?? "right";
  const width = normalizeTextBoxWidth(node.attrs.width);
  const stopResize = useRef<(() => void) | null>(null);
  useEffect(() => () => stopResize.current?.(), []);

  const setFloat = (next: TextBoxFloat) => {
    if (editor.isEditable && next !== float) updateAttributes({ float: next });
  };

  const onResizeStart = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (!editor.isEditable || event.button !== 0) return;
    const handle = event.currentTarget;
    const outer = outerElement(handle);
    const parent = outer?.parentElement;
    if (!outer || !parent) return;
    const style = getComputedStyle(parent);
    // 百分比宽度相对父容器的内容宽度计算。
    const available = parent.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
    if (!(available > 0)) return;
    event.preventDefault();
    event.stopPropagation();
    stopResize.current?.();

    const startX = event.clientX;
    const startWidth = outer.getBoundingClientRect().width;
    let next = width;
    const onMove = (move: PointerEvent) => {
      const delta = move.clientX - startX;
      next = normalizeTextBoxWidth(((float === "right" ? startWidth - delta : startWidth + delta) / available) * 100);
      outer.style.setProperty(WIDTH_VARIABLE, `${next}%`);
    };
    const stop = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onCancel);
      stopResize.current = null;
    };
    // 拖动时只改样式，松开后写入一次，撤销一步即可还原。
    const onUp = () => {
      stop();
      if (next !== width && editor.isEditable) updateAttributes({ width: next });
      else outer.style.setProperty(WIDTH_VARIABLE, `${width}%`);
    };
    const onCancel = () => {
      stop();
      outer.style.setProperty(WIDTH_VARIABLE, `${width}%`);
    };
    handle.setPointerCapture?.(event.pointerId);
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onCancel);
    stopResize.current = stop;
  };

  // 方向键按拖拽柄移动的方向调整宽度：柄在左边时向左变宽，柄在右边时向右变宽。
  const onResizeKey = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    event.stopPropagation();
    const wider = (event.key === "ArrowLeft") === (float === "right");
    const next = normalizeTextBoxWidth(width + (wider ? KEYBOARD_STEP : -KEYBOARD_STEP));
    if (next !== width && editor.isEditable) updateAttributes({ width: next });
  };

  const keepSelection = (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <>
      <div className="text-box-toolbar" contentEditable={false} data-side={float}>
        <span
          className="text-box-grip"
          draggable
          title={t("richText.textBoxMove")}
          aria-label={t("richText.textBoxMove")}
          onDragStart={(event) => {
            const pos = getPos();
            const started = typeof pos === "number"
              && startTextBoxDrag(editor.view, pos, event.nativeEvent, outerElement(event.currentTarget));
            if (!started) event.preventDefault();
          }}
          onDragEnd={() => endTextBoxDrag(editor.view)}
        >
          <GripHorizontal size={12} />
        </span>
        {(["left", "right"] as const).map((side) => (
          <button
            key={side}
            type="button"
            className={cn("text-box-float-button", float === side && "is-active")}
            aria-pressed={float === side}
            title={t(side === "left" ? "richText.textBoxFloatLeft" : "richText.textBoxFloatRight")}
            aria-label={t(side === "left" ? "richText.textBoxFloatLeft" : "richText.textBoxFloatRight")}
            onMouseDown={keepSelection}
            onClick={() => setFloat(side)}
          >
            {side === "left" ? <PanelLeft size={12} /> : <PanelRight size={12} />}
          </button>
        ))}
      </div>
      <button
        type="button"
        className="text-box-resize"
        data-side={float}
        contentEditable={false}
        title={t("richText.textBoxResize")}
        aria-label={t("richText.textBoxResize")}
        role="separator"
        aria-orientation="vertical"
        aria-valuemin={TEXT_BOX_MIN_WIDTH}
        aria-valuemax={TEXT_BOX_MAX_WIDTH}
        aria-valuenow={width}
        onPointerDown={onResizeStart}
        onKeyDown={onResizeKey}
      />
    </>
  );
}
