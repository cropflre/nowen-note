import { describe, expect, it } from "vitest";
import { resolveEditorFontGuardState } from "@/lib/editorFontAppearanceGuard";

describe("editor font vs app appearance priority", () => {
  it("captures an explicit editor font written by SiteSettings", () => {
    expect(resolveEditorFontGuardState(
      "'Cascadia Code', monospace",
      "Georgia, serif",
      "",
    )).toEqual({
      protectedFont: "'Cascadia Code', monospace",
      restoreFont: null,
    });
  });

  it("restores the explicit editor font after an appearance switch overwrites it", () => {
    expect(resolveEditorFontGuardState(
      "Georgia, serif",
      "Georgia, serif",
      "'Cascadia Code', monospace",
    )).toEqual({
      protectedFont: "'Cascadia Code', monospace",
      restoreFont: "'Cascadia Code', monospace",
    });
  });

  it("restores the explicit editor font when switching back to the default appearance clears the projection", () => {
    expect(resolveEditorFontGuardState(
      "",
      "",
      "system-ui, sans-serif",
    )).toEqual({
      protectedFont: "system-ui, sans-serif",
      restoreFont: "system-ui, sans-serif",
    });
  });

  it("does not invent an editor font before SiteSettings has supplied one", () => {
    expect(resolveEditorFontGuardState(
      "Georgia, serif",
      "Georgia, serif",
      "",
    )).toEqual({ protectedFont: "", restoreFont: null });
  });
});
