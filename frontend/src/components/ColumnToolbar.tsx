/**
 * ColumnToolbar —— 分栏（columns）的操作浮层。
 *
 * 交互：鼠标悬停到分栏的某一栏时，在该栏正上方浮出一个 16px ⋯ 微圆点按钮，
 * 点击弹出菜单：添加一栏 / 删除该栏（单栏时为删除分栏）。点击外部即关闭菜单。
 *
 * 注：早期版本在栏右缘另有一个悬浮 ＋ 快捷加栏按钮，但该按钮悬停在栏上方、
 * 会拦截“删除到头 / 拖选经过”时的下一次点击（误加分栏），已移除，统一收进 ⋯ 菜单。
 *
 * 拖拽排序由全局 DragHandle（@tiptap/extension-drag-handle-react）统一提供，
 * 本组件不重复实现，避免出现两个拖拽柄。
 */

import { useEffect, useRef, useState } from "react";
import { Plus, MoreHorizontal, LayoutGrid, Trash2 } from "lucide-react";
import type { Editor } from "@tiptap/react";
import { useTranslation } from "react-i18next";

const MAX_COLUMNS = 6;

/** 16px 微圆点按钮：绝对定位、圆点、白底/描边/轻阴影 */
const MICRO_BTN =
  "absolute w-4 h-4 grid place-items-center rounded-full bg-app-elevated border border-app-border shadow-sm transition-colors z-10";

interface HoverInfo {
  containerEl: HTMLElement;
  colEl: HTMLElement;
  colRect: DOMRect;
  count: number;
  index: number;
}

interface ColumnToolbarProps {
  editor: Editor | null;
  editable: boolean;
}

export function ColumnToolbar({ editor, editable }: ColumnToolbarProps) {
  const { t } = useTranslation();
  const [hover, setHover] = useState<HoverInfo | null>(null);
  const [menu, setMenu] = useState<{ top: number; left: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef(0);
  const hideTimerRef = useRef<number | null>(null);
  /** 显示延迟计时器：鼠标在栏上停留片刻才浮出按钮 */
  const showTimerRef = useRef<number | null>(null);

  /** 延迟隐藏：鼠标离开栏/浮层后等 200ms 再收起，期间进入按钮/菜单则不消失 */
  const scheduleHide = () => {
    // 离开时同时取消未触发的显示计时器
    if (showTimerRef.current != null) {
      window.clearTimeout(showTimerRef.current);
      showTimerRef.current = null;
    }
    if (hideTimerRef.current != null) return;
    hideTimerRef.current = window.setTimeout(() => {
      hideTimerRef.current = null;
      setHover(null);
      setMenu(null);
    }, 200);
  };
  const cancelHide = () => {
    if (hideTimerRef.current != null) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  };

  useEffect(() => {
    if (!editor || !editable) {
      setHover(null);
      setMenu(null);
      return;
    }
    const dom = editor.view.dom;

    const onMove = (e: PointerEvent) => {
      // 忽略浮层自身的事件（鼠标在按钮/菜单上时保持当前显示状态）
      if (containerRef.current?.contains(e.target as Node)) return;
      // 悬停目标必须是栏本身（.prosemirror-column）
      const colEl = (e.target as Element).closest?.(
        ".prosemirror-column"
      ) as HTMLElement | null;
      if (!colEl) {
        scheduleHide();
        return;
      }
      const containerEl = colEl.closest(
        ".prosemirror-column-container"
      ) as HTMLElement | null;
      if (!containerEl || colEl.parentElement !== containerEl) {
        scheduleHide();
        return;
      }
      cancelHide();
      const cols = Array.from(containerEl.children).filter((el) =>
        el.classList.contains("prosemirror-column")
      ) as HTMLElement[];
      const count = cols.length;
      const index = cols.indexOf(colEl);
      // 延迟显示：鼠标在栏上停留 ~120ms 才浮出 +／⋯ 按钮。
      // 防止“删除到头 / 鼠标拖选经过”等瞬时移动时按钮立刻出现在鼠标下方，
      // 导致下一次点击被按钮吞掉（典型事故：分栏下方回退到头时误加一栏）。
      cancelAnimationFrame(rafRef.current);
      if (showTimerRef.current != null) window.clearTimeout(showTimerRef.current);
      showTimerRef.current = window.setTimeout(() => {
        showTimerRef.current = null;
        setHover({
          containerEl,
          colEl,
          colRect: colEl.getBoundingClientRect(),
          count,
          index,
        });
      }, 120);
    };

    const hide = () => {
      cancelHide();
      if (showTimerRef.current != null) {
        window.clearTimeout(showTimerRef.current);
        showTimerRef.current = null;
      }
      setHover(null);
      setMenu(null);
    };

    dom.addEventListener("pointermove", onMove);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    return () => {
      dom.removeEventListener("pointermove", onMove);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
      cancelAnimationFrame(rafRef.current);
      cancelHide();
      if (showTimerRef.current != null) window.clearTimeout(showTimerRef.current);
    };
  }, [editor, editable]);

  // 点击外部关闭菜单
  useEffect(() => {
    if (!menu) return;
    const onDocDown = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setMenu(null);
    };
    document.addEventListener("mousedown", onDocDown);
    return () => document.removeEventListener("mousedown", onDocDown);
  }, [menu]);

  if (!editor || !editable || !hover) return null;

  const canAdd = hover.count < MAX_COLUMNS;
  const isSingle = hover.count <= 1;
  // 按钮浮在命中栏的正上方 22px 处：⋯ 居中、＋ 贴右缘
  const btnTop = hover.colRect.top - 22;
  const moreLeft = hover.colRect.left + hover.colRect.width / 2 - 8;
  const plusLeft = hover.colRect.right - 8;
  // 两按钮中心 x（梯形热区顶边）
  const moreBtnCx = moreLeft + 8;
  const plusBtnCx = plusLeft + 8;
  // 分栏容器 rect（梯形热区底边）
  const containerRect = hover.containerEl.getBoundingClientRect();

  const closeAll = () => {
    setHover(null);
    setMenu(null);
  };

  const deleteColumn = () => {
    const view = editor.view;
    const pos = view.posAtDOM(hover.colEl, 0);
    if (pos == null) return closeAll();
    const $pos = view.state.doc.resolve(pos);
    if ($pos.parent.type.name !== "column") return closeAll();
    const from = $pos.before();
    const to = $pos.after();
    if (from < 0 || to <= from) return closeAll();
    editor.chain().focus().deleteRange({ from, to }).run();
    closeAll();
  };

  const deleteContainer = () => {
    const view = editor.view;
    const pos = view.posAtDOM(hover.containerEl, 0);
    if (pos == null) return closeAll();
    const $pos = view.state.doc.resolve(pos);
    if ($pos.parent.type.name !== "column_container") return closeAll();
    const from = $pos.before();
    const to = $pos.after();
    if (from < 0 || to <= from) return closeAll();
    editor.chain().focus().deleteRange({ from, to }).run();
    closeAll();
  };

  const addColumnAfter = () => {
    const view = editor.view;
    const pos = view.posAtDOM(hover.colEl, 0);
    if (pos == null) return closeAll();
    const $pos = view.state.doc.resolve(pos);
    if ($pos.parent.type.name !== "column") return closeAll();
    if (hover.count >= MAX_COLUMNS) return closeAll();
    const column = view.state.schema.nodes.column.create(
      { colWidth: 100 },
      view.state.schema.nodes.paragraph.create()
    );
    view.dispatch(view.state.tr.insert($pos.after(), column));
    closeAll();
  };

  return (
    <div
      ref={containerRef}
      className="fixed z-[60]"
      style={{ top: 0, left: 0, width: "100vw", height: "100vh", pointerEvents: "none" }}
      onMouseDown={(e) => e.preventDefault()}
      onMouseOver={(e) => {
        // 鼠标进入浮层（热区/按钮/菜单，事件冒泡至此）→ 取消隐藏
        if (containerRef.current?.contains(e.target as Node)) cancelHide();
      }}
      onMouseOut={(e) => {
        // 鼠标离开浮层且未进入浮层内其他元素 → 重新计时隐藏（兜底）
        const rt = e.relatedTarget as Node | null;
        if (rt && containerRef.current?.contains(rt)) return;
        scheduleHide();
      }}
    >
      {/* 梯形热区：两悬浮按钮（顶边）与分栏容器顶边（底边）围成梯形，
          鼠标在此区域内按钮不消失（clip-path 限制命中区域，真正的手感区域） */}
      <div
        className="absolute z-0"
        style={{
          inset: 0,
          clipPath: `polygon(${moreBtnCx}px ${btnTop}px, ${plusBtnCx}px ${btnTop}px, ${containerRect.right}px ${containerRect.top}px, ${containerRect.left}px ${containerRect.top}px)`,
          pointerEvents: "auto",
        }}
      />

      {/* 右缘 ＋：追加一栏 */}
      {canAdd && (
        <button
          type="button"
          title={t("tiptap.addColumn", { defaultValue: "添加栏" })}
          onClick={addColumnAfter}
          className={`${MICRO_BTN} text-accent-primary hover:bg-accent-primary hover:text-white`}
          style={{ top: btnTop, left: plusLeft, pointerEvents: "auto" }}
        >
          <Plus size={10} />
        </button>
      )}

      {/* 居中 ⋯：更多操作（添加栏 / 删除） */}
      <button
        type="button"
        title={t("tiptap.moreColumnActions", { defaultValue: "更多" })}
        onClick={(e) => {
          e.stopPropagation();
          // 点同一位置收起；点开则菜单浮在按钮正下方
          setMenu((v) =>
            v && Math.abs(v.top - btnTop) < 2 && Math.abs(v.left - moreLeft) < 2
              ? null
              : { top: btnTop + 22, left: moreLeft }
          );
        }}
        className={`${MICRO_BTN} text-tx-secondary hover:bg-app-hover hover:text-tx-primary`}
        style={{ top: btnTop, left: moreLeft, pointerEvents: "auto" }}
      >
        <MoreHorizontal size={10} />
      </button>

      {/* 菜单：删除该栏（单栏时为删除分栏）。添加栏由右缘 ＋ 按钮负责，避免功能重复 */}
      {menu && (
        <div
          className="absolute min-w-[8.5rem] bg-app-elevated border border-app-border rounded-lg shadow-lg p-1 z-20"
          style={{ top: menu.top, left: menu.left, pointerEvents: "auto" }}
        >
          {isSingle ? (
            <button
              type="button"
              onClick={deleteContainer}
              className="w-full flex items-center gap-1.5 px-2 py-1 rounded text-xs text-tx-secondary hover:bg-app-hover hover:text-tx-primary transition-colors"
            >
              <LayoutGrid size={11} />
              {t("tiptap.deleteColumnsBlock", { defaultValue: "删除分栏" })}
            </button>
          ) : (
            <button
              type="button"
              onClick={deleteColumn}
              className="w-full flex items-center gap-1.5 px-2 py-1 rounded text-xs text-red-500 hover:bg-red-500/10 transition-colors"
            >
              <Trash2 size={11} />
              {t("tiptap.deleteColumn", { defaultValue: "删除该栏" })}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
