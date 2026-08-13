import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import {
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  MoreHorizontal,
  Palette,
  RotateCw,
  Scan,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { registerMobileBackHandler } from "@/lib/mobileBackNavigation";
import { copyText } from "@/lib/clipboard";
import { downloadAttachment } from "@/lib/downloadFile";
import { toast } from "@/lib/toast";
import { normalizeImageFlipX, normalizeImageRotation } from "@/lib/imageNodeTransformBootstrap";

const MIN_SCALE = 1;
const MAX_SCALE = 5;
const DOUBLE_TAP_SCALE = 2.5;
const TAP_MOVE_TOLERANCE_PX = 12;
const DOUBLE_TAP_DELAY_MS = 280;

type Point = { x: number; y: number };

type SinglePointerGesture = {
  pointerId: number;
  start: Point;
  startPosition: Point;
  startedOnImage: boolean;
  suppressTap: boolean;
};

type PinchGesture = {
  distance: number;
  scale: number;
  position: Point;
  imageAnchor: Point;
};

export interface FullscreenImageItem {
  src: string;
  alt?: string;
  filename?: string;
  rotation?: number;
  flipX?: boolean;
}

export interface FullscreenImageViewerProps {
  open: boolean;
  src?: string;
  alt?: string;
  images?: FullscreenImageItem[];
  initialIndex?: number;
  onClose: () => void;
  onIndexChange?: (index: number) => void;
  onDownload?: (item: FullscreenImageItem, index: number) => void | Promise<void>;
  onCopy?: (item: FullscreenImageItem, index: number) => void | Promise<void>;
  canEdit?: boolean;
  onEdit?: (item: FullscreenImageItem, index: number) => void;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function imageFilename(item: FullscreenImageItem, index: number): string {
  if (item.filename?.trim()) return item.filename.trim();
  try {
    const pathname = new URL(item.src, window.location.href).pathname;
    const basename = decodeURIComponent(pathname.split("/").filter(Boolean).pop() || "");
    if (basename && /\.[a-z0-9]{2,8}$/i.test(basename)) return basename;
  } catch {
    // 无法解析的相对地址使用稳定的兜底文件名。
  }
  return `image-${index + 1}.png`;
}

/**
 * Web、Electron 与 Android 共用的全屏图片查看器。
 *
 * 手势区域、关闭按钮和底部工具栏保持为同级节点，避免变换后的图片命中区域
 * 或指针捕获覆盖关闭按钮。
 */
export default function FullscreenImageViewer({
  open,
  src = "",
  alt = "",
  images,
  initialIndex = 0,
  onClose,
  onIndexChange,
  onDownload,
  onCopy,
  canEdit = false,
  onEdit,
}: FullscreenImageViewerProps) {
  const gallery = useMemo<FullscreenImageItem[]>(() => {
    const valid = images?.filter((item) => !!item.src) || [];
    return valid.length ? valid : (src ? [{ src, alt }] : []);
  }, [images, src, alt]);
  const galleryKey = gallery.map((item) => item.src).join("\n");
  const [currentIndex, setCurrentIndex] = useState(0);
  const currentItem = gallery[currentIndex] || gallery[0] || { src: "", alt: "" };
  const baseRotation = normalizeImageRotation(currentItem.rotation);
  const baseFlipX = normalizeImageFlipX(currentItem.flipX);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const pointersRef = useRef(new Map<number, Point>());
  const singleGestureRef = useRef<SinglePointerGesture | null>(null);
  const pinchGestureRef = useRef<PinchGesture | null>(null);
  const scaleRef = useRef(MIN_SCALE);
  const positionRef = useRef<Point>({ x: 0, y: 0 });
  const rotationRef = useRef(0);
  const fitRatioRef = useRef(1);
  const maxScaleRef = useRef(MAX_SCALE);
  const wheelIdleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTapRef = useRef<{ at: number; point: Point } | null>(null);
  const onCloseRef = useRef(onClose);

  const [scale, setScale] = useState(MIN_SCALE);
  const [position, setPosition] = useState<Point>({ x: 0, y: 0 });
  const [rotation, setRotation] = useState(0);
  const [fitRatio, setFitRatio] = useState(1);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [interacting, setInteracting] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  const clampPosition = useCallback((next: Point, nextScale: number): Point => {
    const stage = stageRef.current;
    const image = imageRef.current;
    if (!stage || !image || nextScale <= MIN_SCALE) return { x: 0, y: 0 };

    const sideways = rotationRef.current % 180 !== 0;
    const transformedWidth = (sideways ? image.offsetHeight : image.offsetWidth) * nextScale;
    const transformedHeight = (sideways ? image.offsetWidth : image.offsetHeight) * nextScale;
    const maxX = Math.max(0, (transformedWidth - stage.clientWidth) / 2);
    const maxY = Math.max(0, (transformedHeight - stage.clientHeight) / 2);
    return {
      x: clamp(next.x, -maxX, maxX),
      y: clamp(next.y, -maxY, maxY),
    };
  }, []);

  const commitTransform = useCallback((nextScale: number, nextPosition: Point) => {
    const normalizedScale = clamp(nextScale, MIN_SCALE, maxScaleRef.current);
    const normalizedPosition = clampPosition(nextPosition, normalizedScale);
    scaleRef.current = normalizedScale;
    positionRef.current = normalizedPosition;
    setScale(normalizedScale);
    setPosition(normalizedPosition);
  }, [clampPosition]);

  const updateFitRatio = useCallback(() => {
    const image = imageRef.current;
    if (!image?.naturalWidth || !image.offsetWidth) return;
    const next = clamp(image.offsetWidth / image.naturalWidth, 0.01, 1);
    fitRatioRef.current = next;
    maxScaleRef.current = Math.max(MAX_SCALE, 1 / next);
    setFitRatio((current) => Math.abs(current - next) < 0.001 ? current : next);
  }, []);

  const resetTransform = useCallback(() => {
    rotationRef.current = baseRotation;
    setRotation(baseRotation);
    commitTransform(MIN_SCALE, { x: 0, y: 0 });
  }, [baseRotation, commitTransform]);

  const navigateGallery = useCallback((delta: -1 | 1) => {
    const next = clamp(currentIndex + delta, 0, Math.max(0, gallery.length - 1));
    if (next === currentIndex) return;
    resetTransform();
    setMoreOpen(false);
    setControlsVisible(true);
    setCurrentIndex(next);
  }, [currentIndex, gallery.length, resetTransform]);

  const rotateClockwise = useCallback(() => {
    const nextRotation = (rotationRef.current + 90) % 360;
    rotationRef.current = nextRotation;
    setRotation(nextRotation);
    setInteracting(false);
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    updateFitRatio();
    commitTransform(scaleRef.current, positionRef.current);
  }, [open, rotation, commitTransform, updateFitRatio]);

  const closeViewer = useCallback(() => {
    if (wheelIdleTimerRef.current) {
      clearTimeout(wheelIdleTimerRef.current);
      wheelIdleTimerRef.current = null;
    }
    pointersRef.current.clear();
    singleGestureRef.current = null;
    pinchGestureRef.current = null;
    lastTapRef.current = null;
    setInteracting(false);
    setControlsVisible(true);
    setMoreOpen(false);
    resetTransform();
    onCloseRef.current();
  }, [resetTransform]);

  useLayoutEffect(() => {
    if (!open) return;
    const nextIndex = clamp(initialIndex, 0, Math.max(0, gallery.length - 1));
    setCurrentIndex(nextIndex);
  }, [open, galleryKey, gallery.length, initialIndex]);

  useEffect(() => {
    if (open) onIndexChange?.(currentIndex);
  }, [currentIndex, onIndexChange, open]);

  useEffect(() => {
    if (!open) return;
    setControlsVisible(true);
    resetTransform();

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeViewer();
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        navigateGallery(-1);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        navigateGallery(1);
      }
    };
    window.addEventListener("keydown", onKeyDown);

    const unregisterBackHandler = registerMobileBackHandler("image-viewer", () => {
      if (!document.querySelector("[data-nowen-mobile-image-viewer]")) return false;
      closeViewer();
      return true;
    });

    const handleResize = () => {
      commitTransform(scaleRef.current, positionRef.current);
    };
    window.addEventListener("resize", handleResize);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", handleResize);
      unregisterBackHandler();
    };
  }, [open, currentItem.src, closeViewer, commitTransform, navigateGallery, resetTransform]);

  const zoomAroundPoint = useCallback((nextScale: number, clientPoint?: Point) => {
    const stage = stageRef.current;
    const currentScale = scaleRef.current;
    const currentPosition = positionRef.current;
    const normalizedScale = clamp(nextScale, MIN_SCALE, maxScaleRef.current);
    if (Math.abs(normalizedScale - currentScale) < 0.001) return;

    if (!stage || !clientPoint || normalizedScale === MIN_SCALE) {
      commitTransform(normalizedScale, normalizedScale === MIN_SCALE ? { x: 0, y: 0 } : currentPosition);
      return;
    }

    const rect = stage.getBoundingClientRect();
    const stagePoint = {
      x: clientPoint.x - rect.left - rect.width / 2,
      y: clientPoint.y - rect.top - rect.height / 2,
    };
    const imagePoint = {
      x: (stagePoint.x - currentPosition.x) / currentScale,
      y: (stagePoint.y - currentPosition.y) / currentScale,
    };
    commitTransform(normalizedScale, {
      x: stagePoint.x - imagePoint.x * normalizedScale,
      y: stagePoint.y - imagePoint.y * normalizedScale,
    });
  }, [commitTransform]);

  const handleImageTap = useCallback((point: Point) => {
    const now = Date.now();
    const previous = lastTapRef.current;
    const isDoubleTap = !!previous
      && now - previous.at <= DOUBLE_TAP_DELAY_MS
      && distance(previous.point, point) <= 36;

    if (isDoubleTap) {
      lastTapRef.current = null;
      const oneToOneScale = clamp(1 / fitRatioRef.current, MIN_SCALE, maxScaleRef.current);
      const nextScale = scaleRef.current > MIN_SCALE + 0.01
        ? MIN_SCALE
        : (oneToOneScale > MIN_SCALE + 0.01 ? oneToOneScale : DOUBLE_TAP_SCALE);
      zoomAroundPoint(nextScale, point);
      setControlsVisible(true);
      return;
    }

    lastTapRef.current = { at: now, point };
    setControlsVisible((visible) => !visible);
  }, [zoomAroundPoint]);

  const handlePointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();

    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // 部分 Android WebView 在第二根手指加入时会拒绝指针捕获。
    }

    const point = { x: event.clientX, y: event.clientY };
    pointersRef.current.set(event.pointerId, point);
    const points = Array.from(pointersRef.current.values());

    if (points.length >= 2) {
      const [first, second] = points;
      const center = midpoint(first, second);
      const stage = stageRef.current?.getBoundingClientRect();
      const stageCenter = stage
        ? { x: center.x - stage.left - stage.width / 2, y: center.y - stage.top - stage.height / 2 }
        : { x: 0, y: 0 };
      const currentScale = scaleRef.current;
      const currentPosition = positionRef.current;
      pinchGestureRef.current = {
        distance: Math.max(1, distance(first, second)),
        scale: currentScale,
        position: currentPosition,
        imageAnchor: {
          x: (stageCenter.x - currentPosition.x) / currentScale,
          y: (stageCenter.y - currentPosition.y) / currentScale,
        },
      };
      singleGestureRef.current = null;
      setInteracting(true);
      return;
    }

    const startedOnImage = event.target instanceof Element
      && !!event.target.closest("[data-nowen-image-viewer-image]");
    singleGestureRef.current = {
      pointerId: event.pointerId,
      start: point,
      startPosition: positionRef.current,
      startedOnImage,
      suppressTap: false,
    };
    setInteracting(scaleRef.current > MIN_SCALE);
  }, []);

  const handlePointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!pointersRef.current.has(event.pointerId)) return;
    event.preventDefault();
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const points = Array.from(pointersRef.current.values());

    if (points.length >= 2 && pinchGestureRef.current) {
      const [first, second] = points;
      const pinch = pinchGestureRef.current;
      const center = midpoint(first, second);
      const stage = stageRef.current?.getBoundingClientRect();
      if (!stage) return;
      const stageCenter = {
        x: center.x - stage.left - stage.width / 2,
        y: center.y - stage.top - stage.height / 2,
      };
      const nextScale = clamp(
        pinch.scale * (distance(first, second) / pinch.distance),
        MIN_SCALE,
        maxScaleRef.current,
      );
      commitTransform(nextScale, {
        x: stageCenter.x - pinch.imageAnchor.x * nextScale,
        y: stageCenter.y - pinch.imageAnchor.y * nextScale,
      });
      return;
    }

    const single = singleGestureRef.current;
    if (!single || single.pointerId !== event.pointerId || scaleRef.current <= MIN_SCALE) return;
    commitTransform(scaleRef.current, {
      x: single.startPosition.x + event.clientX - single.start.x,
      y: single.startPosition.y + event.clientY - single.start.y,
    });
  }, [commitTransform]);

  const finishPointer = useCallback((event: React.PointerEvent<HTMLDivElement>, cancelled = false) => {
    const single = singleGestureRef.current;
    const point = { x: event.clientX, y: event.clientY };
    pointersRef.current.delete(event.pointerId);

    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch {
      // 原生 WebView 可能已经取消了该指针。
    }

    if (pinchGestureRef.current) {
      if (pointersRef.current.size < 2) pinchGestureRef.current = null;
      const remaining = Array.from(pointersRef.current.entries())[0];
      if (remaining) {
        singleGestureRef.current = {
          pointerId: remaining[0],
          start: remaining[1],
          startPosition: positionRef.current,
          startedOnImage: true,
          suppressTap: true,
        };
      }
      setInteracting(pointersRef.current.size > 0);
      return;
    }

    singleGestureRef.current = null;
    setInteracting(false);
    if (cancelled || !single || single.pointerId !== event.pointerId || single.suppressTap) return;
    if (distance(single.start, point) > TAP_MOVE_TOLERANCE_PX) {
      if (scaleRef.current <= MIN_SCALE) {
        const dx = point.x - single.start.x;
        const dy = point.y - single.start.y;
        if (Math.abs(dx) >= 48 && Math.abs(dx) > Math.abs(dy) * 1.15) {
          navigateGallery(dx < 0 ? 1 : -1);
        }
      }
      return;
    }

    if (!single.startedOnImage) closeViewer();
    else handleImageTap(point);
  }, [closeViewer, handleImageTap, navigateGallery]);

  const handleWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    const delta = event.deltaY < 0 ? 0.25 : -0.25;
    setInteracting(true);
    zoomAroundPoint(scaleRef.current + delta, { x: event.clientX, y: event.clientY });
    if (wheelIdleTimerRef.current) clearTimeout(wheelIdleTimerRef.current);
    wheelIdleTimerRef.current = setTimeout(() => {
      wheelIdleTimerRef.current = null;
      setInteracting(false);
    }, 90);
  }, [zoomAroundPoint]);

  const handleDownload = useCallback(async () => {
    if (!currentItem.src) return;
    try {
      if (onDownload) await onDownload(currentItem, currentIndex);
      else await downloadAttachment(currentItem.src, imageFilename(currentItem, currentIndex));
    } catch (error) {
      console.error("[FullscreenImageViewer] download failed:", error);
      toast.error("图片下载失败");
    }
  }, [currentIndex, currentItem, onDownload]);

  const handleCopy = useCallback(async () => {
    if (!currentItem.src) return;
    try {
      if (onCopy) await onCopy(currentItem, currentIndex);
      else if (!(await copyText(currentItem.src))) throw new Error("copy failed");
      toast.success("图片地址已复制");
      setMoreOpen(false);
    } catch (error) {
      console.error("[FullscreenImageViewer] copy failed:", error);
      toast.error("复制图片地址失败");
    }
  }, [currentIndex, currentItem, onCopy]);

  const openOriginal = useCallback(() => {
    if (!currentItem.src) return;
    window.open(currentItem.src, "_blank", "noopener,noreferrer");
    setMoreOpen(false);
  }, [currentItem.src]);

  const handleEdit = useCallback(() => {
    if (!canEdit || !onEdit) return;
    const item = currentItem;
    const index = currentIndex;
    closeViewer();
    onEdit(item, index);
  }, [canEdit, closeViewer, currentIndex, currentItem, onEdit]);

  const toggleScaleMode = useCallback(() => {
    const oneToOneScale = clamp(1 / fitRatioRef.current, MIN_SCALE, maxScaleRef.current);
    if (scaleRef.current > MIN_SCALE + 0.01) {
      zoomAroundPoint(MIN_SCALE);
      return;
    }
    zoomAroundPoint(oneToOneScale > MIN_SCALE + 0.01 ? oneToOneScale : DOUBLE_TAP_SCALE);
  }, [zoomAroundPoint]);

  const handleClosePointerDown = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    closeViewer();
  }, [closeViewer]);

  if (typeof document === "undefined") return null;

  const hasTransform = scale > MIN_SCALE + 0.01
    || rotation !== baseRotation
    || Math.abs(position.x) > 0.5
    || Math.abs(position.y) > 0.5;
  const displayPercent = Math.max(1, Math.round(fitRatio * scale * 100));

  return createPortal(
    <AnimatePresence>
    {open && currentItem.src && (
    <motion.section
      key="fullscreen-image-viewer"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.16, ease: "easeOut" }}
      role="dialog"
      aria-modal="true"
      aria-label="图片预览"
      data-nowen-mobile-image-viewer=""
      data-nowen-fullscreen-image-viewer=""
      className="fixed inset-0 z-[1000] overflow-hidden bg-black/[0.92] backdrop-blur-sm"
    >
      <div
        ref={stageRef}
        className="absolute inset-0 z-0 flex items-center justify-center overflow-hidden"
        style={{
          touchAction: "none",
          cursor: scale > MIN_SCALE ? (interacting ? "grabbing" : "grab") : "zoom-in",
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={(event) => finishPointer(event)}
        onPointerCancel={(event) => finishPointer(event, true)}
        onWheel={handleWheel}
      >
        <img
          key={currentItem.src}
          ref={imageRef}
          src={currentItem.src}
          alt={currentItem.alt || ""}
          draggable={false}
          data-nowen-image-viewer-image=""
          className="max-h-[calc(100dvh-32px)] max-w-[calc(100vw-24px)] select-none object-contain will-change-transform animate-in zoom-in-95 duration-150"
          style={{
            maxWidth: rotation % 180 !== 0 ? "calc(100dvh - 32px)" : "calc(100vw - 24px)",
            maxHeight: rotation % 180 !== 0 ? "calc(100vw - 24px)" : "calc(100dvh - 32px)",
            transform: `translate3d(${position.x}px, ${position.y}px, 0) scale(${scale}) rotate(${rotation}deg)${baseFlipX ? " scaleX(-1)" : ""}`,
            transformOrigin: "center center",
            transition: interacting ? "none" : "transform 140ms ease-out",
          }}
          onLoad={() => {
            updateFitRatio();
            commitTransform(scaleRef.current, positionRef.current);
          }}
        />
      </div>

      {gallery.length > 1 && (
        <div
          className={`fixed left-3 z-[1020] rounded-full bg-black/55 px-3 py-1.5 text-xs font-medium text-white/90 backdrop-blur-md transition-opacity duration-150 ${controlsVisible ? "opacity-100" : "pointer-events-none opacity-0"}`}
          style={{ top: "calc(env(safe-area-inset-top, 0px) + 18px)" }}
          aria-live="polite"
        >
          {currentIndex + 1} / {gallery.length}
        </div>
      )}

      {gallery.length > 1 && (
        <>
          <button
            type="button"
            aria-label="上一张图片"
            disabled={currentIndex === 0}
            onClick={(event) => { event.stopPropagation(); navigateGallery(-1); }}
            className={`fixed left-2 top-1/2 z-[1010] hidden h-12 w-12 -translate-y-1/2 items-center justify-center rounded-full bg-black/55 text-white shadow-lg backdrop-blur-md transition-all duration-150 hover:bg-black/70 disabled:pointer-events-none disabled:opacity-20 sm:left-4 sm:flex ${controlsVisible ? "opacity-100" : "pointer-events-none -translate-x-2 opacity-0"}`}
          >
            <ChevronLeft size={28} />
          </button>
          <button
            type="button"
            aria-label="下一张图片"
            disabled={currentIndex === gallery.length - 1}
            onClick={(event) => { event.stopPropagation(); navigateGallery(1); }}
            className={`fixed right-2 top-1/2 z-[1010] hidden h-12 w-12 -translate-y-1/2 items-center justify-center rounded-full bg-black/55 text-white shadow-lg backdrop-blur-md transition-all duration-150 hover:bg-black/70 disabled:pointer-events-none disabled:opacity-20 sm:right-4 sm:flex ${controlsVisible ? "opacity-100" : "pointer-events-none translate-x-2 opacity-0"}`}
          >
            <ChevronRight size={28} />
          </button>
        </>
      )}

      <button
        type="button"
        aria-label="关闭图片预览"
        title="关闭"
        className={`fixed right-3 z-[1020] flex h-12 w-12 items-center justify-center rounded-full bg-black/60 text-white shadow-xl ring-1 ring-white/15 backdrop-blur-md transition-all duration-150 active:bg-black/80 sm:h-14 sm:w-14 ${controlsVisible ? "opacity-100" : "pointer-events-none -translate-y-2 opacity-0"}`}
        style={{ top: "calc(env(safe-area-inset-top, 0px) + 10px)", touchAction: "manipulation" }}
        onPointerDown={handleClosePointerDown}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          closeViewer();
        }}
      >
        <X size={28} strokeWidth={2.2} />
      </button>

      <div
        className={`fixed left-1/2 z-[1010] flex max-w-[calc(100vw-12px)] -translate-x-1/2 items-center gap-0.5 rounded-full border border-white/10 bg-black/65 px-1 py-1.5 text-white shadow-2xl backdrop-blur-md transition-all duration-150 sm:gap-1 sm:px-2 ${controlsVisible ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-3 opacity-0"}`}
        style={{ bottom: "calc(env(safe-area-inset-bottom, 0px) + 14px)", touchAction: "manipulation" }}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          aria-label="缩小图片"
          className="flex h-10 w-9 items-center justify-center rounded-full transition-colors hover:bg-white/10 active:bg-white/15 disabled:opacity-35 sm:h-11 sm:w-11"
          disabled={scale <= MIN_SCALE}
          onClick={() => zoomAroundPoint(scaleRef.current - 0.25)}
        >
          <ZoomOut size={20} />
        </button>
        <button
          type="button"
          aria-label="在适应窗口和原始比例之间切换"
          title="适应窗口 / 1:1"
          onClick={toggleScaleMode}
          className="min-w-[44px] select-none rounded-full px-1 py-2 text-center font-mono text-xs tabular-nums text-white/90 transition-colors hover:bg-white/10 sm:min-w-[56px] sm:px-1.5 sm:text-sm"
        >
          {displayPercent}%
        </button>
        <button
          type="button"
          aria-label="放大图片"
          className="flex h-10 w-9 items-center justify-center rounded-full transition-colors hover:bg-white/10 active:bg-white/15 disabled:opacity-35 sm:h-11 sm:w-11"
          disabled={scale >= maxScaleRef.current - 0.01}
          onClick={() => zoomAroundPoint(scaleRef.current + 0.25)}
        >
          <ZoomIn size={20} />
        </button>
        <button
          type="button"
          aria-label="顺时针旋转图片"
          title="顺时针旋转 90°"
          className="flex h-10 w-9 items-center justify-center rounded-full transition-colors hover:bg-white/10 active:bg-white/15 sm:h-11 sm:w-11"
          onClick={rotateClockwise}
        >
          <RotateCw size={20} />
        </button>
        <button
          type="button"
          aria-label="复原图片预览"
          title="复原缩放、旋转和位置"
          disabled={!hasTransform}
          className="flex h-10 w-9 items-center justify-center rounded-full transition-colors hover:bg-white/10 active:bg-white/15 disabled:opacity-35 sm:h-11 sm:w-11"
          onClick={resetTransform}
        >
          <Scan size={20} />
        </button>
        {canEdit && onEdit && (
          <button
            type="button"
            aria-label="编辑图片"
            title="编辑图片"
            className="flex h-10 w-9 items-center justify-center rounded-full transition-colors hover:bg-white/10 active:bg-white/15 sm:h-11 sm:w-11"
            onClick={handleEdit}
          >
            <Palette size={19} />
          </button>
        )}
        <button
          type="button"
          aria-label="下载图片"
          title="下载"
          className="hidden h-10 w-10 items-center justify-center rounded-full transition-colors hover:bg-white/10 active:bg-white/15 sm:flex sm:h-11 sm:w-11"
          onClick={() => { void handleDownload(); }}
        >
          <Download size={19} />
        </button>
        <div className="relative">
          <button
            type="button"
            aria-label="更多图片操作"
            title="更多"
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen((value) => !value)}
            className={`flex h-10 w-9 items-center justify-center rounded-full transition-colors active:bg-white/15 sm:h-11 sm:w-11 ${moreOpen ? "bg-white/15" : "hover:bg-white/10"}`}
          >
            <MoreHorizontal size={20} />
          </button>
          {moreOpen && (
            <div className="absolute bottom-full right-0 mb-2 w-44 overflow-hidden rounded-xl border border-white/10 bg-black/80 p-1.5 text-sm text-white shadow-2xl backdrop-blur-xl animate-in fade-in slide-in-from-bottom-1 duration-150">
              <button
                type="button"
                onClick={() => { void handleDownload(); setMoreOpen(false); }}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left hover:bg-white/10 sm:hidden"
              >
                <Download size={16} /> 下载图片
              </button>
              <button
                type="button"
                onClick={() => { void handleCopy(); }}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left hover:bg-white/10"
              >
                <Copy size={16} /> 复制图片地址
              </button>
              <button
                type="button"
                onClick={openOriginal}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left hover:bg-white/10"
              >
                <ExternalLink size={16} /> 查看原图
              </button>
            </div>
          )}
        </div>
      </div>
    </motion.section>
    )}
    </AnimatePresence>,
    document.body,
  );
}
