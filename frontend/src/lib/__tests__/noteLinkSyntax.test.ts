import { describe, expect, it } from "vitest";
import { buildWikiNoteLink, detectActiveWikiNoteQuery, parseInternalNoteHref, parseNoteLinkQuery, preprocessInternalNoteLinks } from "@/lib/noteLinkSyntax";

const ID = "11111111-1111-4111-8111-111111111111";

describe("note link syntax", () => {
  it("splits search title and fixed alias", () => {
    expect(parseNoteLinkQuery("目标笔记|我的别名")).toEqual({ searchText: "目标笔记", alias: "我的别名" });
  });
  it("builds and parses stable block links", () => {
    const source = buildWikiNoteLink(ID, "blk_target", "别名");
    expect(source).toBe(`[[note:${ID}#blk:blk_target|别名]]`);
    expect(parseInternalNoteHref(`note:${ID}#blk:blk_target`)).toEqual({ noteId: ID, blockId: "blk_target" });
  });
  it("detects an active CodeMirror wiki query", () => {
    expect(detectActiveWikiNoteQuery("文字 [[目标|别名", 20, 3)).toEqual({ query: "目标|别名", from: 6, to: 20 });
  });
  it("preprocesses links and embeds but preserves fenced code", () => {
    const md = `[[note:${ID}]]\n\n![[note:${ID}#blk:blk_target]]\n\n\`\`\`md\n[[note:${ID}]]\n\`\`\``;
    const html = preprocessInternalNoteLinks(md);
    expect(html).toContain("data-nowen-title-mode=\"auto\"");
    expect(html).toContain("data-nowen-block-embed");
    expect(html).toContain(`\`\`\`md\n[[note:${ID}]]`);
  });
});
