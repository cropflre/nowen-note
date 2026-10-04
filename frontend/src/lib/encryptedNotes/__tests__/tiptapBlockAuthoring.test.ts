import { expect, it } from "vitest";
import type { Editor } from "@tiptap/core";
import { Schema } from "@tiptap/pm/model";
import { EditorState, TextSelection, type Transaction } from "@tiptap/pm/state";
import { history, undo } from "@tiptap/pm/history";
import fixture from "./fixtures/envelope-v1.json";
import { prepareTiptapSelectionEncryption } from "../tiptapBlockAuthoring";

const source = JSON.stringify({ ...fixture.envelope, kind: "block", originalFormat: "tiptap-json" });
function makeEditor(type = "paragraph", mark = "bold") {
  const schema = new Schema({ nodes: {
    doc: { content: "block+" }, paragraph: { content: "inline*", group: "block" },
    codeBlock: { content: "text*", group: "block", code: true, attrs: { language: { default: null } } }, text: { group: "inline" },
  }, marks: { bold: {}, link: {} } });
  const doc = schema.nodes.doc.create(null, [schema.nodes[type].create(null, [schema.text("Public "), schema.text("private", [schema.marks[mark].create()]), schema.text(" after")])]);
  let state = EditorState.create({ doc, schema, plugins: [history()], selection: TextSelection.create(doc, 8, 15) });
  const dispatch = (transaction: Transaction) => { state = state.apply(transaction); };
  const editor = { isEditable: true, isDestroyed: false, schema, get state() { return state; }, view: {
    dispatch, updateState(next: EditorState) { state = next; },
  } } as unknown as Editor;
  return { editor, dispatch, getState: () => state };
}
it("keeps selected rich-text marks and public neighbours, then removes plaintext from undo", () => {
  const { editor, dispatch, getState } = makeEditor();
  dispatch(getState().tr.insertText("!", getState().doc.content.size - 1));
  const selected = prepareTiptapSelectionEncryption(editor);
  expect(JSON.parse(selected.plaintext)).toMatchObject({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "private", marks: [{ type: "bold" }] }] }] });
  selected.commit(source);
  expect(getState().doc.toJSON()).toMatchObject({ content: [{ type: "paragraph" }, { type: "codeBlock", attrs: { language: "nowen-encrypted-v1" } }, { type: "paragraph" }] });
  expect(getState().doc.textContent).toContain("Public "); expect(getState().doc.textContent).toContain(" after!"); expect(getState().doc.textContent).not.toContain("private");
  expect(undo(getState(), dispatch)).toBe(false);
  dispatch(getState().tr.insertText("public edit", 1));
  expect(undo(getState(), dispatch)).toBe(true); expect(getState().doc.textContent).not.toContain("private");
});
it("refuses code blocks, unsupported marks, stale documents and revoked write access", () => {
  expect(() => prepareTiptapSelectionEncryption(makeEditor("codeBlock").editor)).toThrow();
  expect(() => prepareTiptapSelectionEncryption(makeEditor("paragraph", "link").editor)).toThrow();
  const changed = makeEditor(); const selected = prepareTiptapSelectionEncryption(changed.editor);
  changed.dispatch(changed.getState().tr.insertText("newer", 1));
  expect(() => selected.commit(source)).toThrow(); expect(changed.getState().doc.textContent).toContain("private");
  const readonly = makeEditor(); const pending = prepareTiptapSelectionEncryption(readonly.editor);
  Object.defineProperty(readonly.editor, "isEditable", { value: false });
  expect(() => pending.commit(source)).toThrow(); expect(readonly.getState().doc.textContent).toContain("private");
});
