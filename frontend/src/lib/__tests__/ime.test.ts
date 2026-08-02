import { describe, expect, it } from "vitest";
import { isImeKeyEvent } from "@/lib/ime";

describe("isImeKeyEvent", () => {
  it("recognizes the standard composition flag", () => {
    expect(isImeKeyEvent({ isComposing: true, keyCode: 13 })).toBe(true);
  });

  it("recognizes Chromium's Windows IME keyCode 229 fallback", () => {
    expect(isImeKeyEvent({ isComposing: false, keyCode: 229 })).toBe(true);
  });

  it("does not block normal keyboard input", () => {
    expect(isImeKeyEvent({ isComposing: false, keyCode: 65 })).toBe(false);
  });
});
