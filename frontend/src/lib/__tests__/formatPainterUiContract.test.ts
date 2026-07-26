import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(__dirname, "../../components/TiptapEditor.tsx"), "utf8");

describe("format painter UI contract", () => {
  it("integrates one-shot capture and target selection into the rich-text editor", () => {
    expect(source).toContain("captureTextFormat");
    expect(source).toContain("applyCapturedTextFormat");
    expect(source).toContain("formatPainterArmed");
    expect(source).toContain('editor.on("selectionUpdate"');
    expect(source).toContain('event.key === "Escape"');
  });

  it("exposes the action in the full toolbar and text-selection bubble", () => {
    expect(source.match(/<Paintbrush size=/g)?.length).toBeGreaterThanOrEqual(2);
    expect(source).toContain("toggleFormatPainter");
    expect(source).toContain("data-format-painter-active");
  });
});
