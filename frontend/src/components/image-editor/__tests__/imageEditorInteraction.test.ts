import { describe, expect, it } from "vitest";
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
} from "../imageEditorInteraction";

describe("imageEditorInteraction", () => {
  it("maps and clamps a client point to intrinsic canvas coordinates", () => {
    const point = clientPointToCanvas(
      { clientX: 310, clientY: 10 },
      { left: 10, top: 20, width: 200, height: 100 },
      { width: 1000, height: 500 },
    );

    expect(point).toEqual({ x: 1000, y: 0 });
  });

  it("adds points to a freehand pen operation", () => {
    const operation = createPointerOperation("pen", { x: 10, y: 20 }, {
      color: "#ff3b30",
      lineWidth: 6,
      mosaicWidth: 36,
    });

    const updated = operation && updatePointerOperation(operation, { x: 30, y: 40 });

    expect(updated).toBe(operation);
    expect(updated).toMatchObject({
      kind: "pen",
      points: [{ x: 10, y: 20 }, { x: 30, y: 40 }],
    });
  });

  it("updates the endpoint for an arrow operation", () => {
    const operation = createPointerOperation("arrow", { x: 10, y: 20 }, {
      color: "#ff3b30",
      lineWidth: 6,
      mosaicWidth: 36,
    });

    expect(operation && updatePointerOperation(operation, { x: 80, y: 90 })).toMatchObject({
      kind: "arrow",
      start: { x: 10, y: 20 },
      end: { x: 80, y: 90 },
    });
  });

  it("rejects a shape that was not visibly dragged", () => {
    const operation = createPointerOperation("rectangle", { x: 10, y: 20 }, {
      color: "#ff3b30",
      lineWidth: 6,
      mosaicWidth: 36,
    });

    expect(operation && isMeaningfulOperation(operation)).toBe(false);
  });

  it("converts visible tool sizes to high resolution canvas units", () => {
    expect(canvasLengthFromCss(
      36,
      { width: 4096, height: 3072 },
      { width: 512, height: 384 },
    )).toBe(288);
  });

  it("only starts one primary pointer gesture", () => {
    expect(canStartEditorPointer(null, { pointerId: 7, isPrimary: true })).toBe(true);
    expect(canStartEditorPointer(7, { pointerId: 8, isPrimary: true })).toBe(false);
    expect(canStartEditorPointer(null, { pointerId: 8, isPrimary: false })).toBe(false);
  });

  it("lets native text fields handle undo shortcuts", () => {
    const textarea = document.createElement("textarea");
    const editable = document.createElement("div");
    editable.contentEditable = "true";

    expect(isEditorShortcutTarget(textarea)).toBe(true);
    expect(isEditorShortcutTarget(editable)).toBe(true);
    expect(isEditorShortcutTarget(document.createElement("button"))).toBe(false);
  });

  it("moves a bottom-right text editor inward instead of clipping it", () => {
    expect(getTextDraftTransform(
      { x: 900, y: 700 },
      { width: 1000, height: 800 },
    )).toBe("translate(-100%, -100%)");
  });

  it("calculates pinch distance and scales proportionally", () => {
    expect(calculateTouchDistance(
      { x: 10, y: 20 },
      { x: 110, y: 20 },
    )).toBe(100);
    expect(calculatePinchScale(1.5, 100, 200)).toBe(3);
  });

  it("clamps pinch zoom between 50% and 400%", () => {
    expect(calculatePinchScale(1, 100, 10)).toBe(0.5);
    expect(calculatePinchScale(2, 100, 300)).toBe(4);
    expect(calculatePinchScale(2, 0, 300)).toBe(2);
  });
});
