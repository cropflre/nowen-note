import { expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history, undo, redo } from "@codemirror/commands";
import { agentTextRanges, sameAgentSnapshot } from "@/lib/agentEdits";
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
