import { describe, expect, it } from "vitest";
import React from "react";
import { getGfmTaskChecked, wrapGfmTaskInlineContent } from "../gfmTaskChecked";

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

  it("separates inline task text and keeps nested list outside the strike span", () => {
    const elements = wrapGfmTaskInlineContent([
      React.createElement("input", { key: "input", type: "checkbox" }),
      " parent",
      React.createElement("strong", { key: "strong" }, "strong"),
      React.createElement("ul", { key: "child" }, React.createElement("li", null, "nested")),
    ]);
    const output = React.Children.toArray(elements);
    expect(output).toHaveLength(3);
    expect((output[1] as React.ReactElement<{ className: string }>).props.className).toBe("nowen-task-item-text");
    expect((output[2] as React.ReactElement).type).toBe("ul");
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
