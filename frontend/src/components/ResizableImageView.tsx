import React, { useCallback, useEffect, useRef, useState } from "react";
import { NodeViewWrapper, NodeViewProps } from "@tiptap/react";
import { resolveAttachmentUrl, getServerUrl } from "@/lib/api";

/**
 * 判断是否为本应用的附件路径（/api/attachments/xxx）。
 * 这些路径在 Capacitor Android 下可能因为混合内容策略（https origin
 * 请求 http 资源）而被 WebView 阻断。
 */
function isAttachmentPath(src: string): boolean {
  if (!src) return false;
  return /^\/?api\/attachments\//.test(src) || src.includes("/api/attachments/");
}

/**
 * 通过 fetch 下载图片并生成 blob URL。
 * 绕过 Android WebView 的混合内容限制：
 *   - `<img src="http://...">` 在 `https://localhost` origin 下会被
 *     部分 WebView 拦截（即使设置了 allowMixedContent）；
 *   - `fetch()` 走 JS 通道，不受浏览器对 `<img>` 的混合内容策略约束；
 *   - 转成 `blob:` URL 后再赋给 `<img src>`，blob 协议同源，永远不受限。
 */
async function fetchImageAsBlob(url: string): Promise<string> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`fetch image failed: ${resp.status}`);
  const blob = await resp.blob();
  return URL.createObjectURL(blob);
}

/**
 * ResizableImageView
 * ============================================================
 * Tiptap Image 扩展的自定义 NodeView：
 *   - 仅在图片被 ProseMirror 选中时展示四角手柄；
 *   - 拖动手柄修改 `width` attribute（px 数值），`height` 保持为 null
 *     以让浏览器按 naturalHeight/naturalWidth 自动维持比例；
 *   - 支持触摸设备（touchstart / touchmove / touchend）；
 *   - 按住 Alt 时以中心点对称缩放（两侧同步变化，中心稳定）；
 *   - 按住 Shift 时锁定比例（当前实现中 height 永远 auto，所以 Shift
 *     在视觉上已经是默认行为；该修饰键保留为未来接入自由拉伸的扩展点）；
 *   - 渲染出的 DOM 仍然是一个普通的 <img> 节点（width 作为 HTML 属性），
 *     保证序列化 / 导出 / Markdown 转换完全向后兼容。
 *
 * 设计注意：
 *   - 鼠标与触摸的 add/remove 成对出现，避免抽出 detach helper 后产生
 *     useCallback 之间的循环依赖；移除时必须和添加时引用**同一个**函数对象。
 *   - touchmove 必须 `{ passive: false }` 才能 preventDefault，阻止页面
 *     在手柄拖动期间同步滚动 / 捏合缩放。
 */

type Corner = "nw" | "ne" | "sw" | "se";

/** 图像允许的最小宽度（px）。过小会导致手柄几乎重叠且实际无意义。 */
const MIN_WIDTH = 40;
/**
 * 图像允许的最大宽度（px）。
 * 设为一个比较大的常量，实际展示还会被容器和 CSS 的 max-width:100% 夹住。
 * 但我们仍希望 attribute 写一个有限上限，避免极端手抖拖出屏幕外留下怪数据。
 */
const MAX_WIDTH = 4000;

export function ResizableImageView(props: NodeViewProps) {
  const { node, updateAttributes, selected, editor } = props;
  const { src, alt, title } = node.attrs as { src?: string; alt?: string; title?: string };
  const initialWidth = (node.attrs as { width?: number | string | null }).width ?? null;

  const imgRef = useRef<HTMLImageElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  // 拖拽过程中的"临时宽度"。未在拖拽时为 null，渲染走 attribute 的 width。
  const [draftWidth, setDraftWidth] = useState<number | null>(null);
  const dragStateRef = useRef<{
    startX: number;
    startWidth: number;
    corner: Corner;
    /** 是否启用"以中心对称缩放"（Alt 键按下时开启）。 */
    symmetric: boolean;
  } | null>(null);

  // 只读模式下不允许拖拽
  const editable = editor?.isEditable ?? true;

  const commitWidth = useCallback(
    (w: number) => {
      const clamped = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(w)));
      updateAttributes({ width: clamped });
    },
    [updateAttributes],
  );

  /**
   * 根据水平位移 + 当前修饰键状态计算下一帧的 draft 宽度。
   * 抽出来给鼠标与触摸事件共用。
   */
  const computeNextWidth = useCallback((dx: number, modifierAlt: boolean) => {
    const st = dragStateRef.current;
    if (!st) return null;
    // 左上/左下角向右拖 = 变窄；右上/右下角向右拖 = 变宽。
    const dirSign = st.corner === "ne" || st.corner === "se" ? 1 : -1;
    // Alt 对称缩放：两侧一起动，总变化量 × 2。
    // symmetric 在 handleStart 时被冻结为初始状态；modifierAlt 来自实时的
    // 事件对象（鼠标 move 时的 altKey），两者任意为真即启用。
    const factor = modifierAlt || st.symmetric ? 2 : 1;
    const delta = dirSign * dx * factor;
    return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, st.startWidth + delta));
  }, []);

  // ---------- Mouse handlers ----------
  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      const st = dragStateRef.current;
      if (!st) return;
      const next = computeNextWidth(e.clientX - st.startX, e.altKey);
      if (next != null) setDraftWidth(next);
    },
    [computeNextWidth],
  );

  const handleMouseUp = useCallback(() => {
    const st = dragStateRef.current;
    dragStateRef.current = null;
    window.removeEventListener("mousemove", handleMouseMove);
    window.removeEventListener("mouseup", handleMouseUp);
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
    setDraftWidth((w) => {
      if (w != null && st) {
        commitWidth(w);
      }
      return null;
    });
  }, [handleMouseMove, commitWidth]);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent, corner: Corner) => {
      if (!editable) return;
      e.preventDefault();
      e.stopPropagation();
      const img = imgRef.current;
      const startWidth =
        (typeof initialWidth === "number" && initialWidth) ||
        (img?.getBoundingClientRect().width ?? img?.naturalWidth ?? 300);
      dragStateRef.current = {
        startX: e.clientX,
        startWidth,
        corner,
        symmetric: e.altKey,
      };
      setDraftWidth(startWidth);
      document.body.style.userSelect = "none";
      document.body.style.cursor = corner === "ne" || corner === "sw" ? "nesw-resize" : "nwse-resize";
      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", handleMouseUp);
    },
    [editable, initialWidth, handleMouseMove, handleMouseUp],
  );

  // ---------- Touch handlers ----------
  // 触摸场景下没有 Alt 键的概念；单指拖拽与鼠标拖拽同构，直接映射到 corner。
  const handleTouchMove = useCallback(
    (e: TouchEvent) => {
      const st = dragStateRef.current;
      if (!st) return;
      const t = e.touches[0] ?? e.changedTouches[0];
      if (!t) return;
      // 阻止浏览器因为手势触发页面滚动/缩放（需 passive:false，见 addEventListener）。
      if (e.cancelable) e.preventDefault();
      const next = computeNextWidth(t.clientX - st.startX, false);
      if (next != null) setDraftWidth(next);
    },
    [computeNextWidth],
  );

  const handleTouchEnd = useCallback(() => {
    const st = dragStateRef.current;
    dragStateRef.current = null;
    window.removeEventListener("touchmove", handleTouchMove);
    window.removeEventListener("touchend", handleTouchEnd);
    window.removeEventListener("touchcancel", handleTouchEnd);
    setDraftWidth((w) => {
      if (w != null && st) {
        commitWidth(w);
      }
      return null;
    });
  }, [handleTouchMove, commitWidth]);

  const handleTouchStart = useCallback(
    (e: React.TouchEvent, corner: Corner) => {
      if (!editable) return;
      if (e.touches.length !== 1) return; // 多指留给后续扩展
      e.preventDefault();
      e.stopPropagation();
      const t = e.touches[0];
      const img = imgRef.current;
      const startWidth =
        (typeof initialWidth === "number" && initialWidth) ||
        (img?.getBoundingClientRect().width ?? img?.naturalWidth ?? 300);
      dragStateRef.current = {
        startX: t.clientX,
        startWidth,
        corner,
        symmetric: false,
      };
      setDraftWidth(startWidth);
      // touchmove 需 passive:false 才能 preventDefault，阻止页面随之滚动。
      window.addEventListener("touchmove", handleTouchMove, { passive: false });
      window.addEventListener("touchend", handleTouchEnd);
      window.addEventListener("touchcancel", handleTouchEnd);
    },
    [editable, initialWidth, handleTouchMove, handleTouchEnd],
  );

  // 组件卸载时兜底清理监听（比如拖拽中切换笔记）
  useEffect(() => {
    return () => {
      if (dragStateRef.current) {
        window.removeEventListener("mousemove", handleMouseMove);
        window.removeEventListener("mouseup", handleMouseUp);
        window.removeEventListener("touchmove", handleTouchMove);
        window.removeEventListener("touchend", handleTouchEnd);
        window.removeEventListener("touchcancel", handleTouchEnd);
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
        dragStateRef.current = null;
      }
    };
  }, [handleMouseMove, handleMouseUp, handleTouchMove, handleTouchEnd]);

  // ---------- 图片加载状态 ----------
  const [imgError, setImgError] = useState(false);
  const [blobSrc, setBlobSrc] = useState<string | null>(null);
  const resolvedSrc = resolveAttachmentUrl(src);

  // 对附件路径的图片，使用 fetch + blob URL 来加载，
  // 绕过 Android WebView 混合内容限制。
  useEffect(() => {
    setImgError(false);
    setBlobSrc(null);

    if (!src) return;

    // 只有附件路径且在客户端模式（配置了 serverUrl）才走 blob 通道。
    // data: / blob: / 同源的 http(s): 不需要转换。
    const serverUrl = getServerUrl();
    if (serverUrl && isAttachmentPath(src)) {
      let cancelled = false;
      fetchImageAsBlob(resolvedSrc)
        .then((url) => {
          if (!cancelled) setBlobSrc(url);
        })
        .catch((err) => {
          console.error("[ResizableImageView] blob fetch failed:", {
            originalSrc: src,
            resolvedSrc,
            error: err,
          });
          if (!cancelled) setImgError(true);
        });
      return () => {
        cancelled = true;
      };
    }
    // 非附件路径（data: / blob: / 同源相对路径等）直接用原始 URL
  }, [src, resolvedSrc]);

  // 释放旧的 blob URL
  useEffect(() => {
    return () => {
      if (blobSrc) URL.revokeObjectURL(blobSrc);
    };
  }, [blobSrc]);

  // 最终 img src：优先 blobSrc，否则 resolvedSrc
  const finalSrc = blobSrc || resolvedSrc;

  // 显示用的宽度：拖拽中用 draft，否则用 attribute（null 时交给图片自然宽度）
  const displayWidth = draftWidth ?? (typeof initialWidth === "number" ? initialWidth : null);

  // 手柄样式（inline 以保持该组件"自给自足"，无需改全局 CSS）
  // 移动端手柄略大一些，触控更友好。
  const isCoarsePointer =
    typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)")?.matches;
  const handleSize = isCoarsePointer ? 16 : 10;
  const handleOffset = -Math.floor(handleSize / 2);
  const handleBase: React.CSSProperties = {
    position: "absolute",
    width: handleSize,
    height: handleSize,
    background: "#3b82f6", // tailwind blue-500，与选中高亮色一致
    border: "1.5px solid #ffffff",
    borderRadius: 2,
    boxShadow: "0 0 0 1px rgba(0,0,0,0.08)",
    zIndex: 10,
    userSelect: "none",
    touchAction: "none", // 阻止浏览器将触摸解释为滚动/缩放
  };

  return (
    <NodeViewWrapper
      // data-drag-handle 让 ProseMirror 把整个 wrapper 认作可拖动（保留原生拖拽移动能力）
      data-drag-handle
      className="resizable-image-wrapper"
      // display:inline-block 让尺寸随图片走；my-4 mx-auto 保留原扩展的版式
      style={{
        display: "inline-block",
        position: "relative",
        maxWidth: "100%",
        margin: "1rem auto",
        lineHeight: 0, // 消除基线空隙
        // 选中态加一圈提示框
        outline: selected ? "2px solid #3b82f6" : "none",
        outlineOffset: 2,
        borderRadius: 8,
      }}
      ref={wrapperRef}
    >
      <img
        ref={imgRef}
        // 把 /api/attachments/<id> 这类相对路径补成当前 serverUrl 下的绝对 URL，
        // 保证 Capacitor / 独立前端域 / 分享页这些非同源环境下图片能正确加载。
        // 对 data: / blob: / http(s): 会原样返回。
        src={finalSrc}
        alt={alt ?? ""}
        title={title ?? undefined}
        // 保留原扩展的样式类名，保证阅读态 / 只读预览 / 分享页视觉一致
        className="rounded-lg max-w-full shadow-md"
        // 宽度以 attribute 为准；高度永远不写，让浏览器按比例自算
        width={displayWidth ?? undefined}
        style={{
          display: "block",
          width: displayWidth != null ? `${displayWidth}px` : undefined,
          height: "auto",
          maxWidth: "100%",
          // 外边框：使用 outline 而不是 border，原因：
          //   1) outline 不参与盒模型，不影响图片的实际宽高 / max-width 计算；
          //   2) 不会被 Tailwind preflight / prose 的 img 样式覆盖；
          //   3) 与编辑器内 .ProseMirror img 的 outline 规则保持一致。
          // 这里的 inline 主要在分享页 / 只读预览等不挂 .ProseMirror 类的场景下兜底。
          outline: "1px solid rgba(0, 0, 0, 0.18)",
          outlineOffset: 0,
        }}
        draggable={false}
        onError={() => {
          console.error("[ResizableImageView] img load failed:", {
            originalSrc: src,
            resolvedSrc,
          });
          setImgError(true);
        }}
      />
      {imgError && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "rgba(0,0,0,0.04)",
            borderRadius: 8,
            color: "#888",
            fontSize: 12,
            padding: "8px 12px",
            textAlign: "center",
            wordBreak: "break-all",
          }}
        >
          图片加载失败
          <br />
          <span style={{ fontSize: 10, opacity: 0.7 }}>{resolvedSrc?.slice(0, 80)}</span>
        </div>
      )}

      {/* 四角拖拽手柄：仅在图片被选中 + 可编辑时渲染 */}
      {selected && editable && (
        <div
          // 手柄层不应参与编辑，避免 ProseMirror 把点击解析成位置
          contentEditable={false}
          style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
        >
          <span
            onMouseDown={(e) => handleMouseDown(e, "nw")}
            onTouchStart={(e) => handleTouchStart(e, "nw")}
            style={{
              ...handleBase,
              top: handleOffset,
              left: handleOffset,
              cursor: "nwse-resize",
              pointerEvents: "auto",
            }}
          />
          <span
            onMouseDown={(e) => handleMouseDown(e, "ne")}
            onTouchStart={(e) => handleTouchStart(e, "ne")}
            style={{
              ...handleBase,
              top: handleOffset,
              right: handleOffset,
              cursor: "nesw-resize",
              pointerEvents: "auto",
            }}
          />
          <span
            onMouseDown={(e) => handleMouseDown(e, "sw")}
            onTouchStart={(e) => handleTouchStart(e, "sw")}
            style={{
              ...handleBase,
              bottom: handleOffset,
              left: handleOffset,
              cursor: "nesw-resize",
              pointerEvents: "auto",
            }}
          />
          <span
            onMouseDown={(e) => handleMouseDown(e, "se")}
            onTouchStart={(e) => handleTouchStart(e, "se")}
            style={{
              ...handleBase,
              bottom: handleOffset,
              right: handleOffset,
              cursor: "nwse-resize",
              pointerEvents: "auto",
            }}
          />

          {/* 拖拽时的尺寸提示浮标 */}
          {draftWidth != null && (
            <div
              style={{
                position: "absolute",
                bottom: 6,
                right: 6,
                padding: "2px 6px",
                borderRadius: 4,
                background: "rgba(0,0,0,0.65)",
                color: "#fff",
                fontSize: 11,
                fontFamily:
                  'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
                pointerEvents: "none",
              }}
            >
              {Math.round(draftWidth)}px
              {dragStateRef.current?.symmetric ? " · ⌥" : ""}
            </div>
          )}
        </div>
      )}
    </NodeViewWrapper>
  );
}

export default ResizableImageView;
