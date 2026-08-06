import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { App as CapacitorApp } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import { RotateCcw, X, ZoomIn, ZoomOut } from "lucide-react";

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

export interface MobileImageViewerProps {
  open: boolean;
  src: string;
  alt?: string;
  onClose: () => void;
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

/**
 * Shared full-screen image viewer for Android and mobile web.
 *
 * The gesture stage, close button and bottom controls are siblings. This keeps transformed
 * image hit testing and pointer capture from covering or stealing the close button.
 */
export default function MobileImageViewer({ open, src, alt = "", onClose }: MobileImageViewerProps) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const pointersRef = useRef(new Map<number, Point>());
  const singleGestureRef = useRef<SinglePointerGesture | null>(null);
  const pinchGestureRef = useRef<PinchGesture | null>(null);
  const scaleRef = useRef(MIN_SCALE);
  const positionRef = useRef<Point>({ x: 0, y: 0 });
  const lastTapRef = useRef<{ at: number; point: Point } | null>(null);
  const onCloseRef = useRef(onClose);

  const [scale, setScale] = useState(MIN_SCALE);
  const [position, setPosition] = useState<Point>({ x: 0, y: 0 });
  const [controlsVisible, setControlsVisible] = useState(true);
  const [interacting, setInteracting] = useState(false);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  const clampPosition = useCallback((next: Point, nextScale: number): Point => {
    const stage = stageRef.current;
    const image = imageRef.current;
    if (!stage || !image || nextScale <= MIN_SCALE) return { x: 0, y: 0 };

    const maxX = Math.max(0, (image.offsetWidth * nextScale - stage.clientWidth) / 2);
    const maxY = Math.max(0, (image.offsetHeight * nextScale - stage.clientHeight) / 2);
    return {
      x: clamp(next.x, -maxX, maxX),
      y: clamp(next.y, -maxY, maxY),
    };
  }, []);

  const commitTransform = useCallback((nextScale: number, nextPosition: Point) => {
    const normalizedScale = clamp(nextScale, MIN_SCALE, MAX_SCALE);
    const normalizedPosition = clampPosition(nextPosition, normalizedScale);
    scaleRef.current = normalizedScale;
    positionRef.current = normalizedPosition;
    setScale(normalizedScale);
    setPosition(normalizedPosition);
  }, [clampPosition]);

  const resetTransform = useCallback(() => {
    commitTransform(MIN_SCALE, { x: 0, y: 0 });
  }, [commitTransform]);

  const closeViewer = useCallback(() => {
    pointersRef.current.clear();
    singleGestureRef.current = null;
    pinchGestureRef.current = null;
    lastTapRef.current = null;
    setInteracting(false);
    setControlsVisible(true);
    resetTransform();
    onCloseRef.current();
  }, [resetTransform]);

  useEffect(() => {
    if (!open) return;
    setControlsVisible(true);
    resetTransform();

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeViewer();
    };
    window.addEventListener("keydown", onKeyDown);

    let disposed = false;
    let removeBackButton: (() => void) | null = null;
    if (Capacitor.isNativePlatform()) {
      void CapacitorApp.addListener("backButton", () => closeViewer())
        .then((handle) => {
          if (disposed) void handle.remove();
          else removeBackButton = () => void handle.remove();
        })
        .catch(() => {});
    }

    const handleResize = () => {
      commitTransform(scaleRef.current, positionRef.current);
    };
    window.addEventListener("resize", handleResize);

    return () => {
      disposed = true;
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", handleResize);
      removeBackButton?.();
    };
  }, [open, closeViewer, commitTransform, resetTransform]);

  const zoomAroundPoint = useCallback((nextScale: number, clientPoint?: Point) => {
    const stage = stageRef.current;
    const currentScale = scaleRef.current;
    const currentPosition = positionRef.current;
    const normalizedScale = clamp(nextScale, MIN_SCALE, MAX_SCALE);

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
      const nextScale = scaleRef.current > MIN_SCALE + 0.01 ? MIN_SCALE : DOUBLE_TAP_SCALE;
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
      // Some Android WebViews reject pointer capture while another touch is being added.
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
        MAX_SCALE,
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
      // Pointer may already have been cancelled by the native WebView.
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
    if (distance(single.start, point) > TAP_MOVE_TOLERANCE_PX) return;

    if (!single.startedOnImage) closeViewer();
    else handleImageTap(point);
  }, [closeViewer, handleImageTap]);

  const handleWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    const delta = event.deltaY < 0 ? 0.25 : -0.25;
    zoomAroundPoint(scaleRef.current + delta, { x: event.clientX, y: event.clientY });
  }, [zoomAroundPoint]);

  const handleClosePointerDown = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    closeViewer();
  }, [closeViewer]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <section
      role="dialog"
      aria-modal="true"
      aria-label="图片预览"
      data-nowen-mobile-image-viewer=""
      className="fixed inset-0 z-[1000] overflow-hidden bg-black/90 backdrop-blur-sm"
    >
      <div
        ref={stageRef}
        className="absolute inset-0 z-0 flex items-center justify-center overflow-hidden"
        style={{ touchAction: "none" }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={(event) => finishPointer(event)}
        onPointerCancel={(event) => finishPointer(event, true)}
        onWheel={handleWheel}
      >
        <img
          ref={imageRef}
          src={src}
          alt={alt}
          draggable={false}
          data-nowen-image-viewer-image=""
          className="max-h-[calc(100dvh-32px)] max-w-[calc(100vw-24px)] select-none object-contain will-change-transform"
          style={{
            transform: `translate3d(${position.x}px, ${position.y}px, 0) scale(${scale})`,
            transformOrigin: "center center",
            transition: interacting ? "none" : "transform 140ms ease-out",
          }}
          onLoad={() => commitTransform(scaleRef.current, positionRef.current)}
        />
      </div>

      <button
        type="button"
        aria-label="关闭图片预览"
        title="关闭"
        className="fixed right-3 z-[1020] flex h-14 w-14 items-center justify-center rounded-full bg-black/60 text-white shadow-xl ring-1 ring-white/15 backdrop-blur-md transition-colors active:bg-black/80"
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
        className={`fixed left-1/2 z-[1010] flex -translate-x-1/2 items-center gap-1 rounded-full border border-white/10 bg-black/65 px-2 py-1.5 text-white shadow-2xl backdrop-blur-md transition-all duration-150 ${controlsVisible ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-3 opacity-0"}`}
        style={{ bottom: "calc(env(safe-area-inset-bottom, 0px) + 14px)", touchAction: "manipulation" }}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          aria-label="缩小图片"
          className="flex h-12 w-12 items-center justify-center rounded-full transition-colors active:bg-white/15 disabled:opacity-35"
          disabled={scale <= MIN_SCALE}
          onClick={() => zoomAroundPoint(scaleRef.current - 0.25)}
        >
          <ZoomOut size={22} />
        </button>
        <button
          type="button"
          aria-label="重置图片缩放"
          className="flex h-12 w-12 items-center justify-center rounded-full transition-colors active:bg-white/15"
          onClick={resetTransform}
        >
          <RotateCcw size={20} />
        </button>
        <span className="min-w-[58px] select-none text-center font-mono text-sm tabular-nums text-white/90">
          {Math.round(scale * 100)}%
        </span>
        <button
          type="button"
          aria-label="放大图片"
          className="flex h-12 w-12 items-center justify-center rounded-full transition-colors active:bg-white/15 disabled:opacity-35"
          disabled={scale >= MAX_SCALE}
          onClick={() => zoomAroundPoint(scaleRef.current + 0.25)}
        >
          <ZoomIn size={22} />
        </button>
      </div>
    </section>,
    document.body,
  );
}
