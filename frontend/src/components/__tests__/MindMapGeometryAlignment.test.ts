import { describe, expect, it } from "vitest";
import { getMindMapEdgeGeometry } from "../MindMapEditor";

describe("mind map edge alignment", () => {
  it("anchors a right-side edge to the exact node boundaries", () => {
    expect(getMindMapEdgeGeometry(
      { x: 10, y: 20, width: 100, height: 36 },
      { x: 180, y: 70, width: 80, height: 36 },
    )).toEqual({
      x1: 110,
      y1: 38,
      x2: 180,
      y2: 88,
      controlX: 145,
    });
  });

  it("anchors a left-side edge to the exact node boundaries", () => {
    expect(getMindMapEdgeGeometry(
      { x: 180, y: 70, width: 80, height: 36 },
      { x: 10, y: 20, width: 100, height: 36 },
    )).toEqual({
      x1: 180,
      y1: 88,
      x2: 110,
      y2: 38,
      controlX: 145,
    });
  });
});
