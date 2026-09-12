import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../../app-appearance.css", import.meta.url), "utf8");

describe("app appearance css contract", () => {
  it("bridges legacy fixed utilities back to semantic app tokens", () => {
    expect(css).toContain(".bg-white");
    expect(css).toContain(".bg-zinc-50");
    expect(css).toContain(".text-zinc-900");
    expect(css).toContain(".border-zinc-200");
    expect(css).toContain("var(--color-bg)");
    expect(css).toContain("var(--color-text-primary)");
    expect(css).toContain("var(--color-border)");
  });

  it("contains no appearance-specific palette values", () => {
    for (const id of ["paper", "minimal", "eye-care", "developer", "magazine"]) {
      expect(css).not.toContain(`data-app-appearance=\"${id}\"`);
    }
    expect(css).not.toMatch(/#[0-9a-f]{3,8}/i);
  });
});
