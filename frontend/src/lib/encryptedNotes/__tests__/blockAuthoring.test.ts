import { expect, it } from "vitest";
import { Compartment, EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history, undo, redo } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import fixture from "./fixtures/envelope-v1.json";
import { commitMarkdownEncryptedRegion, prepareMarkdownEncryptedRegionEdit, prepareMarkdownSelectionEncryption } from "../blockAuthoring";
import { encryptedBlockFence, markdownEncryptedBlocks } from "../blockDocument";
const source = JSON.stringify({ ...fixture.envelope, kind: "block" });
it("encrypts the exact Markdown selection, keeps public text and clears plaintext undo history", () => {
  const compartment = new Compartment();
  const view = new EditorView({ parent: document.body, state: EditorState.create({ doc: "before private after", selection: { anchor: 7, head: 14 }, extensions: [compartment.of(history()), markdown()] }) });
  try {
    view.dispatch({ changes: { from: view.state.doc.length, insert: "!" } });
    const selected = prepareMarkdownSelectionEncryption(view, compartment);
    expect(selected.plaintext).toBe("private"); selected.commit(source);
    expect(view.state.doc.toString()).toBe(`before \n\n${encryptedBlockFence(source)}\n\n after!`);
    expect(undo(view)).toBe(false); expect(redo(view)).toBe(false);
    view.dispatch({ changes: { from: view.state.doc.length, insert: "public edit" } });
    expect(undo(view)).toBe(true); expect(view.state.doc.toString()).not.toContain("private");
  } finally { view.destroy(); }
});
it.each(["```js\nprivate\n```", "![private](image.png)", "[private](https://example.com)", encryptedBlockFence(source)])("rejects non-text or protected Markdown selections", (doc) => {
  const compartment = new Compartment();
  const from = doc.indexOf("private") < 0 ? 2 : doc.indexOf("private");
  const view = new EditorView({ parent: document.body, state: EditorState.create({ doc, selection: { anchor: from, head: from + 2 }, extensions: [compartment.of(history()), markdown()] }) });
  try { expect(() => prepareMarkdownSelectionEncryption(view, compartment)).toThrow(); expect(view.state.doc.toString()).toBe(doc); }
  finally { view.destroy(); }
});
it("rejects multiple Markdown selections and a changed document after password entry", () => {
  const compartment = new Compartment();
  const view = new EditorView({ parent: document.body, state: EditorState.create({ doc: "private public", selection: { anchor: 0, head: 7 }, extensions: [compartment.of(history()), EditorState.allowMultipleSelections.of(true)] }) });
  try {
    const selected = prepareMarkdownSelectionEncryption(view, compartment);
    view.dispatch({ changes: { from: view.state.doc.length, insert: "newer" } });
    expect(() => selected.commit(source)).toThrow(); expect(view.state.doc.toString()).toBe("private publicnewer");
    view.dispatch({ selection: EditorSelection.create([EditorSelection.range(0, 3), EditorSelection.range(8, 10)]) });
    expect(() => prepareMarkdownSelectionEncryption(view, compartment)).toThrow();
  } finally { view.destroy(); }
});
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

it("edits the second identical preview fence despite transformed offsets, preserving its quoted prefix and ciphertext-only undo", () => {
  const fence = encryptedBlockFence(source, "> ");
  const markdown = `public $x$\n\n${fence}\n\n${fence}`;
  const rendered = markdown.replace("$x$", '<span data-nowen-math-source="x">x</span>');
  const view = new EditorView({ parent: document.body, state: EditorState.create({ doc: markdown, extensions: [history()] }) });
  const next = JSON.stringify({ ...fixture.envelope, kind: "block", objectId: "10112233-4455-4677-8899-aabbccddeeff" });
  try {
    const region = prepareMarkdownEncryptedRegionEdit(view, markdown, rendered, markdownEncryptedBlocks(rendered)[1].from);
    expect(region.source).toBe(source); region.commit(next);
    expect(view.state.doc.toString()).toBe(`public $x$\n\n${fence}\n\n${encryptedBlockFence(next, "> ")}`);
    expect(undo(view)).toBe(true); expect(view.state.doc.toString()).toBe(markdown);
    expect(redo(view)).toBe(true); expect(view.state.doc.toString()).not.toContain(fixture.plaintext);
  } finally { view.destroy(); }
});

it("refuses stale previews, unsupported card mappings, changed documents and revoked write access", () => {
  const markdown = encryptedBlockFence(source);
  const view = new EditorView({ parent: document.body, state: EditorState.create({ doc: markdown }) });
  try {
    expect(() => prepareMarkdownEncryptedRegionEdit(view, `stale\n${markdown}`, markdown, 0)).toThrow();
    expect(() => prepareMarkdownEncryptedRegionEdit(view, markdown, `${markdown}\n\n${markdown}`, 0)).toThrow();
    const region = prepareMarkdownEncryptedRegionEdit(view, markdown, markdown, 0);
    view.dispatch({ changes: { from: 0, insert: "changed\n" } });
    const changed = view.state.doc.toString(); expect(() => region.commit(source)).toThrow();
    expect(view.state.doc.toString()).toBe(changed);
    view.setState(EditorState.create({ doc: markdown, extensions: [EditorState.readOnly.of(true)] }));
    expect(() => prepareMarkdownEncryptedRegionEdit(view, markdown, markdown, 0)).toThrow();
    view.setState(EditorState.create({ doc: markdown }));
    const pending = prepareMarkdownEncryptedRegionEdit(view, markdown, markdown, 0);
    view.setState(EditorState.create({ doc: markdown, extensions: [EditorView.editable.of(false)] }));
    expect(() => pending.commit(source)).toThrow(); expect(view.state.doc.toString()).toBe(markdown);
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
