import { describe, expect, it } from "vitest";
import {
  parseSiyuanCalloutMarker,
  remarkSiyuanCallouts,
} from "@/lib/markdownCallouts";

function runPlugin(tree: any) {
  const transformer = remarkSiyuanCallouts();
  transformer(tree);
  return tree;
}

function calloutTree(firstText: string, restText = "正文") {
  return {
    type: "root",
    children: [
      {
        type: "blockquote",
        children: [
          {
            type: "paragraph",
            children: [
              { type: "text", value: firstText },
            ],
          },
          {
            type: "paragraph",
            children: [
              { type: "text", value: restText },
            ],
          },
        ],
      },
    ],
  };
}

describe("markdownCallouts", () => {
  it.each([
    ["[!NOTE]", "note", "Note"],
    ["[!TIP]", "tip", "Tip"],
    ["[!IMPORTANT]", "important", "Important"],
    ["[!WARNING]", "warning", "Warning"],
    ["[!CAUTION]", "caution", "Caution"],
  ])("parses %s markers", (marker, type, title) => {
    expect(parseSiyuanCalloutMarker(marker)).toEqual({ type, title, rest: "" });
  });

  it("parses markers case-insensitively", () => {
    expect(parseSiyuanCalloutMarker("[!note]")).toEqual({
      type: "note",
      title: "Note",
      rest: "",
    });
  });

  it("uses custom title text after the marker", () => {
    expect(parseSiyuanCalloutMarker("[!NOTE] 自定义标题")).toEqual({
      type: "note",
      title: "自定义标题",
      rest: "",
    });
  });

  it("marks callout blockquotes and removes the marker paragraph", () => {
    const tree = runPlugin(calloutTree("[!TIP]", "支持 **Markdown**"));
    const blockquote = tree.children[0];

    expect(blockquote.data.hProperties).toMatchObject({
      "data-callout-type": "tip",
      "data-callout-title": "Tip",
    });
    expect(blockquote.children).toEqual([
      {
        type: "paragraph",
        children: [
          { type: "text", value: "支持 **Markdown**" },
        ],
      },
    ]);
  });

  it("keeps marker line trailing body text", () => {
    const tree = runPlugin(calloutTree("[!WARNING] 注意事项"));
    const blockquote = tree.children[0];

    expect(blockquote.data.hProperties["data-callout-title"]).toBe("注意事项");
    expect(blockquote.children).toEqual([
      {
        type: "paragraph",
        children: [
          { type: "text", value: "正文" },
        ],
      },
    ]);
  });

  it("does not mark ordinary blockquotes", () => {
    const tree = runPlugin(calloutTree("普通引用"));
    const blockquote = tree.children[0];

    expect(blockquote.data).toBeUndefined();
    expect(blockquote.children[0].children[0].value).toBe("普通引用");
  });
});
