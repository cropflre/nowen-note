import { describe, expect, it } from "vitest";
import {
  resolveTiptapEditorScrollContainer,
  resolveTiptapEditorScrollLayout,
} from "../tiptapEditorScrollLayout";

describe("resolveTiptapEditorScrollLayout", () => {
  it("keeps the monolithic editor as its own scroll container", () => {
    expect(resolveTiptapEditorScrollLayout(false, false)).toEqual({
      root: "h-full",
      content: "flex-1 overflow-auto",
      ownsViewportOverlay: true,
    });
  });

  it("flattens the first windowed editor so its sticky toolbar belongs to the parent", () => {
    expect(resolveTiptapEditorScrollLayout(true, true)).toEqual({
      root: "contents",
      content: "overflow-visible",
      ownsViewportOverlay: false,
    });
  });

  it("delegates later windowed sections to the parent without flattening their frame", () => {
    expect(resolveTiptapEditorScrollLayout(true, false)).toEqual({
      root: "h-auto min-h-0",
      content: "overflow-visible",
      ownsViewportOverlay: false,
    });
  });

  it("resolves the real parent scroller only for windowed sections", () => {
    const parent = document.createElement("div");
    parent.dataset.windowedTiptapEditor = "true";
    const section = document.createElement("section");
    const content = document.createElement("div");
    parent.append(section);
    section.append(content);

    expect(resolveTiptapEditorScrollContainer(content, false)).toBe(content);
    expect(resolveTiptapEditorScrollContainer(content, true)).toBe(parent);
    expect(resolveTiptapEditorScrollContainer(null, true)).toBeNull();
  });
});
