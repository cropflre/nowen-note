export type ImageEditRotation = 0 | 90 | 180 | 270;

export interface ImageEditTransform {
  rotate: ImageEditRotation;
  flipX: boolean;
  flipY: boolean;
}

export interface RenderImageToCanvasOptions {
  image: CanvasImageSource;
  transform: ImageEditTransform;
  maxEdge?: number;
}

const DEFAULT_MAX_EDGE = 4096;

function getImageSize(image: CanvasImageSource): { width: number; height: number } {
  const candidate = image as { width?: number; height?: number; naturalWidth?: number; naturalHeight?: number };
  const width = Number(candidate.naturalWidth || candidate.width || 0);
  const height = Number(candidate.naturalHeight || candidate.height || 0);
  if (!width || !height) {
    throw new Error("INVALID_IMAGE_SIZE");
  }
  return { width, height };
}

function normalizeRotation(rotate: number): ImageEditRotation {
  const normalized = ((rotate % 360) + 360) % 360;
  if (normalized === 90 || normalized === 180 || normalized === 270) return normalized;
  return 0;
}

function scaleToMaxEdge(width: number, height: number, maxEdge: number): { width: number; height: number } {
  const max = Math.max(width, height);
  if (max <= maxEdge) return { width, height };
  const ratio = maxEdge / max;
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
  };
}

export function renderImageToCanvas(options: RenderImageToCanvasOptions): HTMLCanvasElement {
  const { image, transform } = options;
  const maxEdge = options.maxEdge ?? DEFAULT_MAX_EDGE;
  const source = getImageSize(image);
  const drawSize = scaleToMaxEdge(source.width, source.height, maxEdge);
  const rotate = normalizeRotation(transform.rotate);
  const swapsAxes = rotate === 90 || rotate === 270;
  const canvas = document.createElement("canvas");
  canvas.width = swapsAxes ? drawSize.height : drawSize.width;
  canvas.height = swapsAxes ? drawSize.width : drawSize.height;

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("CANVAS_CONTEXT_UNAVAILABLE");
  }

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((rotate * Math.PI) / 180);
  ctx.scale(transform.flipX ? -1 : 1, transform.flipY ? -1 : 1);
  ctx.drawImage(image, -drawSize.width / 2, -drawSize.height / 2, drawSize.width, drawSize.height);
  ctx.restore();
  return canvas;
}

export function exportCanvasToBlob(canvas: HTMLCanvasElement, mimeType = "image/png"): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("CANVAS_EXPORT_FAILED"));
        return;
      }
      resolve(blob);
    }, mimeType);
  });
}

export async function loadImageAsBitmap(src: string): Promise<HTMLImageElement | ImageBitmap> {
  const resp = await fetch(src, { credentials: "include" });
  if (!resp.ok) throw new Error("IMAGE_LOAD_FAILED");
  const blob = await resp.blob();
  if (blob.type.toLowerCase().includes("svg")) {
    throw new Error("SVG_UNSUPPORTED");
  }
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(blob);
    } catch {
      // Safari 等环境可能没有完整 ImageBitmap 支持，继续走 img fallback。
    }
  }
  const img = new Image();
  img.decoding = "async";
  const objectUrl = URL.createObjectURL(blob);
  const loaded = new Promise<HTMLImageElement>((resolve, reject) => {
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("IMAGE_LOAD_FAILED"));
    };
  });
  img.src = objectUrl;
  return loaded;
}
