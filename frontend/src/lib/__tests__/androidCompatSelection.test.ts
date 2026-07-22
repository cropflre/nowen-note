import { describe, expect, it } from "vitest";
import { shouldShowAndroidSelectionFallback } from "../androidCompat";

describe("shouldShowAndroidSelectionFallback", () => {
  it("shows the fallback for an Android editor selection without another copy action", () => {
    expect(shouldShowAndroidSelectionFallback({
      isAndroidNative: true,
      hasVisibleTextSelection: true,
      hasExistingCopyAction: false,
    })).toBe(true);
  });

  it("keeps the existing Tiptap or CodeMirror copy bubble as the primary action", () => {
    expect(shouldShowAndroidSelectionFallback({
      isAndroidNative: true,
      hasVisibleTextSelection: true,
      hasExistingCopyAction: true,
    })).toBe(false);
  });

  it("does not render for a collapsed caret", () => {
    expect(shouldShowAndroidSelectionFallback({
      isAndroidNative: true,
      hasVisibleTextSelection: false,
      hasExistingCopyAction: false,
    })).toBe(false);
  });

  it("does not affect web, Electron, or iOS editors", () => {
    expect(shouldShowAndroidSelectionFallback({
      isAndroidNative: false,
      hasVisibleTextSelection: true,
      hasExistingCopyAction: false,
    })).toBe(false);
  });
});
