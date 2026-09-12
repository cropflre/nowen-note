// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import {
  applyExplicitNoteTheme,
  clearExplicitNoteTheme,
  noteAppearanceSurfaceTokenProperties,
} from "@/lib/noteAppearanceSurface";
import { applyNoteTheme, resolveNoteThemeTokens } from "@/lib/noteTheme";

afterEach(() => {
  document.documentElement.classList.remove("dark");
  applyNoteTheme("default");
});

describe("per-note appearance surface", () => {
  it("renders an explicit built-in note theme", () => {
    const surface = document.createElement("div");
    applyExplicitNoteTheme(surface, "paper");

    expect(surface.dataset.noteTheme).toBe("paper");
    expect(surface.style.getPropertyValue("--note-theme-surface"))
      .toBe(resolveNoteThemeTokens("paper", "light").surface);
  });

  it("clearing explicit appearance removes every local token", () => {
    const surface = document.createElement("div");
    applyExplicitNoteTheme(surface, "minimal");
    clearExplicitNoteTheme(surface);

    expect(surface.hasAttribute("data-note-theme")).toBe(false);
    for (const property of noteAppearanceSurfaceTokenProperties()) {
      expect(surface.style.getPropertyValue(property)).toBe("");
    }
  });
});
