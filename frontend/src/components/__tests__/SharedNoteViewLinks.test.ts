import { describe, expect, it } from "vitest";
import {
  isExternalHttpLink,
  normalizeExternalHref,
  prepareSharedMarkdownForDisplay,
  renderTiptapJSON,
} from "../SharedNoteView";

describe("SharedNoteView shared content links", () => {
  it("classifies only external http links for new-tab behavior", () => {
    expect(isExternalHttpLink("https://example.com")).toBe(true);
    expect(isExternalHttpLink("http://example.com")).toBe(true);
    expect(isExternalHttpLink("//example.com")).toBe(true);

    expect(isExternalHttpLink("#heading")).toBe(false);
    expect(isExternalHttpLink("note:abc")).toBe(false);
    expect(isExternalHttpLink("mailto:a@b.com")).toBe(false);
    expect(isExternalHttpLink("tel:123")).toBe(false);
    expect(isExternalHttpLink("sms:123")).toBe(false);
    expect(isExternalHttpLink("/api/attachments/file-id")).toBe(false);
  });

  it("normalizes protocol-relative external links before window.open", () => {
    expect(normalizeExternalHref("//example.com/path")).toBe("http://example.com/path");
    expect(normalizeExternalHref(" https://example.com/path ")).toBe("https://example.com/path");
  });

  it("removes internal block markers from shared Markdown without touching fenced code", () => {
    const headingId = "blk_d4036fa3-d1bc-4122-8cb7-e38c70121fd2";
    const paragraphId = "blk_9d522ad3-f979-4f5c-8199-04cf015a2f2b";
    const standaloneId = "blk_9410a1d5-c5a6-4500-bd74-fff701f61dd5";
    const codeId = "blk_70cdc697-85b2-4797-8b4e-c5bfefc594f4";
    const internal = [
      `# 前端研发组团队周报 ^${headingId}`,
      "",
      `生成时间：2026-07-28 ^${paragraphId}`,
      "",
      `^${standaloneId}`,
      "",
      "```text",
      `^${codeId}`,
      "```",
    ].join("\n");

    const projected = prepareSharedMarkdownForDisplay(internal);

    expect(projected).toContain("# 前端研发组团队周报");
    expect(projected).toContain("生成时间：2026-07-28");
    expect(projected).not.toContain(headingId);
    expect(projected).not.toContain(paragraphId);
    expect(projected).not.toContain(standaloneId);
    expect(projected).toContain(`^${codeId}`);
  });

  it("keeps Tiptap visual indent in shared HTML", () => {
    const html = renderTiptapJSON({
      type: "doc",
      content: [
        { type: "paragraph", attrs: { indent: 1 }, content: [{ type: "text", text: "one" }] },
        { type: "heading", attrs: { level: 2, indent: 2 }, content: [{ type: "text", text: "two" }] },
        {
          type: "blockquote",
          attrs: { indent: 3 },
          content: [{ type: "paragraph", content: [{ type: "text", text: "three" }] }],
        },
        { type: "codeBlock", attrs: { language: null, indent: 4 }, content: [{ type: "text", text: "four" }] },
      ],
    });

    expect(html).toContain('<p data-indent="1">one</p>');
    expect(html).toContain('<h2 data-indent="2">two</h2>');
    expect(html).toContain('<blockquote data-indent="3">');
    expect(html).toContain('class="shared-code-block" data-indent="4"');
  });

});
