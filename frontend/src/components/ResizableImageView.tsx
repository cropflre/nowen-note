import React, { useCallback, useEffect, useRef, useState } from "react";
import { NodeViewWrapper, NodeViewProps } from "@tiptap/react";
import { resolveAttachmentUrl, getServerUrl } from "@/lib/api";
import {
  getPersistentImageTransform,
  normalizeImageFlipX,
  normalizeImageRotation,
} from "@/lib/imageNodeTransformBootstrap";
import { useLazyNodeView } from "@/hooks/useLazyNodeView";

/** 判断是否为本应用的附件路径（/api/attachments/xxx）。 */
function isAttachmentPath(src: string): boolean {
  if (!src) return false;
  return /^\/?api\/attachments\//.test(src) || src.includes("/api/attachments/");
}

/**
 * 通过 fetch 下载图片并生成 blob URL，绕过 Android WebView 的混合内容限制。
 */
async function fetchImageAsBlob(url: string): Promise<string> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`fetch image failed: ${resp.status}`);
  const blob = await resp.blob();
  return URL.createObjectURL(blob);
}

/**
 * Tiptap Image 扩展的自定义 NodeView。
 *
 * 大文档模式下 wrapper 仍始终存在，保证 ProseMirror position、选区和事务连续；
 * 只有图片请求、解码和内部 DOM 会延迟到节点接近视口时执行。
 */
type Corner = "nw" | "ne" | "sw" | "se";

const MIN_WIDTH = 40;
const MAX_WIDTH = 4000;

export function ResizableImageView(props: NodeViewProps) {
  const { node, updateAttributes, selected, editor } = props;
  const { src, alt, title } = node.attrs as { src?: string; alt?: string; title?: string };
  const initialWidth = (node.attrs as { width?: number | string | null }).width ?? null;
  const rotation = normalizeImageRotation(node.attrs.rotation);
  const flipX = normalizeImageFlipX(node.attrs.flipX);
  const persistentTransform = getPersistentImageTransform(rotation, flipX);

  const imgRef = useRef<HTMLImageElement | null>(null);
  const wrapperRef = useRef<HTMLSpanElement | null>(null);
  const {
    lazyEnabled,
    shouldRenderHeavyContent,
    observeRef,
  } = useLazyNodeView<HTMLSpanElement>({ forceMount: selected });
  const setWrapperElement = useCallback((element: HTMLSpanElement | null) => {
    wrapperRef.current = element;
    observeRef(element);
  }, [observeRef]);

  // 拖拽过程中的临时宽度。未在拖拽时为 null，渲染走 attribute 的 width。
  const [draftWidth, setDraftWidth] = useState<number | null>(null);
  const dragStateRef = useRef<{
    startX: number;
    startWidth: number;
    corner: Corner;
    symmetric: boolean;
  } | null>(null);

  const editable = editor?.isEditable ?? true;

  const commitWidth = useCallback(
    (w: number) => {
      const clamped = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(w)));
      updateAttributes({ width: clamped });
    },
    [updateAttributes],
  );

  const computeNextWidth = useCallback((dx: number, modifierAlt: boolean) => {
    const st = dragStateRef.current;
    if (!st) return null;
    const dirSign = st.corner === "ne" || st.corner === "se" ? 1 : -1;
    const factor = modifierAlt || st.symmetric ? 2 : 1;
    return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, st.startWidth + dirSign * dx * factor));
  }, []);

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
      if (w != null && st) commitWidth(w);
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
        (typeof initialWidth === "number" && initialWidth)
        || (img?.getBoundingClientRect().width ?? img?.naturalWidth ?? 300);
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

  const handleTouchMove = useCallback(
    (e: TouchEvent) => {
      const st = dragStateRef.current;
      if (!st) return;
      const touch = e.touches[0] ?? e.changedTouches[0];
      if (!touch) return;
      if (e.cancelable) e.preventDefault();
      const next = computeNextWidth(touch.clientX - st.startX, false);
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
      if (w != null && st) commitWidth(w);
      return null;
    });
  }, [handleTouchMove, commitWidth]);

  const handleTouchStart = useCallback(
    (e: React.TouchEvent, corner: Corner) => {
      if (!editable || e.touches.length !== 1) return;
      e.preventDefault();
      e.stopPropagation();
      const touch = e.touches[0];
      const img = imgRef.current;
      const startWidth =
        (typeof initialWidth === "number" && initialWidth)
        || (img?.getBoundingClientRect().width ?? img?.naturalWidth ?? 300);
      dragStateRef.current = {
        startX: touch.clientX,
        startWidth,
        corner,
        symmetric: false,
      };
      setDraftWidth(startWidth);
      window.addEventListener("touchmove", handleTouchMove, { passive: false });
      window.addEventListener("touchend", handleTouchEnd);
      window.addEventListener("touchcancel", handleTouchEnd);
    },
    [editable, initialWidth, handleTouchMove, handleTouchEnd],
  );

  useEffect(() => () => {
    if (!dragStateRef.current) return;
    window.removeEventListener("mousemove", handleMouseMove);
    window.removeEventListener("mouseup", handleMouseUp);
    window.removeEventListener("touchmove", handleTouchMove);
    window.removeEventListener("touchend", handleTouchEnd);
    window.removeEventListener("touchcancel", handleTouchEnd);
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
    dragStateRef.current = null;
  }, [handleMouseMove, handleMouseUp, handleTouchMove, handleTouchEnd]);

  const [imgError, setImgError] = useState(false);
  const [blobSrc, setBlobSrc] = useState<string | null>(null);
  const resolvedSrc = resolveAttachmentUrl(src);

  // In progressive modes an offscreen attachment image must not start a fetch/blob conversion.
  useEffect(() => {
    setImgError(false);
    setBlobSrc(null);
    if (!src || !shouldRenderHeavyContent) return;

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
  }, [src, resolvedSrc, shouldRenderHeavyContent]);

  useEffect(() => () => {
    if (blobSrc) URL.revokeObjectURL(blobSrc);
  }, [blobSrc]);

  const finalSrc = blobSrc || resolvedSrc;
  const displayWidth = draftWidth ?? (typeof initialWidth === "number" ? initialWidth : null);
  const placeholderWidth = Math.max(120, Math.min(displayWidth || 320, 640));
  const placeholderHeight = Math.max(96, Math.min(Math.round(placeholderWidth * 0.56), 360));

  const isCoarsePointer =
    typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)")?.matches;
  const handleSize = isCoarsePointer ? 16 : 10;
  const handleOffset = -Math.floor(handleSize / 2);
  const handleBase: React.CSSProperties = {
    position: "absolute",
    width: handleSize,
    height: handleSize,
    background: "#3b82f6",
    border: "1.5px solid #ffffff",
    borderRadius: 2,
    boxShadow: "0 0 0 1px rgba(0,0,0,0.08)",
    zIndex: 10,
    userSelect: "none",
    touchAction: "none",
  };

  return (
    <NodeViewWrapper
      as="span"
      data-drag-handle
      data-image-rotation={rotation}
      data-image-flip-x={flipX ? "true" : "false"}
      data-heavy-node-state={shouldRenderHeavyContent ? "mounted" : "deferred"}
      className="resizable-image-wrapper"
      style={{
        display: "inline-block",
        position: "relative",
        maxWidth: "100%",
        margin: "0.25rem 0.375rem",
        lineHeight: 0,
        outline: selected ? "2px solid #3b82f6" : "none",
        outlineOffset: 2,
        borderRadius: 8,
        transform: persistentTransform || undefined,
        transformOrigin: "center center",
        transition: "transform 160ms ease",
        contentVisibility: lazyEnabled ? "auto" : undefined,
        containIntrinsicSize: lazyEnabled ? `auto ${placeholderHeight}px` : undefined,
      }}
      ref={setWrapperElement}
    >
      {shouldRenderHeavyContent ? (
        <img
          ref={imgRef}
          src={finalSrc}
          alt={alt ?? ""}
          title={title ?? undefined}
          loading="lazy"
          decoding="async"
          className="rounded-lg max-w-full shadow-md"
          width={displayWidth ?? undefined}
          style={{
            display: "block",
            width: displayWidth != null ? `${displayWidth}px` : undefined,
            height: "auto",
            maxWidth: "100%",
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
      ) : (
        <span
          contentEditable={false}
          aria-label="图片将在滚动到附近时加载"
          style={{
            display: "inline-flex",
            width: placeholderWidth,
            maxWidth: "100%",
            height: placeholderHeight,
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 8,
            border: "1px solid rgba(128,128,128,0.22)",
            background: "rgba(128,128,128,0.06)",
            color: "rgba(128,128,128,0.75)",
            fontSize: 12,
            lineHeight: 1.4,
          }}
        >
          图片将在滚动到附近时加载
        </span>
      )}

      {shouldRenderHeavyContent && imgError && (
        <span
          contentEditable={false}
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
        </span>
      )}

      {shouldRenderHeavyContent && selected && editable && (
        <span contentEditable={false} style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
          <span
            onMouseDown={(e) => handleMouseDown(e, "nw")}
            onTouchStart={(e) => handleTouchStart(e, "nw")}
            style={{ ...handleBase, top: handleOffset, left: handleOffset, cursor: "nwse-resize", pointerEvents: "auto" }}
          />
          <span
            onMouseDown={(e) => handleMouseDown(e, "ne")}
            onTouchStart={(e) => handleTouchStart(e, "ne")}
            style={{ ...handleBase, top: handleOffset, right: handleOffset, cursor: "nesw-resize", pointerEvents: "auto" }}
          />
          <span
            onMouseDown={(e) => handleMouseDown(e, "sw")}
            onTouchStart={(e) => handleTouchStart(e, "sw")}
            style={{ ...handleBase, bottom: handleOffset, left: handleOffset, cursor: "nesw-resize", pointerEvents: "auto" }}
          />
          <span
            onMouseDown={(e) => handleMouseDown(e, "se")}
            onTouchStart={(e) => handleTouchStart(e, "se")}
            style={{ ...handleBase, bottom: handleOffset, right: handleOffset, cursor: "nwse-resize", pointerEvents: "auto" }}
          />

          {draftWidth != null && (
            <span
              contentEditable={false}
              style={{
                position: "absolute",
                bottom: 6,
                right: 6,
                padding: "2px 6px",
                borderRadius: 4,
                background: "rgba(0,0,0,0.65)",
                color: "#fff",
                fontSize: 11,
                fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
                pointerEvents: "none",
              }}
            >
              {Math.round(draftWidth)}px
              {dragStateRef.current?.symmetric ? " · ⌥" : ""}
            </span>
          )}
        </span>
      )}
    </NodeViewWrapper>
  );
}

export default ResizableImageView;
