import type { ImageEditorOperation, ImageEditorPoint } from "./imageEditorOperations";

export type ImageEditorPointerTool = "pen" | "arrow" | "rectangle" | "ellipse" | "mosaic";

type PointerOperation = Extract<
  ImageEditorOperation,
  { kind: ImageEditorPointerTool }
>;

type PointerStyle = {
  color: string;
  lineWidth: number;
  mosaicWidth: number;
};

export function calculateTouchDistance(
  first: ImageEditorPoint,
  second: ImageEditorPoint,
): number {
  return Math.hypot(second.x - first.x, second.y - first.y);
}

export function calculatePinchScale(
  startScale: number,
  startDistance: number,
  currentDistance: number,
  minScale = 0.5,
  maxScale = 4,
): number {
  if (startDistance <= 0) return startScale;
  return Math.min(maxScale, Math.max(minScale, startScale * (currentDistance / startDistance)));
}

export function clientPointToCanvas(
  event: { clientX: number; clientY: number },
  rect: { left: number; top: number; width: number; height: number },
  canvas: { width: number; height: number },
): ImageEditorPoint {
  const scaleX = rect.width > 0 ? canvas.width / rect.width : 1;
  const scaleY = rect.height > 0 ? canvas.height / rect.height : 1;
  return {
    x: Math.min(canvas.width, Math.max(0, (event.clientX - rect.left) * scaleX)),
    y: Math.min(canvas.height, Math.max(0, (event.clientY - rect.top) * scaleY)),
  };
}

export function canvasLengthFromCss(
  cssLength: number,
  canvas: { width: number; height: number },
  rect: { width: number; height: number },
): number {
  const scaleX = rect.width > 0 ? canvas.width / rect.width : 1;
  const scaleY = rect.height > 0 ? canvas.height / rect.height : 1;
  return cssLength * Math.max(scaleX, scaleY);
}

export function canStartEditorPointer(
  activePointerId: number | null,
  event: { pointerId: number; isPrimary: boolean },
): boolean {
  return activePointerId === null && event.isPrimary;
}

export function isEditorShortcutTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target instanceof HTMLElement && (target.isContentEditable || target.contentEditable === "true")) {
    return true;
  }
  return !!target.closest("input, textarea, [contenteditable='true']");
}

export function getTextDraftTransform(
  point: ImageEditorPoint,
  canvas: { width: number; height: number },
): string | undefined {
  const moveX = point.x > canvas.width * 0.65;
  const moveY = point.y > canvas.height * 0.65;
  if (moveX && moveY) return "translate(-100%, -100%)";
  if (moveX) return "translateX(-100%)";
  if (moveY) return "translateY(-100%)";
  return undefined;
}

export function createPointerOperation(
  tool: ImageEditorPointerTool,
  point: ImageEditorPoint,
  style: PointerStyle,
): PointerOperation {
  if (tool === "pen") {
    return { kind: "pen", points: [point], color: style.color, lineWidth: style.lineWidth };
  }
  if (tool === "mosaic") {
    return {
      kind: "mosaic",
      points: [point],
      lineWidth: style.mosaicWidth,
      blockSize: Math.max(8, Math.round(style.mosaicWidth / 3)),
    };
  }
  return {
    kind: tool,
    start: point,
    end: point,
    color: style.color,
    lineWidth: style.lineWidth,
  };
}

export function updatePointerOperation(
  operation: PointerOperation,
  point: ImageEditorPoint,
): PointerOperation {
  if (operation.kind === "pen" || operation.kind === "mosaic") {
    const previous = operation.points.at(-1);
    if (previous && Math.hypot(point.x - previous.x, point.y - previous.y) < 0.5) return operation;
    operation.points.push(point);
    return operation;
  }
  operation.end = point;
  return operation;
}

export function isMeaningfulOperation(operation: PointerOperation): boolean {
  if (operation.kind === "pen" || operation.kind === "mosaic") return operation.points.length > 0;
  return Math.hypot(
    operation.end.x - operation.start.x,
    operation.end.y - operation.start.y,
  ) >= 2;
}
