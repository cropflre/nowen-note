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
  it("projects an explicit note theme onto the local editor surface", () => {
    const surface = document.createElement("div");
    applyExplicitNoteTheme(surface, "paper");

    expect(surface.dataset.noteTheme).toBe("paper");
    expect(surface.style.getPropertyValue("--note-theme-surface"))
      .toBe(resolveNoteThemeTokens("paper", "light").surface);
    expect(surface.style.getPropertyValue("--pm-text"))
      .toBe(resolveNoteThemeTokens("paper", "light").text);
  });

  it("explicit default overrides a non-default account theme", () => {
    applyNoteTheme("paper", document.documentElement);
    const surface = document.createElement("div");
    applyExplicitNoteTheme(surface, "default");

    expect(document.documentElement.style.getPropertyValue("--note-theme-surface"))
      .toBe(resolveNoteThemeTokens("paper", "light").surface);
    expect(surface.style.getPropertyValue("--note-theme-surface"))
      .toBe(resolveNoteThemeTokens("default", "light").surface);
    expect(surface.dataset.noteTheme).toBe("default");
  });

  it("clearing an override removes only local tokens so account defaults can inherit again", () => {
    const surface = document.createElement("div");
    applyExplicitNoteTheme(surface, "minimal");
    clearExplicitNoteTheme(surface);

    expect(surface.hasAttribute("data-note-theme")).toBe(false);
    for (const property of noteAppearanceSurfaceTokenProperties()) {
      expect(surface.style.getPropertyValue(property)).toBe("");
    }
  });
});
