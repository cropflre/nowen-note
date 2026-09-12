import { describe, expect, it } from "vitest";
import {
  DEFAULT_NOTE_THEME_ID,
  NOTE_THEMES,
  isKnownNoteTheme,
  noteThemeCssVariables,
  resolveNoteTheme,
} from "@/lib/noteAppearance";

describe("Note Appearance Engine", () => {
  it("ships stable built-in note themes", () => {
    expect(NOTE_THEMES.map((theme) => theme.id)).toEqual([
      "nowen.default",
      "nowen.paper",
      "nowen.minimal",
      "nowen.night",
    ]);
  });

  it("falls back to the default theme for missing or unknown theme ids", () => {
    expect(resolveNoteTheme(undefined).id).toBe(DEFAULT_NOTE_THEME_ID);
    expect(resolveNoteTheme("publisher.missing").id).toBe(DEFAULT_NOTE_THEME_ID);
  });

  it("resolves ids case-insensitively without rewriting stored ids", () => {
    expect(resolveNoteTheme("NOWEN.PAPER").id).toBe("nowen.paper");
    expect(isKnownNoteTheme("nowen.night")).toBe(true);
    expect(isKnownNoteTheme("https://evil.example/theme.css")).toBe(false);
  });

  it("projects a theme only into the white-listed CSS token surface", () => {
    const vars = noteThemeCssVariables(resolveNoteTheme("nowen.paper"));
    expect(vars["--note-theme-surface"]).toBe("#fffaf0");
    expect(vars["--note-theme-max-width"]).toBe("780px");
    expect(Object.keys(vars).every((name) => name.startsWith("--note-theme-"))).toBe(true);
    expect(JSON.stringify(vars)).not.toContain("url(");
    expect(JSON.stringify(vars)).not.toContain("@import");
  });
});
