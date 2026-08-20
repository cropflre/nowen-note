/**
 * CalloutNodeView —— 高亮块的交互式 NodeView。
 *
 * 对齐语雀：
 *   - 块本身：浅色底 + 圆角 + 细边框
 *   - 切换颜色的入口 **不在框内**：悬停/选中高亮块时，在框外顶部居中浮出一个
 *     调色板按钮（与分栏 ColumnToolbar 的微圆点悬浮按钮同款：16px 圆点、
 *     白底/描边/轻阴影、浮在块正上方、水平居中）
 *   - 点击该浮动按钮 → 弹出横排圆角色块选择器（当前项 ✓ 标记）
 *
 * 实现要点（与项目内 CodeBlockView 的弹层惯例一致）：
 *   - 悬浮按钮 contentEditable=false，mousedown 时 preventDefault + stopPropagation
 *   - 弹层用 createPortal 挂到 body，position:fixed，按按钮 getBoundingClientRect 算位
 *   - 点击外部 / Esc / 滚动 / 缩放 即关闭
 *   - 只读时不显示悬浮按钮
 *
 * 注意：NodeView 只影响编辑态渲染；序列化仍走 CalloutExtension 的 renderHTML。
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { NodeViewWrapper, NodeViewContent, NodeViewProps } from "@tiptap/react";
import { Palette } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  CALLOUT_TYPE_META,
  CALLOUT_TYPE_ORDER,
  type CalloutType,
} from "./calloutTypes";

const POPUP_WIDTH = 300;
const SWATCH_SIZE = 26;
const SWATCH_GAP = 6;

export function CalloutNodeView({ node, updateAttributes, editor }: NodeViewProps) {
  const type = (node.attrs.type as CalloutType) || "blue";
  const editable = editor?.isEditable ?? true;

  const btnRef = useRef<HTMLButtonElement | null>(null);
  const popupRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  const computePos = useCallback(() => {
    const btn = btnRef.current;
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    // 弹层放在按钮上方（对齐语雀：选色器浮在块上方）
    const top = Math.max(8, rect.top - 8 - SWATCH_SIZE - 8);
    const left = Math.min(
      Math.max(8, rect.left - (POPUP_WIDTH / 2) + (rect.width / 2)),
      window.innerWidth - POPUP_WIDTH - 8,
    );
    setPos({ top, left });
  }, []);

  useEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    computePos();
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (popupRef.current?.contains(t)) return;
      if (btnRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", computePos, true);
    window.addEventListener("resize", computePos);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", computePos, true);
      window.removeEventListener("resize", computePos);
    };
  }, [open, computePos]);

  const select = (value: CalloutType) => {
    updateAttributes({ type: value, icon: CALLOUT_TYPE_META[value].emoji });
    setOpen(false);
  };

  return (
    <NodeViewWrapper
      data-type="callout"
      data-callout-type={type}
      className="callout-nodeview group relative"
    >
      <NodeViewContent className="prosemirror-callout-content" />

      {/* 框外顶部居中悬浮调色按钮：与分栏微圆点同款（16px 圆点、浮在块正上方、水平居中）。
          始终渲染，显隐交给 CSS（悬停块/按钮时显示；.is-open 打开选色器时保持显示），
          避免鼠标从块移向按钮的途中按钮消失。 */}
      {editable && (
        <button
          ref={btnRef}
          type="button"
          contentEditable={false}
          onMouseDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          onClick={(e) => {
            e.stopPropagation();
            setOpen((v) => !v);
          }}
          className={cn(
            "callout-color-trigger absolute grid place-items-center rounded-full",
            "bg-app-elevated border border-app-border shadow-sm",
            "hover:bg-app-hover hover:text-tx-primary",
            open && "is-open",
          )}
          style={{
            top: -28, // 浮在块上方（16px 按钮 + 12px 间距，与分栏 btnTop -22 同思路）
            left: "50%",
            transform: "translateX(-50%)",
            width: 16,
            height: 16,
            zIndex: 3,
          }}
          title="切换高亮样式"
          aria-label="切换高亮样式"
        >
          <Palette size={10} className="text-tx-secondary" />
        </button>
      )}

      {/* 语雀风格选色器：横排圆角色块行 */}
      {open && editable && pos &&
        createPortal(
          <div
            ref={popupRef}
            className="callout-type-popup rounded-lg shadow-lg overflow-hidden bg-white dark:bg-[#1f2328] border border-gray-200/80 dark:border-gray-700/80"
            style={{
              position: "fixed",
              top: pos.top,
              left: pos.left,
              width: POPUP_WIDTH,
              zIndex: 1000,
              padding: "10px 12px",
              animation: "contextMenuIn 0.12s ease-out",
            }}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              className="flex flex-wrap gap-[var(--swatch-gap)]"
              style={{ "--swatch-gap": `${SWATCH_GAP}px` } as React.CSSProperties}
            >
              {CALLOUT_TYPE_ORDER.map((key) => {
                const m = CALLOUT_TYPE_META[key];
                const active = key === type;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => select(key)}
                    className={cn(
                      "rounded-md border-2 transition-all duration-100 flex items-center justify-center",
                      "hover:scale-110 active:scale-95",
                      active
                        ? "border-gray-400 dark:border-gray-400 scale-105 shadow-sm"
                        : "border-transparent hover:border-gray-300 dark:hover:border-gray-600",
                    )}
                    style={{
                      width: SWATCH_SIZE,
                      height: SWATCH_SIZE,
                      backgroundColor: m.swatch,
                    }}
                    title={m.label}
                    aria-label={m.label}
                    aria-pressed={active}
                  >
                    {active && (
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="text-gray-600 dark:text-gray-300"
                      >
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    )}
                  </button>
                );
              })}
            </div>
          </div>,
          document.body,
        )}
    </NodeViewWrapper>
  );
}
