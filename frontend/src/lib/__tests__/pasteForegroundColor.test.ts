import { describe, expect, it } from "vitest";
import {
  analyzeRiskyForegroundColors,
  normalizeLegacyFontColors,
  parseCssForegroundColor,
  stripExplicitForegroundColors,
} from "@/lib/pasteForegroundColor";

describe("paste foreground color risk detection", () => {
  it("detects explicit dark and light colors in common CSS formats", () => {
    const report = analyzeRiskyForegroundColors(`
      <p><span style="color: rgb(20, 20, 20)">dark</span></p>
      <p><span style="color: #f5f5f5">light</span></p>
      <p><span style="color: hsl(0 0% 100%)">white</span></p>
    `);
    expect(report).toMatchObject({ total: 3, dark: 1, light: 2 });
  });

  it("ignores inherited, theme-variable, transparent and middle-brightness colors", () => {
    const report = analyzeRiskyForegroundColors(`
      <span style="color: currentColor">a</span>
      <span style="color: var(--text-color)">b</span>
      <span style="color: transparent">c</span>
      <span style="color: rgb(120, 130, 140)">d</span>
      <span style="background-color: #fff">e</span>
    `);
    expect(report.total).toBe(0);
  });

  it("normalizes legacy font colors so the paste sanitizer can preserve them", () => {
    const normalized = normalizeLegacyFontColors('<font color="#ffffff"><b>Hello</b></font>');
    expect(normalized).toContain("<span");
    expect(normalized).toContain("color");
    expect(normalized).toContain("<b>Hello</b>");
  });

  it("removes only foreground colors and preserves other formatting", () => {
    const output = stripExplicitForegroundColors(
      '<p><a href="https://example.com"><strong style="color:#fff;font-weight:700;background:#000">Text</strong></a></p>',
    );
    expect(output).not.toMatch(/color\s*:/i);
    expect(output).toContain("font-weight: 700");
    expect(output).toContain("background: rgb(0, 0, 0)");
    expect(output).toContain('<a href="https://example.com">');
    expect(output).toContain("<strong");
  });

  it("parses alpha-aware CSS colors", () => {
    expect(parseCssForegroundColor("#00000000")?.a).toBe(0);
    expect(parseCssForegroundColor("rgb(255 255 255 / 50%)")).toMatchObject({ r: 255, g: 255, b: 255, a: 0.5 });
  });
});
