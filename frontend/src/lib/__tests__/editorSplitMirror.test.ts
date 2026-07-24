import { describe, expect, it } from "vitest";
import type { Note } from "@/types";
import {
  applyEditorUpdateToNote,
  prepareEditorSplitClose,
  readEditorSplitCloseNoteId,
  PREPARE_EDITOR_SPLIT_CLOSE_EVENT,
} from "@/lib/editorSplitMirror";

const note = {
  id: "note-1",
  title: "Before",
  content: "old content",
  contentText: "old text",
} as Note;

describe("editorSplitMirror", () => {
  it("merges the latest local editor payload without dropping persisted note fields", () => {
    const updated = applyEditorUpdateToNote(note, {
      title: "After",
      content: "new content",
      contentText: "new text",
    });

    expect(updated).toMatchObject({
      id: "note-1",
      title: "After",
      content: "new content",
      contentText: "new text",
    });
  });

  it("preserves content for title-only updates", () => {
    expect(applyEditorUpdateToNote(note, { title: "Renamed" })).toMatchObject({
      title: "Renamed",
      content: "old content",
      contentText: "old text",
    });
  });

  it("dispatches a synchronous close-preparation request for the active note", () => {
    let received: string | null = null;
    const listener = (event: Event) => { received = readEditorSplitCloseNoteId(event); };
    window.addEventListener(PREPARE_EDITOR_SPLIT_CLOSE_EVENT, listener);

    prepareEditorSplitClose("note-1");

    window.removeEventListener(PREPARE_EDITOR_SPLIT_CLOSE_EVENT, listener);
    expect(received).toBe("note-1");
  });
});
