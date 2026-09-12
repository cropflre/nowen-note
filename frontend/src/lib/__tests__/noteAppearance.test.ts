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

describe("per-note appearance style surface", () => {
  it("projects an explicit note style onto the local editor surface", () => {
    const surface = document.createElement("div");
    applyExplicitNoteTheme(surface, "developer");

    expect(surface.dataset.noteTheme).toBe("developer");
    expect(surface.style.getPropertyValue("--note-theme-surface"))
      .toBe(resolveNoteThemeTokens("developer", "light").surface);
    expect(surface.style.getPropertyValue("--pm-text"))
      .toBe(resolveNoteThemeTokens("developer", "light").text);
    expect(surface.style.getPropertyValue("--note-theme-font-family"))
      .toBe(resolveNoteThemeTokens("developer", "light").fontFamily);
    expect(surface.style.getPropertyValue("--note-theme-font-size"))
      .toBe(resolveNoteThemeTokens("developer", "light").fontSize);
  });

  it("explicit Nowen Default overrides a non-default account appearance style", () => {
    applyNoteTheme("paper", document.documentElement);
    const surface = document.createElement("div");
    applyExplicitNoteTheme(surface, "default");

    expect(document.documentElement.style.getPropertyValue("--note-theme-surface"))
      .toBe(resolveNoteThemeTokens("paper", "light").surface);
    expect(surface.style.getPropertyValue("--note-theme-surface"))
      .toBe(resolveNoteThemeTokens("default", "light").surface);
    expect(surface.dataset.noteTheme).toBe("default");
  });

  it("clearing an override removes only local tokens so the account style inherits again", () => {
    applyNoteTheme("magazine", document.documentElement);
    const surface = document.createElement("div");
    applyExplicitNoteTheme(surface, "minimal");
    clearExplicitNoteTheme(surface);

    expect(surface.hasAttribute("data-note-theme")).toBe(false);
    for (const property of noteAppearanceSurfaceTokenProperties()) {
      expect(surface.style.getPropertyValue(property)).toBe("");
    }
    expect(document.documentElement.style.getPropertyValue("--note-theme-surface"))
      .toBe(resolveNoteThemeTokens("magazine", "light").surface);
  });

  it("refreshes an explicit note style from light to dark without touching account defaults", () => {
    applyNoteTheme("paper", document.documentElement);
    const surface = document.createElement("div");
    applyExplicitNoteTheme(surface, "developer");
    document.documentElement.classList.add("dark");
    applyExplicitNoteTheme(surface, "developer");

    expect(surface.style.getPropertyValue("--note-theme-surface"))
      .toBe(resolveNoteThemeTokens("developer", "dark").surface);
    expect(document.documentElement.style.getPropertyValue("--note-theme-surface"))
      .toBe(resolveNoteThemeTokens("paper", "light").surface);
  });
});
