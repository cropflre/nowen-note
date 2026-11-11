import { Editor } from "@tiptap/core";
import { history, redo, undo } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { getTiptapExtensions } from "@/lib/contentFormat";
import { encryptedBlockFence } from "@/lib/encryptedNotes/blockDocument";
import fixture from "@/lib/encryptedNotes/__tests__/fixtures/envelope-v1.json";
import { createMarkdownEditorActionAdapter } from "../markdownAdapter";
import { createTiptapEditorActionAdapter } from "../tiptapAdapter";
import type { EditorActionAdapter, EditorActionSnapshot } from "../types";

const encryptedFence = encryptedBlockFence(JSON.stringify({ ...fixture.envelope, kind: "block" }));
const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

/** One harness per editor so both adapters are held to the same behaviour. */
interface Harness {
  adapter: EditorActionAdapter;
  noteId: { current: string };
  text(): string;
  select(from: string, length?: number): void;
  caretAfter(text: string): void;
  insertAt(anchor: string, value: string): void;
  undo(): boolean;
  redo(): boolean;
  composing(value: boolean): void;
}

function markdownHarness(doc: string): Harness {
  const view = new EditorView({ state: EditorState.create({ doc, extensions: [history()] }), parent: document.body });
  cleanups.push(() => view.destroy());
  const noteId = { current: "note-1" };
  const index = (value: string) => { const at = view.state.doc.toString().indexOf(value); if (at < 0) throw new Error(`missing ${value}`); return at; };
  return {
    adapter: createMarkdownEditorActionAdapter(() => view, () => noteId.current),
    noteId,
    text: () => view.state.doc.toString(),
    select: (value, length = value.length) => { const at = index(value); view.dispatch({ selection: { anchor: at, head: at + length } }); },
    caretAfter: (value) => view.dispatch({ selection: { anchor: index(value) + value.length } }),
    insertAt: (anchor, value) => view.dispatch({ changes: { from: index(anchor), insert: value } }),
    undo: () => undo(view),
    redo: () => redo(view),
    composing: (value) => Object.defineProperty(view, "composing", { configurable: true, get: () => value }),
  };
}

function tiptapHarness(markdownish: Array<{ type: string; text?: string; attrs?: Record<string, unknown> }>): Harness {
  const editor = new Editor({ extensions: getTiptapExtensions(), content: { type: "doc", content: markdownish.map((node) => ({ type: node.type, ...(node.attrs ? { attrs: node.attrs } : {}), ...(node.text ? { content: [{ type: "text", text: node.text }] } : {}) })) } });
  cleanups.push(() => editor.destroy());
  const noteId = { current: "note-1" };
  const find = (value: string) => {
    let found = -1;
    editor.state.doc.descendants((node, pos) => { if (found < 0 && node.isText && node.text!.includes(value)) found = pos + node.text!.indexOf(value); });
    if (found < 0) throw new Error(`missing ${value}`);
    return found;
  };
  return {
    adapter: createTiptapEditorActionAdapter(editor, () => noteId.current),
    noteId,
    text: () => editor.state.doc.textBetween(0, editor.state.doc.content.size, "\n"),
    select: (value, length = value.length) => { const at = find(value); editor.commands.setTextSelection({ from: at, to: at + length }); },
    caretAfter: (value) => { const at = find(value) + value.length; editor.commands.setTextSelection(at); },
    insertAt: (anchor, value) => { editor.commands.insertContentAt(find(anchor), value); },
    undo: () => editor.commands.undo(),
    redo: () => editor.commands.redo(),
    composing: (value) => Object.defineProperty(editor.view, "composing", { configurable: true, get: () => value }),
  };
}

const editors: Array<[string, (text: string) => Harness]> = [
  ["markdown", (text) => markdownHarness(`Intro line\n\n${text}\n\nOutro line`)],
  ["tiptap", (text) => tiptapHarness([{ type: "paragraph", text: "Intro line" }, { type: "paragraph", text }, { type: "paragraph", text: "Outro line" }])],
];

function captured(harness: Harness): EditorActionSnapshot {
  const snapshot = harness.adapter.capture();
  if ("error" in snapshot) throw new Error(snapshot.error);
  cleanups.push(() => snapshot.release());
  return snapshot;
}

describe.each(editors)("%s editor action adapter", (_kind, create) => {
  it("captures trimmed selection Markdown and replaces it in one undoable step", () => {
    const harness = create("Hello world");
    harness.select(" world");
    const snapshot = captured(harness);
    expect([snapshot.text, snapshot.hasSelection, snapshot.noteId]).toEqual(["world", true, "note-1"]);
    expect(snapshot.apply("WORLD", "replace")).toBe("applied");
    expect(harness.text()).toContain("Hello WORLD");
    expect(harness.undo()).toBe(true);
    expect(harness.text()).toContain("Hello world");
    expect(harness.redo()).toBe(true);
    expect(harness.text()).toContain("Hello WORLD");
  });

  it("follows edits made elsewhere while the action runs", () => {
    const harness = create("Hello world");
    harness.select("world");
    const snapshot = captured(harness);
    harness.insertAt("Hello", "Hey ");
    harness.insertAt("Outro", "Note: ");
    expect(snapshot.apply("planet", "replace")).toBe("applied");
    expect(harness.text()).toContain("Hey Hello planet");
    expect(harness.text()).toContain("Note: Outro line");
  });

  it("refuses stale results when the selected text, the note or the snapshot changed", () => {
    const harness = create("Hello world");
    harness.select("world");
    const changed = captured(harness);
    harness.insertAt("rld", "X");
    expect(changed.apply("planet", "replace")).toBe("conflict");
    expect(harness.text()).toContain("Hello woXrld");

    harness.select("woXrld");
    const switched = captured(harness);
    harness.noteId.current = "note-2";
    expect(switched.apply("planet", "replace")).toBe("conflict");
    harness.noteId.current = "note-1";

    const released = captured(harness);
    released.release();
    expect(released.apply("planet", "replace")).toBe("conflict");
    expect(harness.text()).toContain("Hello woXrld");
  });

  it("keeps following edits for one snapshot after another one is released", () => {
    const harness = create("Hello world");
    harness.select("Hello");
    const first = captured(harness);
    harness.select("world");
    const second = captured(harness);
    first.release();
    harness.insertAt("Hello", "Oh ");
    expect(second.apply("planet", "replace")).toBe("applied");
    expect(harness.text()).toContain("Oh Hello planet");
  });

  it("inserts single-line results at the caret and block results after the current block", () => {
    const harness = create("Hello world");
    harness.caretAfter("Hello");
    const inline = captured(harness);
    expect(inline.hasSelection).toBe(false);
    expect(inline.apply(" there", "insert")).toBe("applied");
    expect(harness.text()).toContain("Hello there world");

    harness.caretAfter("Hello there");
    const block = captured(harness);
    expect(block.apply("## Agenda\n\n- first", "insert")).toBe("applied");
    const text = harness.text();
    expect(text).toContain("Hello there world");
    expect(text.indexOf("Agenda")).toBeGreaterThan(text.indexOf("Hello there world"));
    expect(text.indexOf("first")).toBeLessThan(text.indexOf("Outro line"));
    expect(harness.undo()).toBe(true);
    expect(harness.text()).not.toContain("Agenda");
  });

  it("drops an insertion point whose surrounding text was deleted", () => {
    const harness = create("Hello world");
    harness.caretAfter("Hello wo");
    const snapshot = captured(harness);
    harness.select("Hello world");
    const deleted = harness.adapter.capture();
    if ("error" in deleted) throw new Error(deleted.error);
    expect(deleted.apply("", "replace")).toBe("applied");
    deleted.release();
    expect(snapshot.apply("X", "insert")).toBe("conflict");
  });

  it("reports IME composition and refuses oversized selections", () => {
    const harness = create("x".repeat(40 * 1024));
    harness.composing(true);
    expect(harness.adapter.isComposing()).toBe(true);
    harness.composing(false);
    harness.select("x".repeat(40 * 1024));
    expect(harness.adapter.capture()).toEqual({ error: "TOO_LARGE" });
  });
});

describe("encrypted regions are never sent or overwritten", () => {
  it("markdown refuses selections and insertion points inside an encrypted block", () => {
    const harness = markdownHarness(`Before\n\n${encryptedFence}\n\nAfter`);
    harness.select("Before\n\n```");
    expect(harness.adapter.capture()).toEqual({ error: "ENCRYPTED_REGION" });
    harness.caretAfter("```nowen-encrypted-v1\n");
    expect(harness.adapter.capture()).toEqual({ error: "ENCRYPTED_REGION" });
    harness.select("After");
    expect("error" in harness.adapter.capture()).toBe(false);
  });

  it("tiptap refuses selections that include an encrypted code block", () => {
    const editor = new Editor({ extensions: getTiptapExtensions(), content: { type: "doc", content: [
      { type: "paragraph", content: [{ type: "text", text: "Before" }] },
      { type: "codeBlock", attrs: { language: "nowen-encrypted-v1" }, content: [{ type: "text", text: "{}" }] },
      { type: "paragraph", content: [{ type: "text", text: "After" }] },
    ] } });
    cleanups.push(() => editor.destroy());
    const adapter = createTiptapEditorActionAdapter(editor, () => "note-1");
    editor.commands.setTextSelection({ from: 1, to: editor.state.doc.content.size - 1 });
    expect(adapter.capture()).toEqual({ error: "ENCRYPTED_REGION" });
    editor.commands.setTextSelection({ from: 10, to: 10 });
    expect(adapter.capture()).toEqual({ error: "ENCRYPTED_REGION" });
  });

  it("tiptap inserts plain text inside ordinary code blocks instead of parsing Markdown", () => {
    const editor = new Editor({ extensions: getTiptapExtensions(), content: { type: "doc", content: [
      { type: "codeBlock", attrs: { language: "js" }, content: [{ type: "text", text: "const a = 1;" }] },
    ] } });
    cleanups.push(() => editor.destroy());
    const adapter = createTiptapEditorActionAdapter(editor, () => "note-1");
    editor.commands.setTextSelection({ from: 7, to: 8 });
    const snapshot = adapter.capture();
    if ("error" in snapshot) throw new Error(snapshot.error);
    expect(snapshot.apply("# not a heading", "replace")).toBe("applied");
    snapshot.release();
    expect(editor.getJSON().content?.[0]).toMatchObject({ type: "codeBlock", content: [{ text: "const # not a heading = 1;" }] });
  });
});
