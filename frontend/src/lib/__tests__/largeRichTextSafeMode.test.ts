import { describe, expect, it } from "vitest";
import type { Note } from "@/types";
import {
  getLargeDocumentOriginalFormat,
  isLargeDocumentCollaborationBlocked,
  isLargeRichTextSafeNote,
  prepareLargeRichTextNoteForDisplay,
} from "@/lib/largeRichTextSafeMode";

function makeNote(overrides: Partial<Note> = {}): Note {
  return {
    id: "note-large-rich",
    userId: "user-1",
    notebookId: "notebook-1",
    workspaceId: null,
    title: "Large import",
    content: "{}",
    contentText: "plain text",
    contentFormat: "tiptap-json",
    isPinned: 0,
    isFavorite: 0,
    isLocked: 0,
    isArchived: 0,
    isTrashed: 0,
    trashedAt: null,
    version: 1,
    sortOrder: 0,
    createdAt: "2026-07-21T00:00:00.000Z",
    updatedAt: "2026-07-21T00:00:00.000Z",
    ...overrides,
  };
}

describe("large rich-text runtime safety", () => {
  it("routes pathological Tiptap content to the safe viewer without modifying raw content", () => {
    const rawContent =
      `{"type":"doc","content":[{"type":"text","text":"${"x".repeat(8_100)}"}]}`;
    const original = makeNote({ content: rawContent });

    const prepared = prepareLargeRichTextNoteForDisplay(original);

    expect(prepared).not.toBe(original);
    expect(prepared.content).toBe(rawContent);
    expect(prepared.contentText).toBe(original.contentText);
    expect(prepared.contentFormat).toBe("markdown");
    expect(isLargeRichTextSafeNote(prepared)).toBe(true);
    expect(getLargeDocumentOriginalFormat(prepared)).toBe("tiptap-json");
    expect(isLargeDocumentCollaborationBlocked(original.id)).toBe(true);
  });

  it("leaves native Markdown on the existing editable large-document path", () => {
    const markdown = makeNote({
      id: "note-native-markdown",
      content: "x".repeat(8_100),
      contentText: "x".repeat(8_100),
      contentFormat: "markdown",
    });

    const prepared = prepareLargeRichTextNoteForDisplay(markdown);

    expect(prepared).toBe(markdown);
    expect(isLargeRichTextSafeNote(prepared)).toBe(false);
    expect(isLargeDocumentCollaborationBlocked(markdown.id)).toBe(false);
  });

  it("removes a stale collaboration block after the note becomes small again", () => {
    const large = makeNote({
      id: "note-resized",
      content: `{"type":"doc","text":"${"x".repeat(8_100)}"}`,
    });
    prepareLargeRichTextNoteForDisplay(large);
    expect(isLargeDocumentCollaborationBlocked(large.id)).toBe(true);

    const small = makeNote({
      id: large.id,
      content: '{"type":"doc","content":[]}',
    });
    const prepared = prepareLargeRichTextNoteForDisplay(small);

    expect(prepared).toBe(small);
    expect(isLargeDocumentCollaborationBlocked(large.id)).toBe(false);
  });
});
