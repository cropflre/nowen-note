export type ImageEditorPoint = { x: number; y: number };

export type ImageCropRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type StrokeStyle = {
  color: string;
  lineWidth: number;
};

export type ImageEditorOperation =
  | { kind: "rotate"; degrees: -90 | 90 }
  | { kind: "flip"; axis: "horizontal" | "vertical" }
  | ({ kind: "pen"; points: ImageEditorPoint[] } & StrokeStyle)
  | ({ kind: "arrow"; start: ImageEditorPoint; end: ImageEditorPoint } & StrokeStyle)
  | ({ kind: "rectangle"; start: ImageEditorPoint; end: ImageEditorPoint } & StrokeStyle)
  | ({ kind: "ellipse"; start: ImageEditorPoint; end: ImageEditorPoint } & StrokeStyle)
  | { kind: "mosaic"; points: ImageEditorPoint[]; lineWidth: number; blockSize: number }
  | { kind: "text"; point: ImageEditorPoint; text: string; color: string; fontSize: number }
  | { kind: "crop"; rect: ImageCropRect };

export type ImageEditorHistory = {
  operations: ImageEditorOperation[];
  redoStack: ImageEditorOperation[];
};

export function createEditorHistory(): ImageEditorHistory {
  return { operations: [], redoStack: [] };
}

export function applyEditorOperation(
  history: ImageEditorHistory,
  operation: ImageEditorOperation,
): ImageEditorHistory {
  return {
    operations: [...history.operations, operation],
    redoStack: [],
  };
}

export function undoEditorOperation(history: ImageEditorHistory): ImageEditorHistory {
  const operation = history.operations.at(-1);
  if (!operation) return history;
  return {
    operations: history.operations.slice(0, -1),
    redoStack: [...history.redoStack, operation],
  };
}

export function redoEditorOperation(history: ImageEditorHistory): ImageEditorHistory {
  const operation = history.redoStack.at(-1);
  if (!operation) return history;
  return {
    operations: [...history.operations, operation],
    redoStack: history.redoStack.slice(0, -1),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function normalizeCropRect(
  start: ImageEditorPoint,
  end: ImageEditorPoint,
  bounds: { width: number; height: number },
  minSize = 2,
): ImageCropRect | null {
  const x1 = clamp(Math.min(start.x, end.x), 0, bounds.width);
  const y1 = clamp(Math.min(start.y, end.y), 0, bounds.height);
  const x2 = clamp(Math.max(start.x, end.x), 0, bounds.width);
  const y2 = clamp(Math.max(start.y, end.y), 0, bounds.height);
  const width = x2 - x1;
  const height = y2 - y1;
  if (width < minSize || height < minSize) return null;
  return { x: x1, y: y1, width, height };
}
