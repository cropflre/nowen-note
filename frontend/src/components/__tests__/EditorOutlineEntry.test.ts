import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync("src/components/EditorPane.tsx", "utf8");

describe("editor outline entry", () => {
  it("exposes the desktop outline toggle in the outer toolbar", () => {
    const outlineIndex = source.indexOf('data-editor-outline-toggle="desktop-toolbar"');
    const moreMenuIndex = source.indexOf('data-editor-more-menu="desktop"');

    expect(outlineIndex).toBeGreaterThan(-1);
    expect(moreMenuIndex).toBeGreaterThan(outlineIndex);
    expect(source).toContain('aria-pressed={showDesktopOutline}');
  });

  it("does not keep the desktop outline action inside the more menu", () => {
    expect(source).not.toContain("setShowOutline(!showOutline)");
    expect(source.match(/data-editor-outline-toggle=/g)).toHaveLength(1);
  });
});
