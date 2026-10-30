import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import PlainTextEditor from "../PlainTextEditor";
import type { Note } from "@/types";
import type { NoteEditorHandle } from "../editors/types";
import { loadDraft } from "@/lib/draftStorage";
import { stabilizeNoteContentForPersistence } from "@/lib/noteContentPersistence";
import { resolveNoteEditorKind } from "@/lib/noteEditorRouting";

const mocks = vi.hoisted(() => ({ saveAs: vi.fn() }));
vi.mock("file-saver", () => ({ saveAs: mocks.saveAs }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const literal = '  # heading\n**bold**\n<img src="blob:literal">\n{"type":"doc"}\n\t  \n';
const note = { id: "txt-test", title: "TXT", content: literal, contentText: literal, contentFormat: "plaintext", version: 1 } as Note;
let root: Root;
let host: HTMLDivElement;
const onUpdate = vi.fn();
const onLocalUpdate = vi.fn();
let handle: React.RefObject<NoteEditorHandle>;
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks(); localStorage.clear();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  handle = React.createRef<NoteEditorHandle>();
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); });
function render(overrides: Partial<React.ComponentProps<typeof PlainTextEditor>> = {}) {
  act(() => root.render(<PlainTextEditor key={note.id} ref={handle} note={note} onUpdate={onUpdate} onLocalUpdate={onLocalUpdate} {...overrides} />));
}
function typeText(value: string) {
  const textarea = host.querySelector("textarea")!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
it("shows literal Markdown, HTML and JSON with no formatted preview or toolbar", () => {
  render();
  expect(host.querySelector("textarea")!.value).toBe(literal);
  expect(host.querySelector("img, iframe, .ProseMirror, .cm-editor")).toBeNull();
  expect(resolveNoteEditorKind("plaintext")).toBe("plaintext");
  expect(stabilizeNoteContentForPersistence(literal, "plaintext")).toBe(literal);
});
it("mirrors typing immediately, protects an exact draft and saves the latest text after debounce", () => {
  render(); typeText("# first"); typeText(literal + "new  ");
  expect(onUpdate).not.toHaveBeenCalled();
  expect(onLocalUpdate).toHaveBeenLastCalledWith(expect.objectContaining({ content: literal + "new  ", _noteId: note.id }));
  expect(loadDraft(note.id)?.content).toBe(literal + "new  ");
  act(() => vi.advanceTimersByTime(500));
  expect(onUpdate).toHaveBeenCalledTimes(1);
  expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ content: literal + "new  ", contentText: literal + "new  ", _saveGeneration: 2 }));
});
it("flushes pending typing on unmount and returns an exact snapshot", () => {
  render(); typeText("trailing  \n\n");
  expect(handle.current!.getSnapshot!()).toEqual({ content: "trailing  \n\n", contentText: "trailing  \n\n", title: "TXT" });
  act(() => root.unmount());
  expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ content: "trailing  \n\n", _noteId: note.id }));
});
it("late acknowledgements and old props cannot replace newer local text", () => {
  render(); typeText("first"); act(() => vi.advanceTimersByTime(500)); typeText("second");
  act(() => handle.current!.acknowledgeSave!({ noteId: note.id, version: 2, content: "first", saveGeneration: 1, preserveLocalEditor: true }));
  render({ note: { ...note, content: "first", version: 2 } });
  expect(host.querySelector("textarea")!.value).toBe("second");
  expect(loadDraft(note.id)?.content).toBe("second");
});
it("supports empty text, readonly access and guest drafts stay out of local storage", () => {
  render(); typeText(""); act(() => handle.current!.flushSave());
  expect(onUpdate).toHaveBeenLastCalledWith(expect.objectContaining({ content: "", contentText: "" }));
  render({ editable: false }); typeText("forbidden");
  expect(handle.current!.getSnapshot!()?.content).toBe("");
  expect(host.querySelector("input")!.readOnly).toBe(true);
  expect(host.querySelector("textarea")!.readOnly).toBe(true);
  localStorage.clear(); render({ isGuest: true }); typeText("guest");
  expect(loadDraft(note.id)).toBeNull();
});
it("exports the current unsaved content as a text/plain .txt file", () => {
  render(); typeText(literal + "unsaved"); act(() => host.querySelector("button")!.click());
  const [blob, filename, options] = mocks.saveAs.mock.calls[0];
  expect(blob.type).toBe("text/plain;charset=utf-8");
  expect(blob.size).toBe(new Blob([literal + "unsaved"]).size);
  expect(filename).toBe("TXT.txt"); expect(options.autoBom).toBe(false);
});
