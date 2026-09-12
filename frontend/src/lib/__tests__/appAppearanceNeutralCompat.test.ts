import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../../app-appearance-neutral-compat.css", import.meta.url), "utf8");

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

  it("remains palette-free and reusable across features", () => {
    expect(css).not.toMatch(/#[0-9a-f]{3,8}/i);
    expect(css).not.toContain("MindMap");
    expect(css).not.toContain("data-app-appearance=\"paper\"");
    expect(css).not.toContain("data-app-appearance=\"developer\"");
  });
});
