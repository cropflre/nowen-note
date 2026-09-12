import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../../app-appearance.css", import.meta.url), "utf8");

describe("app appearance css contract", () => {
  it("bridges legacy fixed utilities back to semantic app tokens", () => {
    for (const selector of [
      ".bg-white",
      ".bg-zinc-50\\/70",
      ".dark\\:bg-zinc-900\\/60",
      ".text-zinc-900",
      ".border-zinc-200\\/60",
      ".hover\\:bg-zinc-100:hover",
      ".hover\\:text-zinc-900:hover",
      ".placeholder\\:text-zinc-400::placeholder",
      ".text-indigo-600",
      ".focus\\:ring-indigo-500:focus",
      ".rounded-xl",
    ]) {
      expect(css).toContain(selector);
    }

    expect(css).toContain("var(--color-bg)");
    expect(css).toContain("var(--color-surface)");
    expect(css).toContain("var(--color-hover)");
    expect(css).toContain("var(--color-active)");
    expect(css).toContain("var(--color-text-primary)");
    expect(css).toContain("var(--color-border)");
    expect(css).toContain("var(--color-accent-primary)");
    expect(css).toContain("var(--radius-card)");
  });

  it("does not override semantic status palettes", () => {
    // Success/warning/destructive/AI colors carry meaning and must not collapse into the skin accent.
    for (const semanticColor of ["emerald", "amber", "red", "rose", "purple"]) {
      expect(css).not.toContain(`.text-${semanticColor}-`);
      expect(css).not.toContain(`.bg-${semanticColor}-`);
    }
  });

  it("contains no appearance-specific palette values", () => {
    for (const id of ["paper", "minimal", "eye-care", "developer", "magazine"]) {
      expect(css).not.toContain(`data-app-appearance=\"${id}\"`);
    }
    expect(css).not.toMatch(/#[0-9a-f]{3,8}/i);
  });
});
