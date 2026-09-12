import { afterEach, describe, expect, it } from "vitest";
import {
  NOTE_THEMES,
  NOTE_THEME_IDS,
  applyNoteTheme,
  currentNoteThemeId,
  noteThemeTokenProperties,
  resolveNoteThemeTokens,
} from "@/lib/noteTheme";

describe("note appearance style registry", () => {
  afterEach(() => {
    document.documentElement.classList.remove("dark");
    applyNoteTheme("default");
  });

  it("ships one canonical registry with the six product styles", () => {
    expect(NOTE_THEME_IDS).toEqual([
      "default",
      "paper",
      "minimal",
      "eye-care",
      "developer",
      "magazine",
    ]);
    expect(NOTE_THEMES.map((theme) => theme.name.zh)).toEqual([
      "Nowen 默认",
      "纸张阅读",
      "极简写作",
      "夜间护眼",
      "开发文档",
      "杂志排版",
    ]);
    expect(new Set(NOTE_THEMES.map((theme) => theme.id)).size).toBe(NOTE_THEME_IDS.length);
  });

  it("keeps every built-in style inside the white-listed token contract", () => {
    for (const theme of NOTE_THEMES) {
      for (const mode of ["light", "dark"] as const) {
        const tokens = theme.modes[mode];
        expect(tokens.surface).toMatch(/^#[0-9a-f]{6}$/i);
        expect(tokens.text).toMatch(/^#[0-9a-f]{6}$/i);
        expect(Number.parseFloat(tokens.lineHeight)).toBeGreaterThanOrEqual(1.5);
        expect(tokens.contentMaxWidth).toMatch(/^\d+px$/);
        expect(tokens.fontSize).toMatch(/^\d+(?:\.\d+)?px$/);
        const serialized = JSON.stringify(tokens).toLowerCase();
        expect(serialized).not.toContain("url(");
        expect(serialized).not.toContain("@import");
        expect(serialized).not.toContain("javascript:");
      }
    }
    expect(noteThemeTokenProperties().every((name) => name.startsWith("--"))).toBe(true);
  });

  it("falls back to Nowen Default and never accepts an arbitrary style id", () => {
    expect(resolveNoteThemeTokens("remote-css", "light")).toEqual(resolveNoteThemeTokens("default", "light"));
  });

  it("applies the selected style and refreshes all projected tokens for dark mode", () => {
    const root = document.documentElement;
    applyNoteTheme("paper", root);
    expect(currentNoteThemeId(root)).toBe("paper");
    expect(root.style.getPropertyValue("--note-theme-surface")).toBe(resolveNoteThemeTokens("paper", "light").surface);
    expect(root.style.getPropertyValue("--note-theme-font-family")).toBe(resolveNoteThemeTokens("paper", "light").fontFamily);

    root.classList.add("dark");
    applyNoteTheme("paper", root);
    expect(root.style.getPropertyValue("--note-theme-surface")).toBe(resolveNoteThemeTokens("paper", "dark").surface);

    applyNoteTheme("default", root);
    expect(root.style.getPropertyValue("--note-theme-surface")).toBe("");
    expect(root.style.getPropertyValue("--pm-text")).toBe("");
    expect(root.style.getPropertyValue("--note-theme-font-family")).toBe("");
  });

  it("keeps Night Eye Care dark even when the application is in light mode", () => {
    const night = resolveNoteThemeTokens("eye-care", "light");
    expect(night.surface).toBe("#171c1a");
    expect(night.text).toBe("#d6ded2");
  });
});
