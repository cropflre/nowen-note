import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  Brush,
  Check,
  Circle,
  Crop,
  FlipHorizontal,
  FlipVertical,
  Grid2X2,
  Redo2,
  RotateCcw,
  RotateCw,
  Square,
  Type,
  Undo2,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "@/lib/toast";
import {
  exportCanvasToBlob,
  loadImageAsBitmap,
  renderImageEditorCropOverlay,
  renderImageEditorDraft,
  renderImageEditorOperations,
} from "./imageCanvas";
import {
  canStartEditorPointer,
  calculatePinchScale,
  calculateTouchDistance,
  canvasLengthFromCss,
  clientPointToCanvas,
  createPointerOperation,
  getTextDraftTransform,
  isEditorShortcutTarget,
  isMeaningfulOperation,
  updatePointerOperation,
  type ImageEditorPointerTool,
} from "./imageEditorInteraction";
import {
  applyEditorOperation,
  createEditorHistory,
  normalizeCropRect,
  redoEditorOperation,
  undoEditorOperation,
  type ImageCropRect,
  type ImageEditorHistory,
  type ImageEditorOperation,
  type ImageEditorPoint,
} from "./imageEditorOperations";

type ImageEditDialogProps = {
  open: boolean;
  src: string;
  filename?: string;
  onClose: () => void;
  onSave: (blob: Blob) => Promise<void>;
};

type ImageEditorTool = ImageEditorPointerTool | "text" | "crop";
type PointerOperation = Extract<ImageEditorOperation, { kind: ImageEditorPointerTool }>;

type TextDraft = {
  point: ImageEditorPoint;
  value: string;
};

type PinchStart = {
  distance: number;
  scale: number;
};

const COLORS = ["#ff3b30", "#ff9500", "#ffcc00", "#34c759", "#0a84ff", "#bf5af2", "#ffffff", "#111827"];
const LINE_WIDTHS = [3, 6, 10];
const MOSAIC_WIDTHS = [24, 36, 52];
const FONT_SIZES = [24, 36, 52];

function renderDraftForDisplay(
  sourceCanvas: HTMLCanvasElement,
  draftCanvas: HTMLCanvasElement,
  operation: ImageEditorOperation | null,
): void {
  const rect = sourceCanvas.getBoundingClientRect();
  renderImageEditorDraft(sourceCanvas, draftCanvas, operation, {
    width: rect.width,
    height: rect.height,
    pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
  });
}

function ToolButton({
  active = false,
  disabled = false,
  icon,
  label,
  onClick,
}: {
  active?: boolean;
  disabled?: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={`inline-flex h-12 min-w-12 shrink-0 flex-col items-center justify-center gap-0.5 rounded-lg px-2 text-[11px] transition-colors disabled:opacity-35 ${
        active
          ? "bg-accent-primary/15 text-accent-primary"
          : "text-tx-secondary hover:bg-app-hover hover:text-tx-primary"
      }`}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

export default function ImageEditDialog({ open, src, onClose, onSave }: ImageEditDialogProps) {
  const { t } = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const draftCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const cropOverlayRef = useRef<HTMLCanvasElement | null>(null);
  const pointerOperationRef = useRef<PointerOperation | null>(null);
  const cropStartRef = useRef<ImageEditorPoint | null>(null);
  const activePointerIdRef = useRef<number | null>(null);
  const touchPointsRef = useRef(new Map<number, ImageEditorPoint>());
  const pinchStartRef = useRef<PinchStart | null>(null);
  const suppressTouchEditRef = useRef(false);
  const viewScaleRef = useRef(1);
  const draftFrameRef = useRef<number | null>(null);
  const textInputRef = useRef<HTMLTextAreaElement | null>(null);

  const [sourceImage, setSourceImage] = useState<HTMLImageElement | ImageBitmap | null>(null);
  const [history, setHistory] = useState<ImageEditorHistory>(() => createEditorHistory());
  const [activeTool, setActiveTool] = useState<ImageEditorTool | null>(null);
  const [draftActive, setDraftActive] = useState(false);
  const [cropRect, setCropRect] = useState<ImageCropRect | null>(null);
  const [textDraft, setTextDraft] = useState<TextDraft | null>(null);
  const [color, setColor] = useState(COLORS[0]);
  const [lineWidth, setLineWidth] = useState(6);
  const [mosaicWidth, setMosaicWidth] = useState(36);
  const [fontSize, setFontSize] = useState(36);
  const [viewScale, setViewScale] = useState(1);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textDraftPosition = textDraft ? `${textDraft.point.x}:${textDraft.point.y}` : null;

  const cancelTransientEdit = useCallback(() => {
    if (draftFrameRef.current !== null) {
      window.cancelAnimationFrame(draftFrameRef.current);
      draftFrameRef.current = null;
    }
    activePointerIdRef.current = null;
    pointerOperationRef.current = null;
    cropStartRef.current = null;
    const canvas = canvasRef.current;
    const draftCanvas = draftCanvasRef.current;
    if (canvas && draftCanvas) renderDraftForDisplay(canvas, draftCanvas, null);
    setDraftActive(false);
    setCropRect(null);
    setTextDraft(null);
  }, []);

  const resetViewScale = useCallback(() => {
    viewScaleRef.current = 1;
    setViewScale(1);
  }, []);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSourceImage(null);
    setHistory(createEditorHistory());
    setActiveTool(null);
    cancelTransientEdit();
    touchPointsRef.current.clear();
    pinchStartRef.current = null;
    suppressTouchEditRef.current = false;
    resetViewScale();
    loadImageAsBitmap(src)
      .then((image) => {
        if (cancelled) {
          if ("close" in image && typeof image.close === "function") image.close();
          return;
        }
        setSourceImage(image);
      })
      .catch((err) => {
        console.error("Image edit load failed:", err);
        if (cancelled) return;
        const message = err instanceof Error && err.message === "SVG_UNSUPPORTED"
          ? t("tiptap.imageEditSvgUnsupported", { defaultValue: "SVG 暂不支持编辑" })
          : t("tiptap.imageEditLoadFailed", { defaultValue: "图片加载失败，可能是远程图片不允许编辑" });
        setError(message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [cancelTransientEdit, open, resetViewScale, src, t]);

  useEffect(() => {
    if (!open) setSourceImage(null);
  }, [open]);

  useEffect(() => {
    return () => {
      if (sourceImage && "close" in sourceImage && typeof sourceImage.close === "function") {
        sourceImage.close();
      }
    };
  }, [sourceImage]);

  useEffect(() => {
    if (!sourceImage || !canvasRef.current) return;
    try {
      const nextCanvas = renderImageEditorOperations({
        image: sourceImage,
        operations: history.operations,
      });
      const canvas = canvasRef.current;
      canvas.width = nextCanvas.width;
      canvas.height = nextCanvas.height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("CANVAS_CONTEXT_UNAVAILABLE");
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(nextCanvas, 0, 0);
      if (draftCanvasRef.current) renderDraftForDisplay(canvas, draftCanvasRef.current, null);
      setError(null);
    } catch (err) {
      console.error("Image edit render failed:", err);
      setError(t("tiptap.imageEditRenderFailed", { defaultValue: "图片渲染失败" }));
    }
  }, [history.operations, sourceImage, t]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const overlay = cropOverlayRef.current;
    if (!canvas || !overlay) return;
    const rect = canvas.getBoundingClientRect();
    renderImageEditorCropOverlay(canvas, overlay, cropRect, {
      width: rect.width,
      height: rect.height,
      pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
    });
  }, [cropRect, history.operations, sourceImage]);

  useEffect(() => {
    if (!textDraftPosition) return;
    const timer = window.setTimeout(() => textInputRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [textDraftPosition]);

  const commitOperation = useCallback((operation: ImageEditorOperation) => {
    setHistory((current) => applyEditorOperation(current, operation));
  }, []);

  const handleUndo = useCallback(() => {
    cancelTransientEdit();
    setHistory((current) => undoEditorOperation(current));
  }, [cancelTransientEdit]);

  const handleRedo = useCallback(() => {
    cancelTransientEdit();
    setHistory((current) => redoEditorOperation(current));
  }, [cancelTransientEdit]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (textDraft || cropRect || draftActive) {
          event.preventDefault();
          cancelTransientEdit();
        }
        return;
      }
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      if (isEditorShortcutTarget(event.target)) return;
      if (event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) handleRedo();
        else handleUndo();
      } else if (event.key.toLowerCase() === "y") {
        event.preventDefault();
        handleRedo();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [cancelTransientEdit, cropRect, draftActive, handleRedo, handleUndo, open, textDraft]);

  const selectTool = useCallback((tool: ImageEditorTool) => {
    cancelTransientEdit();
    setActiveTool((current) => current === tool ? null : tool);
  }, [cancelTransientEdit]);

  const canvasPoint = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    return clientPointToCanvas(event, canvas.getBoundingClientRect(), canvas);
  }, []);

  const scheduleDraftRender = useCallback(() => {
    if (draftFrameRef.current !== null) return;
    draftFrameRef.current = window.requestAnimationFrame(() => {
      draftFrameRef.current = null;
      const canvas = canvasRef.current;
      const draftCanvas = draftCanvasRef.current;
      if (canvas && draftCanvas) {
        renderDraftForDisplay(canvas, draftCanvas, pointerOperationRef.current);
      }
    });
  }, []);

  const handlePointerDown = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.pointerType === "touch") {
      touchPointsRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (!event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.setPointerCapture(event.pointerId);
      }
      if (touchPointsRef.current.size >= 2) {
        event.preventDefault();
        const [first, second] = Array.from(touchPointsRef.current.values());
        pinchStartRef.current = {
          distance: calculateTouchDistance(first, second),
          scale: viewScaleRef.current,
        };
        suppressTouchEditRef.current = true;
        cancelTransientEdit();
        return;
      }
      if (suppressTouchEditRef.current) return;
    }
    if (!activeTool || saving || !canStartEditorPointer(activePointerIdRef.current, event)) return;
    const point = canvasPoint(event);
    if (!point) return;
    event.preventDefault();

    if (activeTool === "text") {
      setTextDraft({ point, value: "" });
      return;
    }

    activePointerIdRef.current = event.pointerId;
    setDraftActive(true);
    event.currentTarget.setPointerCapture(event.pointerId);
    if (activeTool === "crop") {
      cropStartRef.current = point;
      setCropRect(null);
      return;
    }

    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const operation = createPointerOperation(activeTool, point, {
      color,
      lineWidth: canvasLengthFromCss(lineWidth, canvas, rect),
      mosaicWidth: canvasLengthFromCss(mosaicWidth, canvas, rect),
    });
    pointerOperationRef.current = operation;
    scheduleDraftRender();
  }, [activeTool, cancelTransientEdit, canvasPoint, color, lineWidth, mosaicWidth, saving, scheduleDraftRender]);

  const handlePointerMove = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.pointerType === "touch" && touchPointsRef.current.has(event.pointerId)) {
      touchPointsRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const pinchStart = pinchStartRef.current;
      if (pinchStart && touchPointsRef.current.size >= 2) {
        event.preventDefault();
        const [first, second] = Array.from(touchPointsRef.current.values());
        const nextScale = calculatePinchScale(
          pinchStart.scale,
          pinchStart.distance,
          calculateTouchDistance(first, second),
        );
        viewScaleRef.current = nextScale;
        setViewScale(nextScale);
        return;
      }
      if (suppressTouchEditRef.current) {
        event.preventDefault();
        return;
      }
    }
    if (activePointerIdRef.current !== event.pointerId || !activeTool) return;
    event.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const nativeEvent = event.nativeEvent;
    const coalesced = typeof nativeEvent.getCoalescedEvents === "function"
      ? nativeEvent.getCoalescedEvents()
      : [];
    const samples = coalesced.length ? coalesced : [nativeEvent];

    if (activeTool === "crop") {
      const start = cropStartRef.current;
      const lastSample = samples.at(-1);
      if (start && lastSample) {
        const point = clientPointToCanvas(lastSample, rect, canvas);
        setCropRect(normalizeCropRect(start, point, canvas, 1));
      }
      return;
    }

    const operation = pointerOperationRef.current;
    if (!operation) return;
    for (const sample of samples) {
      updatePointerOperation(operation, clientPointToCanvas(sample, rect, canvas));
    }
    scheduleDraftRender();
  }, [activeTool, scheduleDraftRender]);

  const finishPointerEdit = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.pointerType === "touch" && touchPointsRef.current.has(event.pointerId)) {
      touchPointsRef.current.delete(event.pointerId);
      const wasPinching = suppressTouchEditRef.current;
      if (touchPointsRef.current.size < 2) pinchStartRef.current = null;
      if (touchPointsRef.current.size === 0) suppressTouchEditRef.current = false;
      if (wasPinching) {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
        event.preventDefault();
        return;
      }
    }
    if (activePointerIdRef.current !== event.pointerId) return;
    const point = canvasPoint(event);
    if (activeTool === "crop") {
      const start = cropStartRef.current;
      const canvas = canvasRef.current;
      if (start && point && canvas) setCropRect(normalizeCropRect(start, point, canvas, 1));
    } else {
      const operation = pointerOperationRef.current;
      if (operation && point) updatePointerOperation(operation, point);
    }
    activePointerIdRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (activeTool !== "crop") {
      const operation = pointerOperationRef.current;
      if (operation && isMeaningfulOperation(operation)) commitOperation(operation);
      pointerOperationRef.current = null;
      const canvas = canvasRef.current;
      const draftCanvas = draftCanvasRef.current;
      if (canvas && draftCanvas) renderDraftForDisplay(canvas, draftCanvas, null);
    }
    setDraftActive(false);
  }, [activeTool, canvasPoint, commitOperation]);

  const cancelPointerEdit = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.pointerType === "touch") {
      touchPointsRef.current.delete(event.pointerId);
      const wasPinching = suppressTouchEditRef.current;
      if (touchPointsRef.current.size < 2) pinchStartRef.current = null;
      if (touchPointsRef.current.size === 0) suppressTouchEditRef.current = false;
      if (wasPinching) {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
        return;
      }
    }
    if (activePointerIdRef.current !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    activePointerIdRef.current = null;
    pointerOperationRef.current = null;
    cropStartRef.current = null;
    setCropRect(null);
    setDraftActive(false);
    const canvas = canvasRef.current;
    const draftCanvas = draftCanvasRef.current;
    if (canvas && draftCanvas) renderDraftForDisplay(canvas, draftCanvas, null);
  }, []);

  const applyCrop = useCallback(() => {
    if (!cropRect) return;
    commitOperation({ kind: "crop", rect: cropRect });
    cropStartRef.current = null;
    setCropRect(null);
    setActiveTool(null);
  }, [commitOperation, cropRect]);

  const commitText = useCallback(() => {
    if (!textDraft) return;
    const text = textDraft.value.trim();
    if (text) {
      const canvas = canvasRef.current;
      const scaledFontSize = canvas
        ? canvasLengthFromCss(fontSize, canvas, canvas.getBoundingClientRect())
        : fontSize;
      commitOperation({ kind: "text", point: textDraft.point, text, color, fontSize: scaledFontSize });
    }
    setTextDraft(null);
  }, [color, commitOperation, fontSize, textDraft]);

  const applyTransform = useCallback((operation: ImageEditorOperation) => {
    cancelTransientEdit();
    setActiveTool(null);
    commitOperation(operation);
  }, [cancelTransientEdit, commitOperation]);

  const handleReset = useCallback(() => {
    cancelTransientEdit();
    setActiveTool(null);
    setHistory(createEditorHistory());
    resetViewScale();
  }, [cancelTransientEdit, resetViewScale]);

  const handleSave = useCallback(async () => {
    if (!sourceImage || saving) return;
    setSaving(true);
    try {
      const canvas = renderImageEditorOperations({ image: sourceImage, operations: history.operations });
      const blob = await exportCanvasToBlob(canvas);
      await onSave(blob);
      onClose();
    } catch (err) {
      console.error("Image edit save failed:", err);
      toast.error(t("tiptap.imageEditSaveFailed", { defaultValue: "图片保存失败" }));
    } finally {
      setSaving(false);
    }
  }, [history.operations, onClose, onSave, saving, sourceImage, t]);

  if (!open) return null;

  const controlsDisabled = loading || saving || !!error || !sourceImage;
  const colorTool = activeTool === "pen" || activeTool === "arrow" || activeTool === "rectangle" || activeTool === "ellipse" || activeTool === "text";
  const strokeTool = activeTool === "pen" || activeTool === "arrow" || activeTool === "rectangle" || activeTool === "ellipse";
  const cursorClass = activeTool ? "cursor-crosshair" : "cursor-default";

  const toolLabel = (key: string, fallback: string) => t(`tiptap.${key}`, { defaultValue: fallback });

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/45 p-0 md:p-6">
      <div className="flex h-full w-full flex-col overflow-hidden bg-app-elevated shadow-2xl md:h-[min(820px,94vh)] md:max-w-6xl md:rounded-xl md:border md:border-app-border">
        <div className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-app-border px-3 md:px-4">
          <div className="shrink-0 text-sm font-semibold text-tx-primary">{t("tiptap.imageEdit")}</div>
          <div className="flex min-w-0 items-center gap-1">
            <button
              type="button"
              onClick={handleUndo}
              disabled={controlsDisabled || history.operations.length === 0}
              className="rounded-md p-2 text-tx-secondary hover:bg-app-hover disabled:opacity-30"
              title={t("tiptap.undo", { defaultValue: "撤销" })}
              aria-label={t("tiptap.undo", { defaultValue: "撤销" })}
            >
              <Undo2 size={18} />
            </button>
            <button
              type="button"
              onClick={handleRedo}
              disabled={controlsDisabled || history.redoStack.length === 0}
              className="rounded-md p-2 text-tx-secondary hover:bg-app-hover disabled:opacity-30"
              title={t("tiptap.redo", { defaultValue: "重做" })}
              aria-label={t("tiptap.redo", { defaultValue: "重做" })}
            >
              <Redo2 size={18} />
            </button>
            <button
              type="button"
              onClick={handleReset}
              disabled={controlsDisabled || history.operations.length === 0}
              className="rounded-md px-2 py-1.5 text-xs text-tx-secondary hover:bg-app-hover disabled:opacity-30"
            >
              {t("common.reset", { defaultValue: "重置" })}
            </button>
            <div className="mx-1 h-5 w-px bg-app-border" />
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="rounded-md p-2 text-tx-secondary hover:bg-app-hover disabled:opacity-40"
              aria-label={t("common.close")}
            >
              <X size={19} />
            </button>
          </div>
        </div>

        <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-app-surface p-3 md:p-6">
          {loading ? (
            <div className="text-sm text-tx-secondary">{t("common.loading", { defaultValue: "加载中..." })}</div>
          ) : error ? (
            <div className="max-w-sm rounded-lg border border-app-border bg-app-elevated p-4 text-center text-sm text-tx-secondary">
              {error}
            </div>
          ) : (
            <div
              className="relative inline-flex max-h-full max-w-full overflow-hidden rounded border border-app-border bg-white shadow-sm"
              style={{ transform: `scale(${viewScale})`, transformOrigin: "center" }}
            >
              <canvas
                ref={canvasRef}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={finishPointerEdit}
                onPointerCancel={cancelPointerEdit}
                className={`block max-h-full max-w-full touch-none select-none ${cursorClass}`}
                aria-label={toolLabel("imageEditCanvas", "图片编辑画布")}
              />
              <canvas
                ref={draftCanvasRef}
                className="pointer-events-none absolute inset-0 h-full w-full"
                aria-hidden="true"
              />
              <canvas
                ref={cropOverlayRef}
                className="pointer-events-none absolute inset-0 h-full w-full"
                aria-hidden="true"
              />
              {textDraft && canvasRef.current && (
                <div
                  className="absolute z-10 min-w-40 max-w-[min(260px,70vw)] rounded-lg border border-white/50 bg-black/75 p-2 shadow-xl"
                  style={{
                    left: `${(textDraft.point.x / canvasRef.current.width) * 100}%`,
                    top: `${(textDraft.point.y / canvasRef.current.height) * 100}%`,
                    transform: getTextDraftTransform(textDraft.point, canvasRef.current),
                  }}
                >
                  <textarea
                    ref={textInputRef}
                    value={textDraft.value}
                    onChange={(event) => setTextDraft((current) => current ? { ...current, value: event.target.value } : null)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                        event.preventDefault();
                        commitText();
                      }
                    }}
                    placeholder={toolLabel("imageEditTextPlaceholder", "输入文字")}
                    rows={2}
                    className="w-full resize-none bg-transparent text-white outline-none placeholder:text-white/50"
                    style={{ color, fontSize: Math.min(fontSize, 32) }}
                  />
                  <div className="mt-1 flex justify-end gap-1">
                    <button
                      type="button"
                      onClick={() => setTextDraft(null)}
                      className="rounded p-1.5 text-white/70 hover:bg-white/10"
                      aria-label={t("common.cancel")}
                    >
                      <X size={16} />
                    </button>
                    <button
                      type="button"
                      onClick={commitText}
                      className="rounded bg-accent-primary p-1.5 text-white disabled:opacity-40"
                      disabled={!textDraft.value.trim()}
                      aria-label={toolLabel("imageEditTextDone", "完成文字")}
                    >
                      <Check size={16} />
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="shrink-0 border-t border-app-border bg-app-elevated px-2 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] md:px-3">
          {(colorTool || strokeTool || activeTool === "mosaic" || activeTool === "crop") && (
            <div className="mb-2 flex min-h-10 items-center justify-center gap-3 overflow-x-auto rounded-lg bg-app-surface px-3 py-1.5">
              {colorTool && (
                <div className="flex shrink-0 items-center gap-2" aria-label={toolLabel("imageEditColor", "颜色")}>
                  {COLORS.map((item) => (
                    <button
                      type="button"
                      key={item}
                      onClick={() => setColor(item)}
                      className={`h-6 w-6 rounded-full border-2 shadow-sm transition-transform ${color === item ? "scale-110 border-accent-primary" : "border-white/70"}`}
                      style={{ backgroundColor: item }}
                      aria-label={item}
                      aria-pressed={color === item}
                    />
                  ))}
                </div>
              )}
              {(strokeTool || activeTool === "mosaic" || activeTool === "text") && <div className="h-6 w-px shrink-0 bg-app-border" />}
              {strokeTool && (
                <div className="flex shrink-0 items-center gap-2">
                  {LINE_WIDTHS.map((size) => (
                    <button
                      type="button"
                      key={size}
                      onClick={() => setLineWidth(size)}
                      className={`flex h-8 w-9 items-center justify-center rounded-md ${lineWidth === size ? "bg-accent-primary/15" : "hover:bg-app-hover"}`}
                      aria-label={`${toolLabel("imageEditThickness", "粗细")} ${size}`}
                      aria-pressed={lineWidth === size}
                    >
                      <span className="rounded-full bg-tx-primary" style={{ width: Math.max(12, size * 2), height: size }} />
                    </button>
                  ))}
                </div>
              )}
              {activeTool === "mosaic" && (
                <div className="flex shrink-0 items-center gap-1">
                  {MOSAIC_WIDTHS.map((size, index) => (
                    <button
                      type="button"
                      key={size}
                      onClick={() => setMosaicWidth(size)}
                      className={`h-8 rounded-md px-3 text-xs ${mosaicWidth === size ? "bg-accent-primary/15 text-accent-primary" : "text-tx-secondary hover:bg-app-hover"}`}
                      aria-pressed={mosaicWidth === size}
                    >
                      {toolLabel(`imageEditSize${index + 1}`, ["小", "中", "大"][index])}
                    </button>
                  ))}
                </div>
              )}
              {activeTool === "text" && (
                <div className="flex shrink-0 items-center gap-1">
                  {FONT_SIZES.map((size) => (
                    <button
                      type="button"
                      key={size}
                      onClick={() => setFontSize(size)}
                      className={`h-8 rounded-md px-3 font-semibold ${fontSize === size ? "bg-accent-primary/15 text-accent-primary" : "text-tx-secondary hover:bg-app-hover"}`}
                      style={{ fontSize: Math.min(18, Math.max(12, size / 2.5)) }}
                      aria-label={`${toolLabel("imageEditFontSize", "字号")} ${size}`}
                      aria-pressed={fontSize === size}
                    >
                      A
                    </button>
                  ))}
                </div>
              )}
              {activeTool === "crop" && (
                <>
                  <span className="shrink-0 text-xs text-tx-secondary">
                    {toolLabel("imageEditCropHint", "在图片上拖拽选择裁剪区域")}
                  </span>
                  {cropRect && (
                    <div className="flex shrink-0 items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setCropRect(null)}
                        className="h-8 rounded-md border border-app-border px-3 text-xs text-tx-secondary hover:bg-app-hover"
                      >
                        {t("common.cancel")}
                      </button>
                      <button
                        type="button"
                        onClick={applyCrop}
                        className="h-8 rounded-md bg-accent-primary px-3 text-xs font-medium text-white hover:opacity-90"
                      >
                        {toolLabel("imageEditApplyCrop", "应用裁剪")}
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1 overflow-x-auto">
              <div className="mx-auto flex w-max items-center gap-0.5">
                <ToolButton
                  disabled={controlsDisabled}
                  icon={<RotateCcw size={19} />}
                  label={t("tiptap.imageRotateLeft", { defaultValue: "左转" })}
                  onClick={() => applyTransform({ kind: "rotate", degrees: -90 })}
                />
                <ToolButton
                  disabled={controlsDisabled}
                  icon={<RotateCw size={19} />}
                  label={t("tiptap.imageRotateRight", { defaultValue: "右转" })}
                  onClick={() => applyTransform({ kind: "rotate", degrees: 90 })}
                />
                <ToolButton
                  disabled={controlsDisabled}
                  icon={<FlipHorizontal size={19} />}
                  label={t("tiptap.imageFlipHorizontal", { defaultValue: "水平翻转" })}
                  onClick={() => applyTransform({ kind: "flip", axis: "horizontal" })}
                />
                <ToolButton
                  disabled={controlsDisabled}
                  icon={<FlipVertical size={19} />}
                  label={t("tiptap.imageFlipVertical", { defaultValue: "垂直翻转" })}
                  onClick={() => applyTransform({ kind: "flip", axis: "vertical" })}
                />
                <div className="mx-1 h-8 w-px shrink-0 bg-app-border" />
                <ToolButton active={activeTool === "pen"} disabled={controlsDisabled} icon={<Brush size={19} />} label={toolLabel("imageEditPen", "画笔")} onClick={() => selectTool("pen")} />
                <ToolButton active={activeTool === "arrow"} disabled={controlsDisabled} icon={<ArrowUpRight size={19} />} label={toolLabel("imageEditArrow", "箭头")} onClick={() => selectTool("arrow")} />
                <ToolButton active={activeTool === "ellipse"} disabled={controlsDisabled} icon={<Circle size={19} />} label={toolLabel("imageEditEllipse", "椭圆")} onClick={() => selectTool("ellipse")} />
                <ToolButton active={activeTool === "rectangle"} disabled={controlsDisabled} icon={<Square size={19} />} label={toolLabel("imageEditRectangle", "矩形")} onClick={() => selectTool("rectangle")} />
                <ToolButton active={activeTool === "mosaic"} disabled={controlsDisabled} icon={<Grid2X2 size={19} />} label={toolLabel("imageEditMosaic", "马赛克")} onClick={() => selectTool("mosaic")} />
                <ToolButton active={activeTool === "text"} disabled={controlsDisabled} icon={<Type size={19} />} label={toolLabel("imageEditText", "文字")} onClick={() => selectTool("text")} />
                <ToolButton active={activeTool === "crop"} disabled={controlsDisabled} icon={<Crop size={19} />} label={toolLabel("imageEditCrop", "裁剪")} onClick={() => selectTool("crop")} />
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2 border-l border-app-border pl-2">
              <button
                type="button"
                onClick={onClose}
                disabled={saving}
                className="h-10 rounded-lg border border-app-border px-3 text-sm text-tx-secondary hover:bg-app-hover disabled:opacity-40 md:px-4"
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                onClick={() => { void handleSave(); }}
                disabled={controlsDisabled || saving || !!textDraft || draftActive || !!cropRect}
                className="h-10 rounded-lg bg-accent-primary px-3 text-sm font-medium text-white hover:opacity-90 disabled:opacity-40 md:px-5"
              >
                {saving ? t("common.saving", { defaultValue: "保存中..." }) : t("common.save", { defaultValue: "保存" })}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
