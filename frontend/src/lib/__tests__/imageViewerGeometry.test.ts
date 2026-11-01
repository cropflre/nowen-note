import { describe, expect, it } from "vitest";
import { clampImageViewerPosition } from "../imageViewerGeometry";

describe("image viewer pan geometry", () => {
  it.each([0, 90, 180, 270])("centers an unzoomed image at %s degrees", (rotation) => {
    expect(clampImageViewerPosition({ x: 100, y: -100 }, 1, rotation,
      { width: 400, height: 800 }, { width: 400, height: 800 })).toEqual({ x: 0, y: 0 });
  });
  it.each([0, 180])("clamps a zoomed portrait on both axes at %s degrees", (rotation) => {
    expect(clampImageViewerPosition({ x: 1000, y: -1000 }, 2, rotation,
      { width: 400, height: 800 }, { width: 400, height: 800 })).toEqual({ x: 200, y: -400 });
  });
  it.each([90, 270])("swaps bitmap bounds at %s degrees", (rotation) => {
    expect(clampImageViewerPosition({ x: 1000, y: -1000 }, 2, rotation,
      { width: 800, height: 200 }, { width: 400, height: 800 })).toEqual({ x: 0, y: -400 });
  });
  it("retains a valid focal offset within the bounds of a zoomed landscape", () => {
    expect(clampImageViewerPosition({ x: -80, y: 25 }, 3, 0,
      { width: 400, height: 200 }, { width: 400, height: 500 })).toEqual({ x: -80, y: 25 });
  });
});
