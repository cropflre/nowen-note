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

/** 编辑结果已经包含原节点的旋转/翻转，因此替换节点时必须清除外层变换。 */
export function buildEditedImageAttrs(current: ImageNodeAttrs, nextSrc: string): ImageNodeAttrs {
  return {
    src: nextSrc,
    alt: current.alt ?? null,
    title: current.title ?? null,
    width: current.width ?? null,
    height: null,
    rotation: 0,
    flipX: false,
  };
}

export function shouldKeepImageActionsOpenOnBlur(
  selection: unknown,
): boolean {
  if (!selection || typeof selection !== "object" || !("node" in selection)) return false;
  const node = selection.node;
  if (!node || typeof node !== "object" || !("type" in node)) return false;
  const type = node.type;
  return Boolean(type && typeof type === "object" && "name" in type && type.name === "image");
}

/**
 * 复制图片地址时用来补全相对附件路径的 origin。
 *
 * 手机 App / 桌面客户端的页面源是 https://localhost 或 file://，指向的是设备自己而不是
 * 服务器，拼出来的地址在别的设备上一定打不开。已配置服务器地址就用它（含反代子路径）；
 * 客户端没有服务器地址时返回空串，让调用方保留相对路径；浏览器里页面源就是服务器。
 */
export function getImageCopyOrigin(serverUrl: string, pageOrigin: string, nativeClient: boolean): string {
  return serverUrl || (nativeClient ? "" : pageOrigin);
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
