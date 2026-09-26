import { describe, expect, it } from "vitest";
import type { MindMapData } from "@/types";
import { buildMindMapExportSvg } from "../MindMapEditor";

describe("mind map export viewport", () => {
  it("exports every node and edge even when the saved viewport points at blank space", () => {
    const data: MindMapData = {
      root: {
        id: "root",
        text: "中心主题",
        children: [
          { id: "one", text: "主题一", children: [{ id: "child", text: "子主题", children: [] }] },
          { id: "two", text: "主题二", children: [] },
        ],
      },
      viewport: { x: 100_000, y: -100_000, zoom: 0.6, userSet: true },
    };
    const before = structuredClone(data);

    const offscreen = buildMindMapExportSvg(data);
    const centered = buildMindMapExportSvg({ ...data, viewport: { x: 0, y: 0, zoom: 1 } });

    expect(offscreen).toEqual(centered);
    expect(offscreen?.width).toBeGreaterThan(0);
    expect(offscreen?.height).toBeGreaterThan(0);
    expect(offscreen?.svgContent.match(/<rect /g)).toHaveLength(4);
    expect(offscreen?.svgContent.match(/<path /g)).toHaveLength(3);
    expect(offscreen?.svgContent).toContain("中心主题");
    expect(offscreen?.svgContent).toContain("子主题");
    expect(data).toEqual(before);
  });
});
