import { afterEach, describe, expect, it } from "vitest";
import {
  NOTE_THEMES,
  NOTE_THEME_IDS,
  applyNoteTheme,
  currentNoteThemeId,
  resolveNoteThemeTokens,
} from "@/lib/noteTheme";

describe("note theme engine", () => {
  afterEach(() => {
    document.documentElement.classList.remove("dark");
    applyNoteTheme("default");
  });

  it("keeps a unique, validated built-in registry", () => {
    expect(new Set(NOTE_THEMES.map((theme) => theme.id)).size).toBe(NOTE_THEME_IDS.length);
    for (const theme of NOTE_THEMES) {
      for (const mode of ["light", "dark"] as const) {
        const tokens = theme.modes[mode];
        expect(tokens.surface).toMatch(/^#[0-9a-f]{6}$/i);
        expect(tokens.text).toMatch(/^#[0-9a-f]{6}$/i);
        expect(Number.parseFloat(tokens.lineHeight)).toBeGreaterThanOrEqual(1.5);
        expect(tokens.contentMaxWidth).toMatch(/^\d+px$/);
      }
    }
  });

  it("falls back to default and never accepts an arbitrary theme id", () => {
    expect(resolveNoteThemeTokens("remote-css", "light")).toEqual(resolveNoteThemeTokens("default", "light"));
  });

  it("applies only the selected token set and refreshes it for dark mode", () => {
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
