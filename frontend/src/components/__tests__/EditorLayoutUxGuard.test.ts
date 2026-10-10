import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  path.resolve(__dirname, "../TiptapEditor.tsx"),
  "utf8",
);
const css = readFileSync(
  path.resolve(__dirname, "../../index.css"),
  "utf8",
);

describe("editor layout UX guards (#772)", () => {
  it("keeps first-line indent separate from block indent", () => {
    expect(source).toContain("toggleFirstLineIndent()");
    expect(source).toContain('firstLineIndent: 2');
    expect(source).toContain("changeIndent(1)");
    expect(source).toContain("changeIndent(-1)");
    expect(source).toContain("首2");
  });

  it("keeps desktop table resize and whole-table layout controls", () => {
    expect(source).toContain("resizable: true");
    expect(source).toContain("cellMinWidth: 60");
    expect(source).toContain('setTableLayoutAlign("left")');
    expect(source).toContain('setTableLayoutAlign("center")');
    expect(source).toContain('setTableLayoutAlign("right")');
    expect(source).toContain('setTableWidthMode("auto")');
    expect(source).toContain('setTableWidthMode("full")');
    expect(css).toContain(".column-resize-handle");
    expect(css).toContain("cursor: col-resize");
  });

  it("offers touch-friendly column width presets instead of a tiny resize handle", () => {
    expect(source).toContain("setCurrentTableColumnWidth");
    expect(source).toContain('["narrow", t("tiptap.tableWidthNarrow"');
    expect(source).toContain('["medium", t("tiptap.tableWidthMedium"');
    expect(source).toContain('["wide", t("tiptap.tableWidthWide"');
    expect(source).toContain("TableMap.get(tableNode)");
    expect(source).toContain("setCellSelection({ anchorCell, headCell })");
  });

  it("lets oversized resized tables scroll instead of stretching the editor", () => {
    expect(css).toContain(".ProseMirror .tableWrapper");
    expect(css).toContain("overflow-x: auto");
    expect(css).toContain("max-width: none");
  });
});
