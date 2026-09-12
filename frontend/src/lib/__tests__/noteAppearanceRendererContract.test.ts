import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../../note-appearance.css", import.meta.url), "utf8");

describe("note appearance renderer contract", () => {
  it("keeps RichText and every Markdown surface on the same token adapter", () => {
    expect(css).toContain(".ProseMirror");
    expect(css).toContain(".nowen-md-preview");
    expect(css).toContain(".nowen-md-editor .cm-content");
    expect(css).toContain("--note-theme-font-family");
    expect(css).toContain("--note-theme-font-size");
    expect(css).toContain("--note-theme-content-width");
  });

  it("does not hard-code individual non-default style ids in the renderer", () => {
    for (const id of ["paper", "minimal", "eye-care", "developer", "magazine"]) {
      expect(css).not.toContain(`data-note-theme=\"${id}\"`);
    }
  });
});
