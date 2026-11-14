import { describe, expect, it } from "vitest";
import { markdownToTiptapJSON, tiptapJsonToMarkdown } from "@/lib/contentFormat";

// Rich text ↔ Markdown fidelity for adjacent lists and for formatting that only HTML can carry.
type Json = { type: string; attrs?: Record<string, any>; content?: Json[]; text?: string; marks?: Array<{ type: string }> };
const text = (value: string, marks?: string[]): Json => ({ type: "text", text: value, ...(marks ? { marks: marks.map((type) => ({ type })) } : {}) });
const p = (value: string | Json[], attrs: Record<string, unknown> = {}): Json => ({ type: "paragraph", attrs, content: typeof value === "string" ? (value ? [text(value)] : []) : value });
const doc = (...content: Json[]): Json => ({ type: "doc", content });
const find = (node: Json, type: string): Json[] => {
  const out: Json[] = [];
  const walk = (n: Json) => { if (n.type === type) out.push(n); n.content?.forEach(walk); };
  walk(node);
  return out;
};
const plain = (node: Json): string => node.text ?? (node.content || []).map(plain).join("");
const roundTrip = (input: Json) => {
  const md = tiptapJsonToMarkdown(input);
  return { md, back: markdownToTiptapJSON(md) as Json };
};

describe("adjacent lists", () => {
  for (const ids of [false, true]) {
    it(`keeps bullet and task lists apart when they follow each other${ids ? " (with IDs)" : ""}`, () => {
      const id = (value: string) => (ids ? { blockId: value } : {});
      const { back } = roundTrip(doc(
        { type: "bulletList", content: [{ type: "listItem", attrs: id("blk_item0001"), content: [p("plain")] }] },
        { type: "taskList", content: [
          { type: "taskItem", attrs: { checked: true, ...id("blk_task0001") }, content: [p("done")] },
          { type: "taskItem", attrs: { checked: false, ...id("blk_task0002") }, content: [p("todo")] },
        ] },
        { type: "bulletList", content: [{ type: "listItem", attrs: id("blk_item0002"), content: [p("again")] }] },
      ));
      expect(back.content!.map((node) => node.type)).toEqual(["bulletList", "taskList", "bulletList"]);
      expect(find(back, "taskItem").map((node) => [plain(node), node.attrs?.checked])).toEqual([["done", true], ["todo", false]]);
      if (ids) expect(find(back, "taskItem").map((node) => node.attrs?.blockId)).toEqual(["blk_task0001", "blk_task0002"]);
    });
  }
});

describe("formatting kept in HTML", () => {
  it("keeps alignment, inline marks and IDs of paragraphs and headings", () => {
    const { back } = roundTrip(doc(
      { type: "heading", attrs: { level: 2, textAlign: "center", blockId: "blk_head0001" }, content: [text("Title")] },
      p([text("Body "), text("strong", ["bold"])], { textAlign: "right", blockId: "blk_body0001" }),
    ));
    expect(back.content!.map((node) => [node.type, node.attrs?.textAlign, node.attrs?.blockId, plain(node)])).toEqual([
      ["heading", "center", "blk_head0001", "Title"],
      ["paragraph", "right", "blk_body0001", "Body strong"],
    ]);
    expect(find(back, "text").find((node) => node.text === "strong")?.marks?.map((mark) => mark.type)).toEqual(["bold"]);
  });

  it("keeps an aligned last paragraph's own ID and the quote's ID", () => {
    const { md, back } = roundTrip(doc({ type: "blockquote", attrs: { blockId: "blk_quote0001" }, content: [
      p("first", { blockId: "blk_qpara001" }), p("centered", { textAlign: "center", blockId: "blk_qpara002" }),
    ] }));
    expect(md).not.toMatch(/blk_qpara002\s*$/m);
    expect(JSON.stringify(back)).not.toContain("^blk_");
    expect(find(back, "blockquote")[0].attrs?.blockId).toBe("blk_quote0001");
    expect(find(back, "paragraph").map((node) => [plain(node), node.attrs?.blockId, node.attrs?.textAlign ?? null])).toEqual([
      ["first", "blk_qpara001", null], ["centered", "blk_qpara002", "center"],
    ]);
  });

  it("keeps the title and ID of code blocks, including blank lines in the code", () => {
    const { md, back } = roundTrip(doc({ type: "codeBlock", attrs: { language: "js", title: "demo.js", blockId: "blk_code0001" }, content: [text("const a = 1;\n\nconst b = 2;")] }));
    expect(md).not.toMatch(/\n[ \t]*\n/);
    const [code] = find(back, "codeBlock");
    expect([code.attrs?.title, code.attrs?.language, code.attrs?.blockId, plain(code)]).toEqual(["demo.js", "js", "blk_code0001", "const a = 1;\n\nconst b = 2;"]);
  });
});

describe("markers the server writes after HTML blocks", () => {
  it("reads them as the block's ID without leaving marker text", () => {
    const back = markdownToTiptapJSON([
      '<p style="text-align: center" data-block-id="blk_center001">Body</p> ^blk_center001',
      '<pre data-title="t" data-block-id="blk_code00001"><code>x</code></pre> ^blk_code00001',
      // Older content can hold a multi-line <pre>: its ID sits on the line after the closing tag
      '<pre data-title="demo.js"><code class="language-js">const a = 1;\n\nconst b = 2;</code></pre>\n^blk_code00002',
    ].join("\n\n")) as Json;
    expect(back.content!.map((node) => [node.type, node.attrs?.blockId, node.attrs?.textAlign ?? null, node.attrs?.title ?? null, plain(node)])).toEqual([
      ["paragraph", "blk_center001", "center", null, "Body"],
      ["codeBlock", "blk_code00001", null, "t", "x"],
      ["codeBlock", "blk_code00002", null, "demo.js", "const a = 1;\n\nconst b = 2;"],
    ]);
    expect(JSON.stringify(back)).not.toContain("^blk_");
  });
});
