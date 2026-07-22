import { describe, expect, it } from "vitest";
import { resolveEditorBubbleKind } from "../editorBubbleSelection";

describe("resolveEditorBubbleKind", () => {
  it("keeps text selected inside a table text-only", () => {
    expect(resolveEditorBubbleKind({ selectionKind: "text", tableActive: true, linkActive: false, hasVisibleText: true })).toBe("text");
  });

  it("shows only the table bubble for a cell selection", () => {
    expect(resolveEditorBubbleKind({ selectionKind: "cell", tableActive: true, linkActive: false, hasVisibleText: true })).toBe("table");
  });

  it("gives an image node selection priority inside a table", () => {
    expect(resolveEditorBubbleKind({ selectionKind: "image", tableActive: true, linkActive: false, hasVisibleText: false })).toBe("image");
  });

  it("gives an empty table caret priority over a link bubble", () => {
    expect(resolveEditorBubbleKind({ selectionKind: "empty", tableActive: true, linkActive: true, hasVisibleText: false })).toBe("table");
  });

  it("shows a caret link bubble outside tables", () => {
    expect(resolveEditorBubbleKind({ selectionKind: "empty", tableActive: false, linkActive: true, hasVisibleText: false })).toBe("link");
  });

  it("hides text actions for invisible-only selections", () => {
    expect(resolveEditorBubbleKind({ selectionKind: "text", tableActive: true, linkActive: false, hasVisibleText: false })).toBe("none");
  });
});
