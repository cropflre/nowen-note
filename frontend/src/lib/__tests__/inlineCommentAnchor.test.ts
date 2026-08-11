import { describe, expect, it } from "vitest";
import {
  buildTextCommentAnchor,
  parseTextCommentAnchor,
  resolveTextCommentAnchor,
  serializeTextCommentAnchor,
} from "@/lib/inlineCommentAnchor";

describe("inlineCommentAnchor", () => {
  it("trims whitespace and records surrounding context", () => {
    const text = "第一段。\n  需要批注的内容  \n最后一段。";
    const start = text.indexOf("  需要");
    const end = text.indexOf("\n最后");
    const anchor = buildTextCommentAnchor({ editor: "markdown", documentText: text, start, end });

    expect(anchor).not.toBeNull();
    expect(anchor?.quote).toBe("需要批注的内容");
    expect(text.slice(anchor!.start, anchor!.end)).toBe(anchor?.quote);
    expect(anchor?.prefix).toContain("第一段");
    expect(anchor?.suffix).toContain("最后一段");
  });

  it("resolves the original exact position first", () => {
    const text = "开头 目标文字 结尾";
    const start = text.indexOf("目标");
    const anchor = buildTextCommentAnchor({
      editor: "tiptap",
      documentText: text,
      start,
      end: start + "目标文字".length,
    })!;

    expect(resolveTextCommentAnchor(text, anchor)).toEqual({
      start,
      end: start + "目标文字".length,
      exact: true,
    });
  });

  it("recovers after text is inserted before the anchor", () => {
    const original = "前文。需要批注。后文。";
    const start = original.indexOf("需要批注");
    const anchor = buildTextCommentAnchor({
      editor: "tiptap",
      documentText: original,
      start,
      end: start + "需要批注".length,
    })!;
    const updated = `新增内容。${original}`;
    const resolved = resolveTextCommentAnchor(updated, anchor);

    expect(resolved?.start).toBe(updated.indexOf("需要批注"));
    expect(resolved?.exact).toBe(false);
  });

  it("uses prefix and suffix to disambiguate duplicate quotes", () => {
    const original = "甲段 相同文本 乙段。丙段 相同文本 丁段。";
    const start = original.lastIndexOf("相同文本");
    const anchor = buildTextCommentAnchor({
      editor: "markdown",
      documentText: original,
      start,
      end: start + "相同文本".length,
    })!;
    const updated = `前置。${original}`;
    const resolved = resolveTextCommentAnchor(updated, anchor);

    expect(resolved?.start).toBe(updated.lastIndexOf("相同文本"));
  });

  it("rejects invalid serialized anchors", () => {
    expect(parseTextCommentAnchor("not-json")).toBeNull();
    expect(parseTextCommentAnchor(JSON.stringify({ kind: "text", version: 2 }))).toBeNull();
  });

  it("round trips a valid anchor", () => {
    const anchor = buildTextCommentAnchor({
      editor: "tiptap",
      documentText: "abc def ghi",
      start: 4,
      end: 7,
    })!;
    expect(parseTextCommentAnchor(serializeTextCommentAnchor(anchor))).toEqual(anchor);
  });
});
