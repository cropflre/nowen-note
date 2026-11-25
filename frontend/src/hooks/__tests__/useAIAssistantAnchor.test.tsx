import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Editor } from "@tiptap/core";
import { history } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getTiptapExtensions } from "@/lib/contentFormat";
import { encryptedBlockFence } from "@/lib/encryptedNotes/blockDocument";
import fixture from "@/lib/encryptedNotes/__tests__/fixtures/envelope-v1.json";
import { createMarkdownEditorActionAdapter } from "@/lib/editorActions/markdownAdapter";
import { createTiptapEditorActionAdapter } from "@/lib/editorActions/tiptapAdapter";
import type { EditorActionAdapter } from "@/lib/editorActions/types";
import { captureAIAssistantAnchor, useAIAssistantAnchor } from "../useAIAssistantAnchor";

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

/** One harness per editor, so the assistant is held to the same behaviour in both. */
interface Harness {
  noteId: { current: string };
  adapter: EditorActionAdapter;
  createAdapter(getNoteId: () => string): EditorActionAdapter;
  text(): string;
  select(value: string, length?: number): void;
  caretAfter(value: string): void;
  insertAt(anchor: string, value: string): void;
  /** What the editors do with the range the anchor hands back. */
  write(from: number, to: number, value: string): void;
}

function markdownHarness(doc: string): Harness {
  const view = new EditorView({ state: EditorState.create({ doc, extensions: [history()] }), parent: document.body });
  cleanups.push(() => view.destroy());
  const noteId = { current: "note-1" };
  const index = (value: string) => { const at = view.state.doc.toString().indexOf(value); if (at < 0) throw new Error(`missing ${value}`); return at; };
  const createAdapter = (getNoteId: () => string) => createMarkdownEditorActionAdapter(() => view, getNoteId);
  return {
    noteId,
    adapter: createAdapter(() => noteId.current),
    createAdapter,
    text: () => view.state.doc.toString(),
    select: (value, length = value.length) => { const at = index(value); view.dispatch({ selection: { anchor: at, head: at + length } }); },
    caretAfter: (value) => view.dispatch({ selection: { anchor: index(value) + value.length } }),
    insertAt: (anchor, value) => view.dispatch({ changes: { from: index(anchor), insert: value } }),
    write: (from, to, value) => view.dispatch({ changes: { from, to, insert: value } }),
  };
}

function tiptapHarness(paragraphs: string[]): Harness {
  const editor = new Editor({ extensions: getTiptapExtensions(), content: { type: "doc", content: paragraphs.map((text) => ({ type: "paragraph", content: [{ type: "text", text }] })) } });
  cleanups.push(() => editor.destroy());
  const noteId = { current: "note-1" };
  const find = (value: string) => {
    let found = -1;
    editor.state.doc.descendants((node, pos) => { if (found < 0 && node.isText && node.text!.includes(value)) found = pos + node.text!.indexOf(value); });
    if (found < 0) throw new Error(`missing ${value}`);
    return found;
  };
  const createAdapter = (getNoteId: () => string) => createTiptapEditorActionAdapter(editor, getNoteId);
  return {
    noteId,
    adapter: createAdapter(() => noteId.current),
    createAdapter,
    text: () => editor.state.doc.textBetween(0, editor.state.doc.content.size, "\n"),
    select: (value, length = value.length) => { const at = find(value); editor.commands.setTextSelection({ from: at, to: at + length }); },
    caretAfter: (value) => { editor.commands.setTextSelection(find(value) + value.length); },
    insertAt: (anchor, value) => { editor.commands.insertContentAt(find(anchor), value); },
    write: (from, to, value) => { editor.view.dispatch(editor.state.tr.insertText(value, from, to)); },
  };
}

const editors: Array<[string, (text: string) => Harness]> = [
  ["markdown", (text) => markdownHarness(`Intro line\n\n${text}\n\nOutro line`)],
  ["tiptap", (text) => tiptapHarness(["Intro line", text, "Outro line"])],
];

describe.each(editors)("AI assistant anchor in the %s editor", (_kind, create) => {
  it("replaces the text it was opened on, even after the selection moved elsewhere", () => {
    const harness = create("Hello world");
    harness.select("world");
    const anchor = captureAIAssistantAnchor(harness.adapter);
    cleanups.push(() => anchor.release());

    // The user clicks somewhere else while the model is still answering.
    harness.caretAfter("Outro");
    expect(anchor.apply("replace", ({ from, to }) => harness.write(from, to, "planet"))).toBe("applied");
    expect(harness.text()).toContain("Hello planet");
    expect(harness.text()).toContain("Outro line");
  });

  it("follows edits made elsewhere while the model was answering", () => {
    const harness = create("Hello world");
    harness.select("world");
    const anchor = captureAIAssistantAnchor(harness.adapter);
    cleanups.push(() => anchor.release());

    harness.insertAt("Hello", "Hey ");
    harness.insertAt("Outro", "Note: ");
    expect(anchor.apply("replace", ({ from, to }) => harness.write(from, to, "planet"))).toBe("applied");
    expect(harness.text()).toContain("Hey Hello planet");
    expect(harness.text()).toContain("Note: Outro line");
  });

  it("refuses to replace when the selected text was edited, and writes nothing", () => {
    const harness = create("Hello world");
    harness.select("world");
    const anchor = captureAIAssistantAnchor(harness.adapter);
    cleanups.push(() => anchor.release());

    harness.insertAt("rld", "X");
    const before = harness.text();
    const write = vi.fn();
    expect(anchor.apply("replace", write)).toBe("conflict");
    expect(write).not.toHaveBeenCalled();
    expect(harness.text()).toBe(before);
  });

  it("refuses both ways when the note was switched, and writes nothing", () => {
    const harness = create("Hello world");
    harness.select("world");
    const anchor = captureAIAssistantAnchor(harness.adapter);
    cleanups.push(() => anchor.release());

    harness.noteId.current = "note-2";
    const before = harness.text();
    const write = vi.fn();
    expect([anchor.apply("replace", write), anchor.apply("insert", write)]).toEqual(["conflict", "conflict"]);
    expect(write).not.toHaveBeenCalled();
    expect(harness.text()).toBe(before);
  });

  it("inserts after the original selection, not at the current caret", () => {
    const harness = create("Hello world");
    harness.select("Hello");
    const anchor = captureAIAssistantAnchor(harness.adapter);
    cleanups.push(() => anchor.release());

    harness.caretAfter("Outro");
    expect(anchor.apply("insert", ({ to }) => harness.write(to, to, " there"))).toBe("applied");
    expect(harness.text()).toContain("Hello there world");
    expect(harness.text()).toContain("Outro line");
  });

  it("never writes through a released anchor", () => {
    const harness = create("Hello world");
    harness.select("world");
    const anchor = captureAIAssistantAnchor(harness.adapter);
    anchor.release();
    const write = vi.fn();
    expect([anchor.apply("replace", write), anchor.apply("insert", write)]).toEqual(["conflict", "conflict"]);
    expect(write).not.toHaveBeenCalled();
  });

  it("explains a selection that is too large to anchor, and writes nothing", () => {
    const harness = create("x".repeat(40 * 1024));
    harness.select("x".repeat(40 * 1024));
    const anchor = captureAIAssistantAnchor(harness.adapter);
    const write = vi.fn();
    expect([anchor.apply("replace", write), anchor.apply("insert", write)]).toEqual(["tooLarge", "tooLarge"]);
    expect(write).not.toHaveBeenCalled();
  });
});

describe("AI assistant anchor and encrypted regions", () => {
  const encryptedFence = encryptedBlockFence(JSON.stringify({ ...fixture.envelope, kind: "block" }));

  it("markdown refuses a selection that reaches into an encrypted block", () => {
    const harness = markdownHarness(`Before\n\n${encryptedFence}\n\nAfter`);
    harness.select("Before\n\n```");
    const anchor = captureAIAssistantAnchor(harness.adapter);
    const write = vi.fn();
    expect(anchor.apply("replace", write)).toBe("encrypted");
    expect(write).not.toHaveBeenCalled();
  });

  it("tiptap refuses a selection that includes an encrypted code block", () => {
    const editor = new Editor({ extensions: getTiptapExtensions(), content: { type: "doc", content: [
      { type: "paragraph", content: [{ type: "text", text: "Before" }] },
      { type: "codeBlock", attrs: { language: "nowen-encrypted-v1" }, content: [{ type: "text", text: "{}" }] },
      { type: "paragraph", content: [{ type: "text", text: "After" }] },
    ] } });
    cleanups.push(() => editor.destroy());
    editor.commands.setTextSelection({ from: 1, to: editor.state.doc.content.size - 1 });
    const anchor = captureAIAssistantAnchor(createTiptapEditorActionAdapter(editor, () => "note-1"));
    const write = vi.fn();
    expect(anchor.apply("replace", write)).toBe("encrypted");
    expect(write).not.toHaveBeenCalled();
  });
});

describe("useAIAssistantAnchor lifecycle", () => {
  type Api = ReturnType<typeof useAIAssistantAnchor>;
  let root: Root, host: HTMLDivElement;

  function mount() {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    const api: { current: Api | null } = { current: null };
    function Probe({ open, noteId }: { open: boolean; noteId: string }) { api.current = useAIAssistantAnchor(open, noteId); return null; }
    const render = async (props: { open: boolean; noteId: string }) => { await act(async () => root.render(<Probe {...props} />)); };
    cleanups.push(() => { act(() => root.unmount()); host.remove(); });
    return { api, render };
  }

  it("writes nothing before the assistant has captured a selection", async () => {
    const { api, render } = mount();
    await render({ open: false, noteId: "note-1" });
    const write = vi.fn();
    expect(api.current!.apply("replace", write)).toBe("conflict");
    expect(write).not.toHaveBeenCalled();
  });

  it("keeps the anchor while open, follows the note id, and releases it when the assistant closes", async () => {
    const { api, render } = mount();
    const harness = markdownHarness("Hello world");
    harness.select("world");
    await render({ open: false, noteId: "note-1" });
    // The editors capture first and open the panel right after.
    api.current!.capture((getNoteId) => harness.createAdapter(getNoteId));
    await render({ open: true, noteId: "note-1" });

    await render({ open: true, noteId: "note-2" });
    const write = vi.fn();
    expect(api.current!.apply("replace", write)).toBe("conflict");
    await render({ open: true, noteId: "note-1" });
    expect(api.current!.apply("replace", ({ from, to }) => harness.write(from, to, "planet"))).toBe("applied");
    expect(harness.text()).toBe("Hello planet");

    harness.select("planet");
    api.current!.capture((getNoteId) => harness.createAdapter(getNoteId));
    await render({ open: false, noteId: "note-1" });
    expect(api.current!.apply("replace", write)).toBe("conflict");
    expect(write).not.toHaveBeenCalled();
  });

  it("replaces the previous anchor when the assistant is opened again", async () => {
    const { api, render } = mount();
    const harness = markdownHarness("Hello world");
    await render({ open: true, noteId: "note-1" });
    harness.select("Hello");
    api.current!.capture((getNoteId) => harness.createAdapter(getNoteId));
    harness.select("world");
    api.current!.capture((getNoteId) => harness.createAdapter(getNoteId));
    expect(api.current!.apply("replace", ({ from, to }) => harness.write(from, to, "planet"))).toBe("applied");
    expect(harness.text()).toBe("Hello planet");
  });
});
