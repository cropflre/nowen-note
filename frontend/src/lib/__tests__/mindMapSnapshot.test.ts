import { describe, expect, it } from "vitest";
import type { MindMapData } from "@/types";
import {
  buildMindMapSnapshot,
  mindMapSnapshotToSvg,
} from "@/lib/mindMapSnapshot";

function map(children: MindMapData["root"]["children"], layout?: MindMapData["layout"]): MindMapData {
  return {
    root: { id: "root", text: "Root", children },
    layout,
  };
}

describe("mind map static snapshot", () => {
  it("lays out a normal tree and preserves edges", () => {
    const snapshot = buildMindMapSnapshot(map([
      {
        id: "a",
        text: "A",
        children: [{ id: "a1", text: "A1", children: [] }],
      },
      { id: "b", text: "B", children: [] },
    ]));

    expect(snapshot.nodes.map((node) => node.id)).toEqual(["root", "a", "a1", "b"]);
    expect(snapshot.edges).toEqual([
      { fromId: "root", toId: "a" },
      { fromId: "a", toId: "a1" },
      { fromId: "root", toId: "b" },
    ]);
    expect(snapshot.bounds.width).toBeGreaterThan(100);
    expect(snapshot.bounds.height).toBeGreaterThan(50);
  });

  it("places branches on both sides in left-right layout", () => {
    const snapshot = buildMindMapSnapshot(map([
      { id: "right", text: "Right", children: [] },
      { id: "left", text: "Left", children: [] },
      { id: "right-2", text: "Right 2", children: [] },
    ], "left-right"));

    const root = snapshot.nodes.find((node) => node.id === "root")!;
    const left = snapshot.nodes.find((node) => node.id === "left")!;
    const right = snapshot.nodes.find((node) => node.id === "right")!;

    expect(left.x + left.width).toBeLessThan(root.x);
    expect(right.x).toBeGreaterThan(root.x + root.width);
  });

  it("escapes text and rejects unsafe style colors in generated SVG", () => {
    const snapshot = buildMindMapSnapshot({
      root: {
        id: "root",
        text: '<script>alert("x")</script>',
        style: {
          bg: "url(javascript:alert(1))",
          color: "javascript:alert(2)",
          border: "#123456",
        },
        children: [],
      },
    });

    const svg = mindMapSnapshotToSvg(snapshot, { title: '<img src=x onerror=alert(1)>' });
    expect(svg).not.toContain("<script>");
    expect(svg).not.toContain("<img");
    expect(svg).not.toContain("javascript:");
    expect(svg).toContain("&lt;script&gt;");
    expect(svg).toContain('stroke="#123456"');
  });

  it("caps very large embedded maps for document/share rendering", () => {
    const children = Array.from({ length: 300 }, (_, index) => ({
      id: `node-${index}`,
      text: `Node ${index}`,
      children: [],
    }));
    const snapshot = buildMindMapSnapshot(map(children), { maxNodes: 40 });

    expect(snapshot.nodes).toHaveLength(40);
    expect(snapshot.truncated).toBe(true);
  });
});
