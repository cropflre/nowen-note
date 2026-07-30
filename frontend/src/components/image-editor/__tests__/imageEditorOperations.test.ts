import { describe, expect, it } from "vitest";
import {
  applyEditorOperation,
  createEditorHistory,
  normalizeCropRect,
  redoEditorOperation,
  undoEditorOperation,
  type ImageEditorOperation,
} from "../imageEditorOperations";

const penOperation: ImageEditorOperation = {
  kind: "pen",
  points: [{ x: 10, y: 20 }, { x: 30, y: 40 }],
  color: "#ff3b30",
  lineWidth: 6,
};

describe("imageEditorOperations", () => {
  it("normalizes a reverse crop drag and clamps it to the canvas", () => {
    expect(normalizeCropRect(
      { x: 180, y: 90 },
      { x: -20, y: 10 },
      { width: 160, height: 100 },
    )).toEqual({ x: 0, y: 10, width: 160, height: 80 });
  });

  it("rejects a crop selection that is too small", () => {
    expect(normalizeCropRect(
      { x: 10, y: 10 },
      { x: 11, y: 11 },
      { width: 100, height: 100 },
      4,
    )).toBeNull();
  });

  it("undoes and redoes editor operations without losing order", () => {
    const rotated = applyEditorOperation(createEditorHistory(), { kind: "rotate", degrees: 90 });
    const drawn = applyEditorOperation(rotated, penOperation);
    const undone = undoEditorOperation(drawn);
    const redone = redoEditorOperation(undone);

    expect(undone.operations).toEqual([{ kind: "rotate", degrees: 90 }]);
    expect(undone.redoStack).toEqual([penOperation]);
    expect(redone.operations).toEqual([{ kind: "rotate", degrees: 90 }, penOperation]);
    expect(redone.redoStack).toEqual([]);
  });

  it("clears the redo stack after a new edit", () => {
    const drawn = applyEditorOperation(createEditorHistory(), penOperation);
    const undone = undoEditorOperation(drawn);
    const replaced = applyEditorOperation(undone, { kind: "flip", axis: "horizontal" });

    expect(replaced.redoStack).toEqual([]);
    expect(replaced.operations).toEqual([{ kind: "flip", axis: "horizontal" }]);
  });
});
