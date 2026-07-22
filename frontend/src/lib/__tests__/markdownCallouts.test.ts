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

function paragraph(value: string) {
  return { type: "paragraph", children: [{ type: "text", value }] };
}

function calloutTree(firstText: string, restText = "正文", extras: any[] = []) {
  return {
    type: "root",
    children: [{
      type: "blockquote",
      children: [paragraph(firstText), paragraph(restText), ...extras],
    }],
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
    expect(parseSiyuanCalloutMarker(marker)).toEqual({ type, title, rest: "", fold: null });
  });

  it("normalizes compatible aliases", () => {
    expect(parseSiyuanCalloutMarker("[!SUCCESS] 已完成")).toEqual({
      type: "tip",
      title: "已完成",
      rest: "",
      fold: null,
    });
    expect(parseSiyuanCalloutMarker("[!DANGER]")).toEqual({
      type: "caution",
      title: "Caution",
      rest: "",
      fold: null,
    });
  });

  it("parses markers case-insensitively", () => {
    expect(parseSiyuanCalloutMarker("[!note]")).toEqual({
      type: "note",
      title: "Note",
      rest: "",
      fold: null,
    });
  });

  it("uses custom title text after the marker", () => {
    expect(parseSiyuanCalloutMarker("[!NOTE] 自定义标题")).toEqual({
      type: "note",
      title: "自定义标题",
      rest: "",
      fold: null,
    });
  });

  it("preserves collapsible callout state", () => {
    expect(parseSiyuanCalloutMarker("[!TIP]+ 可展开提示")).toEqual({
      type: "tip",
      title: "可展开提示",
      rest: "",
      fold: "expanded",
    });
    expect(parseSiyuanCalloutMarker("[!WARNING]- 收起提示")?.fold).toBe("collapsed");
  });

  it("keeps same-paragraph body text after the marker line", () => {
    expect(parseSiyuanCalloutMarker("[!TIP]\n提示正文")).toEqual({
      type: "tip",
      title: "Tip",
      rest: "提示正文",
      fold: null,
    });
  });

  it("marks callout blockquotes and removes the marker paragraph", () => {
    const tree = runPlugin(calloutTree("[!TIP]", "支持 **Markdown**"));
    const blockquote = tree.children[0];

    expect(blockquote.data.hProperties).toMatchObject({
      "data-callout-type": "tip",
      "data-callout-title": "Tip",
    });
    expect(blockquote.children).toEqual([paragraph("支持 **Markdown**")]);
  });

  it("preserves content stored in the marker paragraph", () => {
    const tree = runPlugin(calloutTree("[!TIP]\n同段提示正文", "下一段"));
    const blockquote = tree.children[0];

    expect(blockquote.data.hProperties["data-callout-type"]).toBe("tip");
    expect(blockquote.children[0].children[0].value).toBe("同段提示正文");
    expect(blockquote.children[1].children[0].value).toBe("下一段");
  });

  it("removes SiYuan block IAL rows from rendered content", () => {
    const tree = runPlugin(calloutTree("[!TIP]- 折叠", "正文", [paragraph('{: id="20260719010101-abcdefg"}')]));
    const blockquote = tree.children[0];

    expect(blockquote.data.hProperties["data-callout-fold"]).toBe("collapsed");
    expect(blockquote.children).toEqual([paragraph("正文")]);
  });

  it("keeps marker line trailing title separate from the body", () => {
    const tree = runPlugin(calloutTree("[!WARNING] 注意事项"));
    const blockquote = tree.children[0];

    expect(blockquote.data.hProperties["data-callout-title"]).toBe("注意事项");
    expect(blockquote.children).toEqual([paragraph("正文")]);
  });

  it("does not mark ordinary blockquotes", () => {
    const tree = runPlugin(calloutTree("普通引用"));
    const blockquote = tree.children[0];

    expect(blockquote.data).toBeUndefined();
    expect(blockquote.children[0].children[0].value).toBe("普通引用");
  });
});
