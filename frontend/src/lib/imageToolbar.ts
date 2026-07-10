import type { ImageRotation } from "@/lib/imageNodeTransformBootstrap";

export interface ImageNodeAttrs {
  src?: string | null;
  alt?: string | null;
  title?: string | null;
  width?: number | string | null;
  height?: number | string | null;
  rotation?: ImageRotation | number | string | null;
  flipX?: boolean | number | string | null;
}

export interface ImageToolbarRect {
  top: number;
  bottom: number;
  left: number;
  right: number;
  width: number;
}

export interface ImageToolbarViewport {
  width: number;
  height: number;
}

export function buildReplacedImageAttrs(current: ImageNodeAttrs, nextSrc: string): ImageNodeAttrs {
  return {
    src: nextSrc,
    alt: current.alt ?? null,
    title: current.title ?? null,
    width: current.width ?? null,
    height: current.height ?? null,
    ...(current.rotation !== undefined ? { rotation: current.rotation } : {}),
    ...(current.flipX !== undefined ? { flipX: current.flipX } : {}),
  };
}

export function isImageReplaceTargetNode(
  node: { type?: { name?: string }; attrs?: ImageNodeAttrs } | null | undefined,
): node is { type: { name: "image" }; attrs: ImageNodeAttrs } {
  return node?.type?.name === "image";
}

export function getImageCopySource(attrs: ImageNodeAttrs, origin?: string): string {
  const src = typeof attrs.src === "string" ? attrs.src.trim() : "";
  if (!src) return "";
  if (/^(?:https?:|data:|blob:)/i.test(src)) return src;
  if (!origin) return src;
  const base = origin.replace(/\/+$/, "");
  const path = src.startsWith("/") ? src : `/${src}`;
  return `${base}${path}`;
}

export function getImageDownloadFilename(attrs: ImageNodeAttrs): string {
  const title = typeof attrs.title === "string" ? attrs.title.trim() : "";
  if (title) return title;
  const alt = typeof attrs.alt === "string" ? attrs.alt.trim() : "";
  if (alt) return alt;
  return `nowen-image-${Date.now()}`;
}

export function getImageToolbarPosition(
  rect: ImageToolbarRect,
  viewport: ImageToolbarViewport,
  options?: { toolbarWidth?: number; toolbarHeight?: number; gap?: number; margin?: number },
): { top: number; left: number } {
  const toolbarWidth = options?.toolbarWidth ?? 280;
  const toolbarHeight = options?.toolbarHeight ?? 40;
  const gap = options?.gap ?? 8;
  const margin = options?.margin ?? 8;

  const above = rect.top - toolbarHeight - gap;
  const below = rect.bottom + gap;
  const top = above >= margin
    ? above
    : Math.min(Math.max(margin, below), viewport.height - toolbarHeight - margin);

  const cx = rect.left + rect.width / 2;
  const left = Math.max(margin, Math.min(cx - toolbarWidth / 2, viewport.width - toolbarWidth - margin));
  return { top, left };
}
