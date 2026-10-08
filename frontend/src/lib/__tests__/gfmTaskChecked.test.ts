import { describe, expect, it } from "vitest";
import { getGfmTaskChecked } from "../gfmTaskChecked";

const checkbox = (checked: boolean) => ({
  type: "element", tagName: "input", properties: { type: "checkbox", checked },
});

describe("GFM task completion presentation", () => {
  it("detects checked and unchecked checkbox states", () => {
    expect(getGfmTaskChecked({ type: "element", tagName: "p", children: [checkbox(true)] })).toBe(true);
    expect(getGfmTaskChecked({ type: "element", tagName: "p", children: [checkbox(false)] })).toBe(false);
    expect(getGfmTaskChecked({
      type: "element", tagName: "li",
      children: [{ type: "element", tagName: "p", children: [checkbox(true)] }],
    })).toBe(true);
  });

  it("never mistakes an already checked nested child for the parent", () => {
    expect(getGfmTaskChecked({
      type: "element", tagName: "li",
      children: [{ type: "element", tagName: "ul", children: [
        { type: "element", tagName: "li", children: [
          { type: "element", tagName: "p", children: [checkbox(true)] },
        ] },
      ] }],
    })).toBe(null);
  });

  it("ignores ordinary list items and non-checkbox inputs", () => {
    expect(getGfmTaskChecked({ type: "element", tagName: "p", children: [
      { type: "element", tagName: "input", properties: { type: "text", checked: true } },
    ] })).toBe(null);
    expect(getGfmTaskChecked({ type: "element", tagName: "li", children: [
      { type: "element", tagName: "p", children: [{ type: "text" }] },
    ] })).toBe(null);
  });
});
