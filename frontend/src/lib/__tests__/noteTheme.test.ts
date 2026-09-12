import { afterEach, describe, expect, it } from "vitest";
import {
  NOTE_THEMES,
  NOTE_THEME_IDS,
  applyNoteTheme,
  currentNoteThemeId,
  resolveNoteThemeTokens,
} from "@/lib/noteTheme";

describe("legacy note theme compatibility", () => {
  afterEach(() => {
    document.documentElement.classList.remove("dark");
    applyNoteTheme("default");
  });

  it("keeps the legacy registry constrained", () => {
    expect(NOTE_THEME_IDS).toEqual(["default", "paper", "minimal", "eye-care"]);
    expect(new Set(NOTE_THEMES.map((theme) => theme.id)).size).toBe(NOTE_THEME_IDS.length);
  });

  it("falls back to default and never accepts an arbitrary theme id", () => {
    expect(resolveNoteThemeTokens("remote-css", "light")).toEqual(resolveNoteThemeTokens("default", "light"));
  });

  it("retains old token projection only for backward compatibility", () => {
    const root = document.documentElement;
    applyNoteTheme("paper", root);
    expect(currentNoteThemeId(root)).toBe("paper");
    expect(root.style.getPropertyValue("--note-theme-surface")).toBe(resolveNoteThemeTokens("paper", "light").surface);

    root.classList.add("dark");
    applyNoteTheme("paper", root);
    expect(root.style.getPropertyValue("--note-theme-surface")).toBe(resolveNoteThemeTokens("paper", "dark").surface);

    applyNoteTheme("default", root);
    expect(root.style.getPropertyValue("--note-theme-surface")).toBe("");
    expect(root.style.getPropertyValue("--pm-text")).toBe("");
  });
});
