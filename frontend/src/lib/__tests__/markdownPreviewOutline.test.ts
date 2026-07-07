import { describe, expect, it } from "vitest";
import {
  findMarkdownPreviewHeadingTarget,
  headingDataAttrs,
} from "@/lib/markdownPreviewOutline";

function heading(pos: number): HTMLElement {
  const el = document.createElement("h2");
  el.dataset.mdPos = String(pos);
  return el;
}

describe("markdownPreviewOutline", () => {
  it("emits data-md-pos from markdown node offsets", () => {
    expect(headingDataAttrs({ position: { start: { offset: 123 } } })).toEqual({
      "data-md-pos": "123",
    });
  });

  it("does not stringify missing offsets", () => {
    expect(headingDataAttrs({})).toEqual({});
    expect(headingDataAttrs({ position: { start: {} } })).toEqual({});
  });

  it("selects the exact heading target when available", () => {
    const first = heading(10);
    const exact = heading(42);
    const later = heading(80);

    expect(findMarkdownPreviewHeadingTarget([later, exact, first], 42)).toBe(exact);
  });

  it("falls back to the nearest previous heading when exact target is missing", () => {
    const first = heading(10);
    const nearestPrevious = heading(42);
    const later = heading(80);

    expect(findMarkdownPreviewHeadingTarget([later, first, nearestPrevious], 60)).toBe(nearestPrevious);
  });

  it("falls back to the first heading when all headings are after the requested position", () => {
    const first = heading(10);
    const later = heading(80);

    expect(findMarkdownPreviewHeadingTarget([later, first], 5)).toBe(first);
  });
});
