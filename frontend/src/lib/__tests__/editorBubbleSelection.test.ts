import { describe, expect, it } from "vitest";
import { resolveEditorBubbleKind, resolveEditorBubblePosition } from "../editorBubbleSelection";

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

describe("resolveEditorBubblePosition", () => {
  it("keeps an Android touch bubble below the selection", () => {
    expect(resolveEditorBubblePosition({
      anchorTop: 300,
      anchorBottom: 360,
      centerX: 180,
      bubbleWidth: 220,
      bubbleHeight: 40,
      viewportTop: 0,
      viewportLeft: 0,
      viewportWidth: 360,
      viewportHeight: 640,
      touchLayout: true,
    })).toEqual({ top: 368, left: 70 });
  });

  it("docks a touch bubble at the visible bottom instead of moving it above the selection", () => {
    expect(resolveEditorBubblePosition({
      anchorTop: 500,
      anchorBottom: 620,
      centerX: 180,
      bubbleWidth: 600,
      bubbleHeight: 40,
      viewportTop: 0,
      viewportLeft: 0,
      viewportWidth: 360,
      viewportHeight: 640,
      touchLayout: true,
    })).toEqual({ top: 592, left: 8 });
  });

  it("keeps the desktop bubble above the selection", () => {
    expect(resolveEditorBubblePosition({
      anchorTop: 300,
      anchorBottom: 360,
      centerX: 180,
      bubbleWidth: 220,
      bubbleHeight: 40,
      viewportTop: 0,
      viewportLeft: 0,
      viewportWidth: 360,
      viewportHeight: 640,
      touchLayout: false,
    })).toEqual({ top: 256, left: 70 });
  });
});
