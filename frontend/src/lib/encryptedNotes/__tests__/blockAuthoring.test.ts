import { expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history, undo, redo } from "@codemirror/commands";
import fixture from "./fixtures/envelope-v1.json";
import { commitMarkdownEncryptedRegion } from "../blockAuthoring";
import { encryptedBlockFence } from "../blockDocument";
const source = JSON.stringify({ ...fixture.envelope, kind: "block" });
it("CodeMirror undo/redo retains only complete ciphertext and public surrounding text", () => {
  const view = new EditorView({ state: EditorState.create({ doc: "public before\n\npublic after", extensions: [history()] }) });
  try {
    const snapshot = view.state.doc;
    commitMarkdownEncryptedRegion(view, snapshot, { from: 14, to: 14 }, source);
    const saved = view.state.doc.toString();
    expect(saved).toContain(encryptedBlockFence(source)); expect(saved).not.toContain(fixture.plaintext);
    expect(undo(view)).toBe(true); expect(view.state.doc.toString()).toBe(snapshot.toString());
    expect(redo(view)).toBe(true); expect(view.state.doc.toString()).toBe(saved);
    expect(view.state.doc.toString()).not.toContain(fixture.passphrase);
  } finally { view.destroy(); }
});
it("a changed or read-only CodeMirror document cannot receive a pending encrypted write", () => {
  for (const editable of [true, false]) {
    const view = new EditorView({ state: EditorState.create({ doc: "public", extensions: [EditorView.editable.of(editable)] }) });
    try {
      const snapshot = view.state.doc;
      if (editable) view.dispatch({ changes: { from: 0, insert: "changed " } });
      const before = view.state.doc.toString();
      expect(() => commitMarkdownEncryptedRegion(view, snapshot, { from: 0, to: 0 }, source)).toThrow();
      expect(view.state.doc.toString()).toBe(before);
    } finally { view.destroy(); }
  }
});
