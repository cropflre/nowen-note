import { describe, expect, it } from "vitest";
import {
  getMindMapNodeStyle,
  parseMindMapDocument,
  preserveMindMapNodeStyleInSerializedData,
  transformMindMapExportSvg,
  withMindMapNodeStyle,
} from "../mindMapAppearance";

describe("mind map appearance", () => {
  it("keeps old mind maps on the card style by default", () => {
    const document = parseMindMapDocument('{"root":{"id":"root","text":"Map"}}');
    expect(getMindMapNodeStyle(document)).toBe("card");
  });

  it("stores the style without removing existing document fields", () => {
    const document = withMindMapNodeStyle({
      root: { id: "root", text: "Map" },
      layout: "left-right",
      appearance: { density: "comfortable" },
    }, "minimal");

    expect(document.layout).toBe("left-right");
    expect(document.appearance).toEqual({ density: "comfortable", nodeStyle: "minimal" });
  });

  it("preserves an active style across legacy editor autosaves", () => {
    const merged = preserveMindMapNodeStyleInSerializedData(
      '{"root":{"id":"root","text":"Map"},"viewport":{"zoom":1}}',
      "minimal",
    );
    expect(JSON.parse(merged).appearance.nodeStyle).toBe("minimal");

    const explicit = preserveMindMapNodeStyleInSerializedData(
      '{"root":{"id":"root","text":"Map"},"appearance":{"nodeStyle":"card"}}',
      "minimal",
    );
    expect(JSON.parse(explicit).appearance.nodeStyle).toBe("card");
  });

  it("keeps the root card but removes descendant cards from exports", () => {
    const svg = [
      '<svg xmlns="http://www.w3.org/2000/svg">',
      '<rect x="0" fill="#6366f1" stroke="#4f46e5" stroke-width="1.5"/>',
      '<text dominant-baseline="central">Root</text>',
      '<rect x="100" fill="#eef2ff" stroke="#c7d2fe" stroke-width="1.5"/>',
      '<text dominant-baseline="central">Child</text>',
      "</svg>",
    ].join("\n");

    const transformed = transformMindMapExportSvg(svg, "minimal");
    expect(transformed).toContain('fill="#6366f1" stroke="#4f46e5" stroke-width="1.5"');
    expect(transformed).toContain('fill="transparent" stroke="none" stroke-width="0"');
    expect(transformed).toContain('<text dominant-baseline="central" fill="#374151">Child</text>');
  });
});
