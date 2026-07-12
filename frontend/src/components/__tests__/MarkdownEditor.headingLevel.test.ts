import { describe, expect, it } from "vitest";
import { normalizeFormatHeadingLevel } from "../MarkdownEditor";

describe("normalizeFormatHeadingLevel", () => {
  it("preserves heading levels 4-6 for desktop format menu events", () => {
    expect(normalizeFormatHeadingLevel(4)).toBe(4);
    expect(normalizeFormatHeadingLevel(5)).toBe(5);
    expect(normalizeFormatHeadingLevel(6)).toBe(6);
  });

  it("clamps out-of-range levels into the supported 1-6 range", () => {
    expect(normalizeFormatHeadingLevel(0)).toBe(1);
    expect(normalizeFormatHeadingLevel(9)).toBe(6);
  });
});
