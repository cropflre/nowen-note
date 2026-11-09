import { Editor } from "@tiptap/core";
import { getTiptapExtensions } from "@/lib/contentFormat";
import { createAiProvenance, prependAiDeclaration, readAiProvenance } from "@/lib/aiContentProvenance";
import { expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history, undo, redo } from "@codemirror/commands";
import { applyAgentTiptapChanges, agentMarkdownChanges, agentTextRanges, sameAgentSnapshot } from "@/lib/agentEdits";
it("applies precise Markdown edits as one undoable change while preserving links", () => {
  const original = "First original\nSecond original\n![image](attachment:123)";
  const view = new EditorView({ state: EditorState.create({ doc: original, extensions: [history()] }), parent: document.body });
  try {
    const changes = agentTextRanges([{ text: original, pos: 0 }], [{ before: "First original", after: "First improved" }, { before: "Second original", after: "Second improved" }]);
    view.dispatch({ changes }); expect(view.state.doc.toString()).toContain("![image](attachment:123)");
    expect(undo(view)).toBe(true); expect(view.state.doc.toString()).toBe(original);
    expect(redo(view)).toBe(true); expect(view.state.doc.toString()).toContain("Second improved");
  } finally { view.destroy(); }
});
it("rejects overlapping, missing and ambiguous ranges before writing", () => {
  for (const edits of [[{ before: "same", after: "x" }], [{ before: "missing", after: "x" }], [{ before: "", after: "x" }], [{ before: "same same", after: "x" }, { before: "same same", after: "y" }]]) expect(() => agentTextRanges([{ text: "same same", pos: 0 }], edits)).toThrow();
});
it("rich text offsets remain inside one node and snapshot checks detect concurrent changes", () => {
  expect(agentTextRanges([{ text: "bold", pos: 1 }, { text: "link", pos: 7 }], [{ before: "link", after: "linked" }])).toEqual([{ from: 7, to: 11, insert: "linked", part: 1 }]);
  expect(() => agentTextRanges([{ text: "bold", pos: 1 }, { text: "link", pos: 7 }], [{ before: "boldlink", after: "merged" }])).toThrow();
  expect(sameAgentSnapshot('{"type":"doc"}', '{ "type": "doc" }', "tiptap-json")).toBe(true);
  expect(sameAgentSnapshot("original", "new typing", "markdown")).toBe(false);
});
it("inserts an approved draft into one empty text target and rejects mixed or empty drafts", () => {
  expect(agentTextRanges([{ text: "", pos: 0 }], [{ before: "", after: "Draft" }])).toEqual([{ from: 0, to: 0, insert: "Draft", part: 0 }]);
  expect(agentTextRanges([{ text: "", pos: 1 }], [{ before: "", after: "Draft" }])[0].from).toBe(1);
  for (const edits of [[{ before: "", after: "" }], [{ before: "", after: "Draft" }, { before: "", after: "Another" }]]) {
    expect(() => agentTextRanges([{ text: "", pos: 0 }], edits)).toThrow();
  }
});

it.each(["", "original\n![file](attachment:keep)"])("keeps the AI declaration and edits in one undo step: %s", original => {
  const view = new EditorView({ state: EditorState.create({ doc: original, extensions: [history()] }), parent: document.body });
  try {
    const edits = [{ before: original ? "original" : "", after: "generated" }];
    const provenance = createAiProvenance("approved-run");
    view.dispatch({ changes: agentMarkdownChanges(original, edits, provenance) });
    const expected = prependAiDeclaration(original.replace("original", "generated") || "generated", "markdown", provenance);
    expect(view.state.doc.toString()).toBe(expected);
    expect(readAiProvenance(view.state.doc.toString())).toEqual(provenance);
    expect(undo(view)).toBe(true); expect(view.state.doc.toString()).toBe(original);
    expect(redo(view)).toBe(true); expect(view.state.doc.toString()).toBe(expected);
  } finally { view.destroy(); }
});

it("applies rich-text edits and provenance in one undo step without replacing attachments or block IDs", () => {
  const editor = new Editor({ extensions: getTiptapExtensions(), content: { type: "doc", content: [
    { type: "paragraph", attrs: { blockId: "keep-block" }, content: [{ type: "text", text: "Original text", marks: [{ type: "bold" }] }] },
    { type: "image", attrs: { src: "attachment:keep" } },
    { type: "paragraph" },
  ] } });
  try {
    const original = editor.getJSON();
    const provenance = createAiProvenance("rich-approved-run");
    applyAgentTiptapChanges(editor, [{ before: "Original", after: "Improved" }], provenance);
    const changed = editor.getJSON();
    expect(readAiProvenance(JSON.stringify(changed))).toEqual(provenance);
    expect(changed.content?.[1]).toEqual({ ...original.content![0], content: [{ type: "text", text: "Improved text", marks: [{ type: "bold" }] }] });
    expect(changed.content?.[2]).toEqual(original.content![1]);
    expect(editor.commands.undo()).toBe(true); expect(editor.getJSON()).toEqual(original);
    expect(editor.commands.redo()).toBe(true); expect(editor.getJSON()).toEqual(changed);
  } finally { editor.destroy(); }
});
