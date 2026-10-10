import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(resolve(process.cwd(), "src/app-appearance-neutral-compat.css"), "utf8");
const mindMap = readFileSync(resolve(process.cwd(), "src/components/MindMapEditor.tsx"), "utf8");

describe("app appearance legacy neutral compatibility", () => {
  it("maps old gray surfaces and controls back to semantic app tokens", () => {
    for (const selector of [
      ".bg-gray-100",
      ".bg-gray-200",
      ".bg-gray-300",
      ".text-gray-700",
      ".text-gray-500",
      ".border-gray-200\\/80",
      ".hover\\:bg-gray-200:hover",
      ".active\\:bg-gray-300:active",
    ]) {
      expect(css).toContain(selector);
    }
    expect(css).toContain("var(--color-surface)");
    expect(css).toContain("var(--color-hover)");
    expect(css).toContain("var(--color-active)");
    expect(css).toContain("var(--color-text-primary)");
    expect(css).toContain("var(--color-border)");
  });

  it("projects mind-map chrome through the same app appearance tokens", () => {
    expect(css).toContain("--mm-canvas-bg: var(--color-bg)");
    expect(css).toContain("--mm-node-bg: var(--color-elevated-solid)");
    expect(css).toContain("--mm-edge-active: var(--color-accent-primary)");
    expect(mindMap).not.toContain("bg-blue-500/90");
    expect(mindMap).toContain("bg-accent-primary");
    expect(mindMap).toContain("text-accent-primary");
  });

  it("remains palette-free and reusable across features", () => {
    expect(css).not.toMatch(/#[0-9a-f]{3,8}/i);
    expect(css).not.toContain("MindMap");
    expect(css).not.toContain("data-app-appearance=\"paper\"");
    expect(css).not.toContain("data-app-appearance=\"developer\"");
  });
});
