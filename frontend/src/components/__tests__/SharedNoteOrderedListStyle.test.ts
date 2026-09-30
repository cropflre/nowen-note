import { describe, expect, it } from "vitest";
import stylesheet from "../../index.css?raw";

function compactCss(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ").trim();
}

describe("shared note ordered list markers", () => {
  const css = compactCss(stylesheet);

  it("keeps shared-note ordered-list levels aligned with the editor", () => {
    expect(css).toContain(
      ".shared-note-content ol { list-style-type: decimal !important; }",
    );
    expect(css).toContain(
      ".shared-note-content ol > li { display: list-item !important; list-style-type: decimal !important; }",
    );
    expect(css).toContain(
      ".shared-note-content ol > li > ol > li { list-style-type: lower-alpha !important; }",
    );
    expect(css).toContain(
      ".shared-note-content ol > li > ol > li > ol > li { list-style-type: lower-roman !important; }",
    );
  });

  it("matches the editor marker sequence instead of forcing every level to decimal", () => {
    expect(css).toContain(
      ".ProseMirror ol > li > ol > li { list-style-type: lower-alpha !important; }",
    );
    expect(css).toContain(
      ".ProseMirror ol > li > ol > li > ol > li { list-style-type: lower-roman !important; }",
    );
    expect(css).not.toContain(".shared-note-content ol { list-style: decimal; }");
  });
});
