import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(__dirname, "../../components/TiptapEditor.tsx"), "utf8");

describe("manual Markdown conversion UI", () => {
  it("force-converts the selected text without relying on automatic detection", () => {
    const handler = source
      .split("const handleForceMarkdownConversion")[1]
      ?.split("const handleAIInsert")[0] || "";

    expect(handler).toContain('textBetween(from, to, "\\n")');
    expect(handler).toContain("mdToFullHtml(text) || markdownToSimpleHtml(text)");
    expect(handler).toContain("sanitizeForPaste");
    expect(handler).toContain("replaceRange(from, to, slice)");
    expect(handler).not.toContain("looksLikeMarkdown");
  });

  it("exposes the action in both the full toolbar and selection bubble", () => {
    expect(source.match(/onClick=\{handleForceMarkdownConversion\}/g)?.length)
      .toBeGreaterThanOrEqual(2);
    expect(source).toContain('title={t("tiptap.markdownForceConvert")}');
  });
});
