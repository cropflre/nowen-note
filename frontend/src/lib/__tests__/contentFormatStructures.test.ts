import { describe, expect, it } from "vitest";
import { markdownToTiptapJSON, tiptapJsonToMarkdown } from "@/lib/contentFormat";

// Rich text ↔ Markdown fidelity for adjacent lists and for formatting that only HTML can carry.
type Json = { type: string; attrs?: Record<string, unknown>; content?: Json[]; text?: string; marks?: Array<{ type: string }> };
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

describe("adjacent ordered lists", () => {
  for (const ids of [false, true]) {
    it(`keeps adjacent ordered lists and their start numbers apart${ids ? " (with IDs)" : ""}`, () => {
      const ol = (start: number, items: Array<[string, string]>): Json => ({ type: "orderedList", attrs: { start }, content: items.map(([value, blockId]) => (
        { type: "listItem", attrs: ids ? { blockId } : {}, content: [p(value)] })) });
      const { back } = roundTrip(doc(ol(1, [["one", "blk_olitem01"], ["two", "blk_olitem02"]]), ol(3, [["three", "blk_olitem03"]]), ol(1, [["again", "blk_olitem04"]])));
      expect(back.content!.map((node) => [node.type, node.attrs?.start, node.content!.map(plain)])).toEqual([
        ["orderedList", 1, ["one", "two"]], ["orderedList", 3, ["three"]], ["orderedList", 1, ["again"]],
      ]);
      if (ids) expect(find(back, "listItem").map((node) => node.attrs?.blockId)).toEqual(["blk_olitem01", "blk_olitem02", "blk_olitem03", "blk_olitem04"]);
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

  it("keeps inline marks of aligned paragraphs and headings without IDs", () => {
    const { md, back } = roundTrip(doc(
      p([text("Body "), text("strong", ["bold"])], { textAlign: "center" }),
      { type: "heading", attrs: { level: 2, textAlign: "right" }, content: [text("T "), text("it", ["italic"])] },
    ));
    // An HTML block's content is not Markdown: `**strong**` inside it would stay literal
    expect(md).not.toMatch(/\*/);
    expect(back.content!.map((node) => [node.type, node.attrs?.textAlign, plain(node)])).toEqual([["paragraph", "center", "Body strong"], ["heading", "right", "T it"]]);
    expect(find(back, "text").filter((node) => node.marks?.length).map((node) => [node.text, node.marks!.map((mark) => mark.type)])).toEqual([["strong", ["bold"]], ["it", ["italic"]]]);
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

  it("reads a marker that ends an HTML block's line as that block's ID when the HTML carries none", () => {
    const back = markdownToTiptapJSON('<p style="text-align: center;">Body</p> ^blk_center002\n\n<pre data-title="t"><code>x</code></pre> ^blk_code00003') as Json;
    expect(back.content!.map((node) => [node.type, node.attrs?.blockId, plain(node)])).toEqual([["paragraph", "blk_center002", "Body"], ["codeBlock", "blk_code00003", "x"]]);
    expect(JSON.stringify(back)).not.toContain("^blk_");
  });
});

describe("markers older saves wrote inside HTML code", () => {
  it("are dropped from the editor's titled code HTML, while fenced code keeps marker-like text", () => {
    const junk = "blk_11111111-2222-4333-8444-555555555555", own = "blk_99999999-2222-4333-8444-555555555555";
    const [code] = find(markdownToTiptapJSON(`<pre data-title="x"><code class="language-js">line1 ^${junk}\n\nline2</code></pre> ^${own}`) as Json, "codeBlock");
    expect([code.attrs?.blockId, code.attrs?.title, plain(code)]).toEqual([own, "x", "line1\n\nline2"]);
    const [fenced] = find(markdownToTiptapJSON(`\`\`\`\nline1 ^${junk}\n\`\`\``) as Json, "codeBlock");
    expect(plain(fenced)).toBe(`line1 ^${junk}`);
  });
});

describe("math block IDs", () => {
  const ofBlocks = (node: Json) => node.content!.map((child) => [child.type, child.attrs?.blockId, child.attrs?.latex ?? plain(child)]);

  it("writes a math block's ID on its own line after the closing $$ and reads it back", () => {
    const { md, back } = roundTrip(doc(p("before", { blockId: "blk_para0001" }), { type: "mathBlock", attrs: { latex: "a + b", blockId: "blk_math0001" } }, p("after", { blockId: "blk_para0002" })));
    // Like a code fence: a marker at the end of the closing line would stop it from closing the formula
    expect(md).toContain("$$\na + b\n$$\n^blk_math0001\n\n");
    expect(ofBlocks(back)).toEqual([["paragraph", "blk_para0001", "before"], ["mathBlock", "blk_math0001", "a + b"], ["paragraph", "blk_para0002", "after"]]);
  });

  it("reads a marker that older saves put at the end of the closing $$ without adding empty paragraphs", () => {
    expect(ofBlocks(markdownToTiptapJSON("$$\na + b\n$$ ^blk_math0001\n\nafter ^blk_para0002") as Json)).toEqual([
      ["mathBlock", "blk_math0001", "a + b"], ["paragraph", "blk_para0002", "after"],
    ]);
  });

  it("keeps the ID of a math block that ends a quote", () => {
    const { back } = roundTrip(doc({ type: "blockquote", attrs: { blockId: "blk_quote0002" }, content: [
      p("intro", { blockId: "blk_qintro01" }), { type: "mathBlock", attrs: { latex: "x", blockId: "blk_math0002" } },
    ] }));
    expect(ofBlocks(find(back, "blockquote")[0])).toEqual([["paragraph", "blk_qintro01", "intro"], ["mathBlock", "blk_math0002", "x"]]);
    expect(JSON.stringify(back)).not.toContain("^blk_");
  });
});
