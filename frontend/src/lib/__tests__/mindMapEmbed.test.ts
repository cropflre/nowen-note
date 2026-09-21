import { describe, expect, it } from "vitest";
import { preprocessInternalNoteLinks } from "@/lib/noteLinkSyntax";
import { markdownToTiptapJSON, tiptapJsonToMarkdown } from "@/lib/contentFormat";

const ID = "11111111-1111-4111-8111-111111111111";
const source = `![[mindmap:${ID}]]`;

describe("native mind map document references", () => {
  it("preprocesses a stable reference without copying data or generating an API URL", () => {
    const rendered = preprocessInternalNoteLinks(source);
    expect(rendered).toContain(`data-nowen-block-embed="mindmap:${ID}"`);
    expect(rendered).not.toContain("/api/");
  });

  it("does not interpret a mind map embed in fenced code", () => {
    expect(preprocessInternalNoteLinks(`\`\`\`markdown\n${source}\n\`\`\``)).toContain(source);
  });

  it("rejects malformed and non-embed map wiki links", () => {
    expect(preprocessInternalNoteLinks("![[mindmap:not-a-uuid]]")).not.toContain("data-nowen-block-embed");
    expect(preprocessInternalNoteLinks(`[[mindmap:${ID}]]`)).not.toContain("data-nowen-block-embed");
  });

  it("preserves the native reference through Markdown to Tiptap and back", () => {
    const document = markdownToTiptapJSON(`前文\n\n${source}\n\n后文`);
    const embedded = document.content.find((node: any) => node.type === "blockEmbed");
    expect(embedded?.attrs?.href).toBe(`mindmap:${ID}`);
    expect(tiptapJsonToMarkdown(document)).toContain(source);
  });
});
