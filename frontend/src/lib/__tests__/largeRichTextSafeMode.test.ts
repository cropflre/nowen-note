import { describe, expect, it } from "vitest";
import type { Note } from "@/types";
import {
  getEditorRuntimeDecisionForNote,
  getLargeDocumentOriginalFormat,
  isLargeDocumentCollaborationBlocked,
  isLargeRichTextSafeNote,
  LARGE_RICH_TEXT_THRESHOLDS,
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

function tiptapText(length: number): string {
  return `{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"${"x".repeat(length)}"}]}]}`;
}

describe("large rich-text runtime safety", () => {
  it("keeps an ordinary compact 18 KB Tiptap document editable", () => {
    const rawContent = tiptapText(18_000);
    const original = makeNote({ content: rawContent });

    const prepared = prepareLargeRichTextNoteForDisplay(original);

    expect(rawContent.length).toBeGreaterThan(17 * 1024);
    expect(rawContent.length).toBeLessThan(20 * 1024);
    expect(prepared).toBe(original);
    expect(isLargeRichTextSafeNote(prepared)).toBe(false);
    expect(isLargeDocumentCollaborationBlocked(original.id)).toBe(false);
    expect(getEditorRuntimeDecisionForNote(prepared)?.mode).toBe("normal");
  });

  it("marks medium rich text for viewport optimization without changing content format", () => {
    const original = makeNote({ id: "note-viewport", content: tiptapText(120_000) });
    const prepared = prepareLargeRichTextNoteForDisplay(original);

    expect(prepared).not.toBe(original);
    expect(prepared.content).toBe(original.content);
    expect(prepared.contentFormat).toBe("tiptap-json");
    expect(getEditorRuntimeDecisionForNote(prepared)?.mode).toBe("viewport-optimized");
    expect(isLargeRichTextSafeNote(prepared)).toBe(false);
    expect(isLargeDocumentCollaborationBlocked(original.id)).toBe(false);
  });

  it("keeps larger rich text editable in lightweight mode", () => {
    const original = makeNote({ id: "note-lightweight", content: tiptapText(400_000) });
    const prepared = prepareLargeRichTextNoteForDisplay(original);
    const decision = getEditorRuntimeDecisionForNote(prepared);

    expect(prepared.contentFormat).toBe("tiptap-json");
    expect(decision?.mode).toBe("lightweight-edit");
    expect(decision?.capabilities.editable).toBe(true);
    expect(decision?.capabilities.syntaxHighlight).toBe(false);
    expect(isLargeRichTextSafeNote(prepared)).toBe(false);
  });

  it("routes genuinely pathological Tiptap content to the safe viewer without modifying raw content", () => {
    const rawContent = tiptapText(LARGE_RICH_TEXT_THRESHOLDS.serializedCharacters);
    const original = makeNote({ content: rawContent });

    const prepared = prepareLargeRichTextNoteForDisplay(original);

    expect(prepared).not.toBe(original);
    expect(prepared.content).toBe(rawContent);
    expect(prepared.contentText).toBe(original.contentText);
    expect(prepared.contentFormat).toBe("markdown");
    expect(isLargeRichTextSafeNote(prepared)).toBe(true);
    expect(getLargeDocumentOriginalFormat(prepared)).toBe("tiptap-json");
    expect(isLargeDocumentCollaborationBlocked(original.id)).toBe(true);
    expect(getEditorRuntimeDecisionForNote(prepared)?.mode).toBe("emergency-readonly");
  });

  it("protects structurally extreme Tiptap JSON even below the size threshold", () => {
    const nodes = Array.from(
      { length: LARGE_RICH_TEXT_THRESHOLDS.approximateNodes },
      () => '{"type":"x"}',
    ).join(",");
    const rawContent = `{"type":"doc","content":[${nodes}]}`;
    const original = makeNote({ id: "note-node-heavy", content: rawContent });

    expect(rawContent.length).toBeLessThan(LARGE_RICH_TEXT_THRESHOLDS.serializedCharacters);
    expect(isLargeRichTextSafeNote(prepareLargeRichTextNoteForDisplay(original))).toBe(true);
    expect(isLargeDocumentCollaborationBlocked(original.id)).toBe(true);
  });

  it("does not apply compact-JSON line heuristics to legacy HTML", () => {
    const html = `<p>${"x".repeat(18_000)}</p>`;
    const original = makeNote({
      id: "note-html",
      content: html,
      contentFormat: "html",
    });

    expect(prepareLargeRichTextNoteForDisplay(original)).toBe(original);
    expect(isLargeDocumentCollaborationBlocked(original.id)).toBe(false);
  });

  it("leaves native Markdown on an editable progressive path", () => {
    const markdown = makeNote({
      id: "note-native-markdown",
      content: "x".repeat(800_000),
      contentText: "x".repeat(800_000),
      contentFormat: "markdown",
    });

    const prepared = prepareLargeRichTextNoteForDisplay(markdown);

    expect(isLargeRichTextSafeNote(prepared)).toBe(false);
    expect(isLargeDocumentCollaborationBlocked(markdown.id)).toBe(false);
    expect(getEditorRuntimeDecisionForNote(prepared)?.mode).toBe("lightweight-edit");
    expect(getEditorRuntimeDecisionForNote(prepared)?.capabilities.editable).toBe(true);
  });

  it("removes a stale collaboration block after the note becomes small again", () => {
    const large = makeNote({
      id: "note-resized",
      content: tiptapText(LARGE_RICH_TEXT_THRESHOLDS.serializedCharacters),
    });
    const protectedNote = prepareLargeRichTextNoteForDisplay(large);
    expect(isLargeDocumentCollaborationBlocked(large.id)).toBe(true);

    const small = makeNote({
      id: large.id,
      content: '{"type":"doc","content":[]}',
      contentFormat: getLargeDocumentOriginalFormat(protectedNote),
    });
    const prepared = prepareLargeRichTextNoteForDisplay(small);

    expect(prepared).toBe(small);
    expect(isLargeRichTextSafeNote(prepared)).toBe(false);
    expect(isLargeDocumentCollaborationBlocked(large.id)).toBe(false);
  });
});
