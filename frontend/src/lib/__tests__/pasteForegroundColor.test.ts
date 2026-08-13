import { describe, expect, it } from "vitest";
import {
  normalizeLegacyFontColors,
  parseCssForegroundColor,
} from "@/lib/pasteForegroundColor";

describe("paste foreground color normalization", () => {
  it("normalizes legacy font colors so the paste sanitizer can preserve them", () => {
    const normalized = normalizeLegacyFontColors('<font color="#ffffff"><b>Hello</b></font>');
    expect(normalized).toContain("<span");
    expect(normalized).toContain("color");
    expect(normalized).toContain("<b>Hello</b>");
  });

  it("parses alpha-aware CSS colors", () => {
    expect(parseCssForegroundColor("#00000000")?.a).toBe(0);
    expect(parseCssForegroundColor("rgb(255 255 255 / 50%)")).toMatchObject({ r: 255, g: 255, b: 255, a: 0.5 });
  });
});
