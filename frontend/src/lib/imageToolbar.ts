export interface ImageNodeAttrs {
  src?: string | null;
  alt?: string | null;
  title?: string | null;
  width?: number | string | null;
  height?: number | string | null;
}

export function buildReplacedImageAttrs(current: ImageNodeAttrs, nextSrc: string): ImageNodeAttrs {
  return {
    src: nextSrc,
    alt: current.alt ?? null,
    title: current.title ?? null,
    width: current.width ?? null,
    height: current.height ?? null,
  };
}

export function isImageReplaceTargetNode(
  node: { type?: { name?: string }; attrs?: ImageNodeAttrs } | null | undefined,
): node is { type: { name: "image" }; attrs: ImageNodeAttrs } {
  return node?.type?.name === "image";
}

export function getImageCopySource(attrs: ImageNodeAttrs): string {
  return typeof attrs.src === "string" ? attrs.src : "";
}

export function getImageDownloadFilename(attrs: ImageNodeAttrs): string {
  const title = typeof attrs.title === "string" ? attrs.title.trim() : "";
  if (title) return title;
  const alt = typeof attrs.alt === "string" ? attrs.alt.trim() : "";
  if (alt) return alt;
  return `nowen-image-${Date.now()}`;
}
