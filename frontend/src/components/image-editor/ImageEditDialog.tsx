import React, { useCallback, useEffect, useRef, useState } from "react";
import { RotateCcw, RotateCw, FlipHorizontal, FlipVertical, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "@/lib/toast";
import {
  exportCanvasToBlob,
  loadImageAsBitmap,
  renderImageToCanvas,
  type ImageEditTransform,
} from "./imageCanvas";

type ImageEditDialogProps = {
  open: boolean;
  src: string;
  filename?: string;
  onClose: () => void;
  onSave: (blob: Blob) => Promise<void>;
};

const INITIAL_TRANSFORM: ImageEditTransform = {
  rotate: 0,
  flipX: false,
  flipY: false,
};

function rotateLeft(value: ImageEditTransform["rotate"]): ImageEditTransform["rotate"] {
  return (((value + 270) % 360) as ImageEditTransform["rotate"]);
}

function rotateRight(value: ImageEditTransform["rotate"]): ImageEditTransform["rotate"] {
  return (((value + 90) % 360) as ImageEditTransform["rotate"]);
}

export default function ImageEditDialog({ open, src, onClose, onSave }: ImageEditDialogProps) {
  const { t } = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [sourceImage, setSourceImage] = useState<HTMLImageElement | ImageBitmap | null>(null);
  const [transform, setTransform] = useState<ImageEditTransform>(INITIAL_TRANSFORM);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSourceImage(null);
    setTransform(INITIAL_TRANSFORM);
    loadImageAsBitmap(src)
      .then((image) => {
        if (!cancelled) setSourceImage(image);
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
  }, [open, src, t]);

  useEffect(() => {
    if (!sourceImage || !canvasRef.current) return;
    try {
      const nextCanvas = renderImageToCanvas({ image: sourceImage, transform });
      const canvas = canvasRef.current;
      canvas.width = nextCanvas.width;
      canvas.height = nextCanvas.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("CANVAS_CONTEXT_UNAVAILABLE");
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(nextCanvas, 0, 0);
      setError(null);
    } catch (err) {
      console.error("Image edit render failed:", err);
      setError(t("tiptap.imageEditRenderFailed", { defaultValue: "图片渲染失败" }));
    }
  }, [sourceImage, transform, t]);

  const handleSave = useCallback(async () => {
    if (!canvasRef.current || saving) return;
    setSaving(true);
    try {
      const blob = await exportCanvasToBlob(canvasRef.current);
      await onSave(blob);
      onClose();
    } catch (err) {
      console.error("Image edit save failed:", err);
      toast.error(t("tiptap.imageEditSaveFailed", { defaultValue: "图片保存失败" }));
    } finally {
      setSaving(false);
    }
  }, [onClose, onSave, saving, t]);

  if (!open) return null;

  const controlsDisabled = loading || saving || !!error || !sourceImage;

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/45 p-0 md:p-6">
      <div className="flex h-full w-full flex-col overflow-hidden bg-app-elevated shadow-2xl md:h-[min(760px,92vh)] md:max-w-5xl md:rounded-xl md:border md:border-app-border">
        <div className="flex h-14 shrink-0 items-center justify-between border-b border-app-border px-4">
          <div className="text-sm font-semibold text-tx-primary">{t("tiptap.imageEdit")}</div>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="rounded-md p-2 text-tx-secondary hover:bg-app-hover disabled:opacity-40"
            aria-label={t("common.close")}
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex min-h-0 flex-1 items-center justify-center bg-app-surface p-3 md:p-6">
          {loading ? (
            <div className="text-sm text-tx-secondary">{t("common.loading", { defaultValue: "加载中..." })}</div>
          ) : error ? (
            <div className="max-w-sm rounded-lg border border-app-border bg-app-elevated p-4 text-center text-sm text-tx-secondary">
              {error}
            </div>
          ) : (
            <canvas
              ref={canvasRef}
              className="max-h-full max-w-full rounded border border-app-border bg-white shadow-sm"
            />
          )}
        </div>

        <div className="shrink-0 border-t border-app-border bg-app-elevated px-3 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <div className="flex flex-wrap items-center justify-center gap-2">
            <button
              type="button"
              disabled={controlsDisabled}
              onClick={() => setTransform((prev) => ({ ...prev, rotate: rotateLeft(prev.rotate) }))}
              className="inline-flex h-10 items-center gap-2 rounded-lg border border-app-border px-3 text-sm text-tx-secondary hover:bg-app-hover disabled:opacity-40"
            >
              <RotateCcw size={16} />
              {t("tiptap.imageRotateLeft", { defaultValue: "左转" })}
            </button>
            <button
              type="button"
              disabled={controlsDisabled}
              onClick={() => setTransform((prev) => ({ ...prev, rotate: rotateRight(prev.rotate) }))}
              className="inline-flex h-10 items-center gap-2 rounded-lg border border-app-border px-3 text-sm text-tx-secondary hover:bg-app-hover disabled:opacity-40"
            >
              <RotateCw size={16} />
              {t("tiptap.imageRotateRight", { defaultValue: "右转" })}
            </button>
            <button
              type="button"
              disabled={controlsDisabled}
              onClick={() => setTransform((prev) => ({ ...prev, flipX: !prev.flipX }))}
              className="inline-flex h-10 items-center gap-2 rounded-lg border border-app-border px-3 text-sm text-tx-secondary hover:bg-app-hover disabled:opacity-40"
            >
              <FlipHorizontal size={16} />
              {t("tiptap.imageFlipHorizontal", { defaultValue: "水平翻转" })}
            </button>
            <button
              type="button"
              disabled={controlsDisabled}
              onClick={() => setTransform((prev) => ({ ...prev, flipY: !prev.flipY }))}
              className="inline-flex h-10 items-center gap-2 rounded-lg border border-app-border px-3 text-sm text-tx-secondary hover:bg-app-hover disabled:opacity-40"
            >
              <FlipVertical size={16} />
              {t("tiptap.imageFlipVertical", { defaultValue: "垂直翻转" })}
            </button>
            <button
              type="button"
              disabled={controlsDisabled}
              onClick={() => setTransform(INITIAL_TRANSFORM)}
              className="inline-flex h-10 items-center gap-2 rounded-lg border border-app-border px-3 text-sm text-tx-secondary hover:bg-app-hover disabled:opacity-40"
            >
              <RotateCcw size={16} />
              {t("common.reset", { defaultValue: "重置" })}
            </button>
            <div className="hidden h-8 w-px bg-app-border md:block" />
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="h-10 rounded-lg border border-app-border px-4 text-sm text-tx-secondary hover:bg-app-hover disabled:opacity-40"
            >
              {t("common.cancel")}
            </button>
            <button
              type="button"
              onClick={() => { void handleSave(); }}
              disabled={controlsDisabled || saving}
              className="h-10 rounded-lg bg-accent-primary px-4 text-sm font-medium text-white hover:opacity-90 disabled:opacity-40"
            >
              {saving ? t("common.saving", { defaultValue: "保存中..." }) : t("common.save", { defaultValue: "保存" })}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
