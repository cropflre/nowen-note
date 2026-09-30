import { describe, expect, it, vi } from "vitest";
import { Schema } from "@tiptap/pm/model";
import { EditorState, type Transaction } from "@tiptap/pm/state";
import { history, undo } from "@tiptap/pm/history";
import type { Editor } from "@tiptap/react";
import { canFormatCodeBlock, formatCodeBlock } from "@/lib/codeBlockFormatting";
import { formatTiptapCodeBlock } from "@/lib/tiptapCodeBlockFormatting";

describe("local code formatting", () => {
  it("formats JSON without losing large numbers, precision or duplicate fields", async () => {
    const source = '{"id":900719925474099312345,"amount":1.234567890123456789,"same":1,"same":2}';
    const result = await formatCodeBlock(source, "json");
    expect(result).toBe('{\n  "id": 900719925474099312345,\n  "amount": 1.234567890123456789,\n  "same": 1,\n  "same": 2\n}');
    expect(await formatCodeBlock(result, "json")).toBe(result);
  });

  it.each(["auto", "", "plaintext", "text"])("recognizes unlabelled JSON (%s)", async (language) => {
    const formatted = await formatCodeBlock('{"a":[1,2]}', language);
    expect(JSON.parse(formatted)).toEqual({ a: [1, 2] });
    expect(formatted).toContain("\n");
    await expect(formatCodeBlock("const x=1", language)).rejects.toMatchObject({ reason: "invalid" });
  });

  it.each([
    ["js", "const x={a:1};", "const x = { a: 1 };"],
    ["jsx", "const x=<div>hello</div>", "const x = <div>hello</div>;"],
    ["ts", "const x:number=1", "const x: number = 1;"],
    ["tsx", "const x:JSX.Element=<div/>", "const x: JSX.Element = <div />;"],
    ["html", "<div><span>x</span></div>", "<div><span>x</span></div>"],
    ["css", "a{color:red}", "a {\n  color: red;\n}"],
    ["scss", "$c:red;a{color:$c}", "$c: red;\na {\n  color: $c;\n}"],
    ["less", "@c:red;a{color:@c}", "@c: red;\na {\n  color: @c;\n}"],
    ["yml", "a: [1,2]", "a: [1, 2]"],
  ])("formats %s with its own parser", async (language, source, expected) => {
    expect(await formatCodeBlock(source, language)).toBe(expected);
  });

  it.each([
    ["jsonc", '{\n// comment\n"a":1\n}', '"a": 1'],
    ["json5", "{a:1,}", "a: 1"],
    ["graphql", "type Query{hello:String}", "hello: String"],
    ["markdown", "# Title\n\n* item", "# Title"],
    ["mdx", "# Title\n\n<Component a={1}/>", "<Component"],
    ["vue", "<template><div>hello</div></template>", "<template>"],
    ["angular", '<div *ngIf="ok">hello</div>', "*ngIf"],
    ["flow", "const x:number=1", "const x: number = 1;"],
    ["handlebars", "<div>{{foo}}</div>", "{{foo}}"],
    ["lwc", "<template><div>{value}</div></template>", "<template>"],
    ["mjml", "<mjml><mj-body><mj-section></mj-section></mj-body></mjml>", "<mjml>"],
  ])("formats newly supported %s syntax", async (language, source, marker) => {
    const formatted = await formatCodeBlock(source, language);
    expect(formatted).toContain(marker);
    expect(formatted.length).toBeGreaterThan(0);
  });

  it.each(["gql", "hbs", "mjs", "cjs", "mts", "cts"])("supports formatter aliases (%s)", (language) => {
    expect(canFormatCodeBlock(language)).toBe(true);
  });

  it("rejects invalid JSON and unsupported languages without including code in errors", async () => {
    await expect(formatCodeBlock('{"secret":}', "json")).rejects.toMatchObject({ message: "invalid" });
    expect(canFormatCodeBlock("python")).toBe(false);
    await expect(formatCodeBlock("print(1)", "python")).rejects.toMatchObject({ reason: "unsupported" });
    expect(await formatCodeBlock("  ", "json")).toBe("  ");
  });
});

function makeEditor(code = '{"a":1}') {
  const schema = new Schema({ nodes: {
    doc: { content: "block+" }, paragraph: { content: "text*", group: "block" },
    codeBlock: { content: "text*", group: "block", code: true, attrs: {
      language: { default: "json" }, blockId: { default: "id-1" }, indent: { default: 2 },
    } }, text: { group: "inline" },
  } });
  let state = EditorState.create({ schema, plugins: [history()], doc: schema.nodes.doc.create(null, [
    schema.nodes.codeBlock.create(null, schema.text(code)), schema.nodes.paragraph.create(null, schema.text("after")),
  ]) });
  const dispatch = vi.fn((tr: Transaction) => { state = state.apply(tr); });
  const editor = { isEditable: true, isDestroyed: false, view: {
    get state() { return state; }, dispatch, focus: vi.fn(),
  } } as unknown as Editor;
  return { editor, dispatch, getState: () => state };
}

describe("rich-text format transaction", () => {
  it("preserves block identity, indentation and surrounding text; undo restores only formatting", async () => {
    const { editor, getState, dispatch } = makeEditor();
    dispatch(getState().tr.insertText(" ", 2));
    const before = getState().doc;
    await formatTiptapCodeBlock(editor, () => 0);
    expect(getState().doc.firstChild?.attrs).toEqual(before.firstChild?.attrs);
    expect(getState().doc.child(1).textContent).toBe("after");
    expect(getState().doc.firstChild?.textContent).toBe('{\n  "a": 1\n}');
    expect(undo(getState(), dispatch)).toBe(true);
    expect(getState().doc.eq(before)).toBe(true);
  });

  it("does not create history for already formatted or invalid code", async () => {
    const ready = makeEditor('{\n  "a": 1\n}');
    await formatTiptapCodeBlock(ready.editor, () => 0);
    expect(ready.dispatch).not.toHaveBeenCalled();
    const invalid = makeEditor('{"a":}');
    await expect(formatTiptapCodeBlock(invalid.editor, () => 0)).rejects.toMatchObject({ reason: "invalid" });
    expect(invalid.dispatch).not.toHaveBeenCalled();
  });

  it("refuses stale, removed and locked blocks after asynchronous parsing", async () => {
    const changed = makeEditor();
    const pending = formatTiptapCodeBlock(changed.editor, () => 0);
    changed.dispatch(changed.getState().tr.insertText(" ", 2));
    await expect(pending).rejects.toMatchObject({ reason: "changed" });
    expect(changed.dispatch).toHaveBeenCalledTimes(1);
    const removed = makeEditor();
    const getPos = vi.fn().mockReturnValueOnce(0).mockImplementationOnce(() => { throw new Error("removed"); });
    await expect(formatTiptapCodeBlock(removed.editor, getPos)).rejects.toMatchObject({ reason: "changed" });
    const locked = makeEditor();
    const locking = formatTiptapCodeBlock(locked.editor, () => 0);
    Object.assign(locked.editor, { isEditable: false });
    await expect(locking).rejects.toMatchObject({ reason: "readOnly" });
    expect(locked.dispatch).not.toHaveBeenCalled();
  });

  it("checks permission before reading the document", async () => {
    const editor = { isEditable: false, get view() { throw new Error("must not read"); } } as unknown as Editor;
    await expect(formatTiptapCodeBlock(editor, () => 0)).rejects.toMatchObject({ reason: "readOnly" });
  });
});
