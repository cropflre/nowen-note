import type {
  ImageCropRect,
  ImageEditorOperation,
  ImageEditorPoint,
} from "./imageEditorOperations";

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

export interface RenderImageEditorOperationsOptions {
  image: CanvasImageSource;
  operations: ImageEditorOperation[];
  draftOperation?: ImageEditorOperation | null;
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

function createCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

function requireContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext("2d");
  if (!context) throw new Error("CANVAS_CONTEXT_UNAVAILABLE");
  return context;
}

function drawStrokePath(context: CanvasRenderingContext2D, points: ImageEditorPoint[]): void {
  if (!points.length) return;
  context.beginPath();
  context.moveTo(points[0].x, points[0].y);
  for (const point of points.slice(1)) context.lineTo(point.x, point.y);
  if (points.length === 1) {
    context.lineTo(points[0].x + 0.01, points[0].y + 0.01);
  }
  context.stroke();
}

function drawArrow(
  context: CanvasRenderingContext2D,
  start: ImageEditorPoint,
  end: ImageEditorPoint,
  lineWidth: number,
): void {
  const angle = Math.atan2(end.y - start.y, end.x - start.x);
  const headLength = Math.max(12, lineWidth * 4);
  context.beginPath();
  context.moveTo(start.x, start.y);
  context.lineTo(end.x, end.y);
  context.moveTo(end.x, end.y);
  context.lineTo(
    end.x - headLength * Math.cos(angle - Math.PI / 6),
    end.y - headLength * Math.sin(angle - Math.PI / 6),
  );
  context.moveTo(end.x, end.y);
  context.lineTo(
    end.x - headLength * Math.cos(angle + Math.PI / 6),
    end.y - headLength * Math.sin(angle + Math.PI / 6),
  );
  context.stroke();
}

function drawMosaicClipPath(
  context: CanvasRenderingContext2D,
  points: ImageEditorPoint[],
  lineWidth: number,
): void {
  if (!points.length) return;
  const radius = lineWidth / 2;
  context.beginPath();
  for (const point of points) {
    context.moveTo(point.x + radius, point.y);
    context.arc(point.x, point.y, radius, 0, Math.PI * 2);
  }
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1];
    const end = points[index];
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const length = Math.hypot(dx, dy) || 1;
    const offsetX = (-dy / length) * radius;
    const offsetY = (dx / length) * radius;
    context.moveTo(start.x + offsetX, start.y + offsetY);
    context.lineTo(end.x + offsetX, end.y + offsetY);
    context.lineTo(end.x - offsetX, end.y - offsetY);
    context.lineTo(start.x - offsetX, start.y - offsetY);
    context.closePath();
  }
  context.clip();
}

function drawMosaic(
  sourceCanvas: HTMLCanvasElement,
  targetCanvas: HTMLCanvasElement,
  context: CanvasRenderingContext2D,
  operation: Extract<ImageEditorOperation, { kind: "mosaic" }>,
): void {
  if (!operation.points.length) return;
  const blockSize = Math.max(4, operation.blockSize);
  const smallCanvas = createCanvas(
    Math.ceil(sourceCanvas.width / blockSize),
    Math.ceil(sourceCanvas.height / blockSize),
  );
  const smallContext = requireContext(smallCanvas);
  smallContext.drawImage(sourceCanvas, 0, 0, smallCanvas.width, smallCanvas.height);

  context.save();
  drawMosaicClipPath(context, operation.points, operation.lineWidth);
  context.imageSmoothingEnabled = false;
  context.drawImage(
    smallCanvas,
    0,
    0,
    smallCanvas.width,
    smallCanvas.height,
    0,
    0,
    sourceCanvas.width,
    sourceCanvas.height,
  );
  context.restore();
}

function drawAnnotation(
  canvas: HTMLCanvasElement,
  operation: ImageEditorOperation,
  mosaicSource: HTMLCanvasElement = canvas,
): void {
  if (operation.kind === "rotate" || operation.kind === "flip" || operation.kind === "crop") return;
  const context = requireContext(canvas);
  if (operation.kind === "mosaic") {
    drawMosaic(mosaicSource, canvas, context, operation);
    return;
  }

  context.save();
  context.lineCap = "round";
  context.lineJoin = "round";
  context.strokeStyle = operation.color;
  context.fillStyle = operation.color;

  if (operation.kind === "text") {
    context.font = `600 ${operation.fontSize}px system-ui, sans-serif`;
    context.textBaseline = "top";
    const lineHeight = operation.fontSize * 1.2;
    operation.text.split("\n").forEach((line, index) => {
      context.fillText(line, operation.point.x, operation.point.y + index * lineHeight);
    });
    context.restore();
    return;
  }

  context.lineWidth = operation.lineWidth;
  if (operation.kind === "pen") {
    drawStrokePath(context, operation.points);
  } else if (operation.kind === "arrow") {
    drawArrow(context, operation.start, operation.end, operation.lineWidth);
  } else {
    const x = Math.min(operation.start.x, operation.end.x);
    const y = Math.min(operation.start.y, operation.end.y);
    const width = Math.abs(operation.end.x - operation.start.x);
    const height = Math.abs(operation.end.y - operation.start.y);
    if (operation.kind === "rectangle") {
      context.strokeRect(x, y, width, height);
    } else {
      context.beginPath();
      context.ellipse(x + width / 2, y + height / 2, width / 2, height / 2, 0, 0, Math.PI * 2);
      context.stroke();
    }
  }
  context.restore();
}

export function renderImageEditorDraft(
  sourceCanvas: HTMLCanvasElement,
  overlayCanvas: HTMLCanvasElement,
  operation: ImageEditorOperation | null,
  viewport?: { width: number; height: number; pixelRatio?: number },
): void {
  const pixelRatio = viewport?.pixelRatio ?? 1;
  const targetWidth = viewport ? Math.max(1, Math.round(viewport.width * pixelRatio)) : sourceCanvas.width;
  const targetHeight = viewport ? Math.max(1, Math.round(viewport.height * pixelRatio)) : sourceCanvas.height;
  if (overlayCanvas.width !== targetWidth || overlayCanvas.height !== targetHeight) {
    overlayCanvas.width = targetWidth;
    overlayCanvas.height = targetHeight;
  }
  const context = requireContext(overlayCanvas);
  context.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  if (!operation) return;
  context.save();
  context.scale(overlayCanvas.width / sourceCanvas.width, overlayCanvas.height / sourceCanvas.height);
  drawAnnotation(overlayCanvas, operation, sourceCanvas);
  context.restore();
}

export function renderImageEditorCropOverlay(
  sourceCanvas: HTMLCanvasElement,
  overlayCanvas: HTMLCanvasElement,
  cropRect: ImageCropRect | null,
  viewport: { width: number; height: number; pixelRatio?: number },
): void {
  const pixelRatio = viewport.pixelRatio ?? 1;
  const targetWidth = Math.max(1, Math.round(viewport.width * pixelRatio));
  const targetHeight = Math.max(1, Math.round(viewport.height * pixelRatio));
  if (overlayCanvas.width !== targetWidth || overlayCanvas.height !== targetHeight) {
    overlayCanvas.width = targetWidth;
    overlayCanvas.height = targetHeight;
  }
  const context = requireContext(overlayCanvas);
  context.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  if (!cropRect) return;

  const scaleX = overlayCanvas.width / sourceCanvas.width;
  const scaleY = overlayCanvas.height / sourceCanvas.height;
  context.save();
  context.scale(scaleX, scaleY);
  context.fillStyle = "rgba(0, 0, 0, 0.52)";
  context.fillRect(0, 0, sourceCanvas.width, sourceCanvas.height);
  context.clearRect(cropRect.x, cropRect.y, cropRect.width, cropRect.height);
  context.strokeStyle = "#ffffff";
  context.lineWidth = 2 / Math.max(scaleX, scaleY);
  context.setLineDash([10 / scaleX, 8 / scaleX]);
  context.strokeRect(cropRect.x, cropRect.y, cropRect.width, cropRect.height);
  context.restore();
}

function transformCanvas(
  canvas: HTMLCanvasElement,
  operation: Extract<ImageEditorOperation, { kind: "rotate" | "flip" }>,
): HTMLCanvasElement {
  const transform: ImageEditTransform = {
    rotate: operation.kind === "rotate" ? (operation.degrees === 90 ? 90 : 270) : 0,
    flipX: operation.kind === "flip" && operation.axis === "horizontal",
    flipY: operation.kind === "flip" && operation.axis === "vertical",
  };
  return renderImageToCanvas({ image: canvas, transform, maxEdge: Number.MAX_SAFE_INTEGER });
}

function cropCanvas(canvas: HTMLCanvasElement, rect: ImageCropRect): HTMLCanvasElement {
  const x = Math.max(0, Math.min(canvas.width, rect.x));
  const y = Math.max(0, Math.min(canvas.height, rect.y));
  const width = Math.max(1, Math.min(canvas.width - x, rect.width));
  const height = Math.max(1, Math.min(canvas.height - y, rect.height));
  const cropped = createCanvas(width, height);
  requireContext(cropped).drawImage(canvas, x, y, width, height, 0, 0, cropped.width, cropped.height);
  return cropped;
}

export function renderImageEditorOperations(
  options: RenderImageEditorOperationsOptions,
): HTMLCanvasElement {
  let canvas = renderImageToCanvas({
    image: options.image,
    transform: { rotate: 0, flipX: false, flipY: false },
    maxEdge: options.maxEdge,
  });
  const operations = options.draftOperation
    ? [...options.operations, options.draftOperation]
    : options.operations;

  for (const operation of operations) {
    if (operation.kind === "rotate" || operation.kind === "flip") {
      canvas = transformCanvas(canvas, operation);
    } else if (operation.kind === "crop") {
      canvas = cropCanvas(canvas, operation.rect);
    } else {
      drawAnnotation(canvas, operation);
    }
  }
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
