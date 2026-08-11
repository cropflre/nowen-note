// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACKNOWLEDGED_DRAFT_CLEAR_GRACE_MS,
  clearAllDrafts,
  clearDraft,
  loadDraft,
  markDraftAcknowledged,
  saveDraft,
  shouldOfferRestore,
} from "@/lib/draftStorage";

describe("draft conflict preservation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-02T12:00:00.000Z"));
    localStorage.clear();
    clearAllDrafts();
  });

  afterEach(() => {
    clearAllDrafts();
    vi.useRealTimers();
  });

  it("does not silently rebase identical stale content to a newer server revision", () => {
    const now = Date.now();
    saveDraft({
      noteId: "note-1",
      editorMode: "md",
      title: "Title",
      content: "stale local body",
      contentText: "stale local body",
      baseVersion: 3,
      savedAt: now,
    });

    saveDraft({
      noteId: "note-1",
      editorMode: "md",
      title: "Title",
      content: "stale local body",
      contentText: "stale local body",
      baseVersion: 9,
      savedAt: now + 100,
    });

    expect(loadDraft("note-1")).toEqual(expect.objectContaining({
      baseVersion: 3,
      serverVersion: 9,
      conflicted: true,
    }));
  });

  it("keeps conflicted drafts visible even when the server timestamp is newer", () => {
    const draft = {
      noteId: "note-1",
      editorMode: "md" as const,
      title: "Title",
      content: "local",
      contentText: "local",
      baseVersion: 3,
      savedAt: Date.now(),
      conflicted: true,
      serverVersion: 9,
    };

    expect(shouldOfferRestore(
      draft,
      9,
      "2099-01-01T00:00:00.000Z",
      "server",
    )).toBe(true);
  });

  it("never lets generic save-success cleanup delete an unresolved conflicted draft", () => {
    saveDraft({
      noteId: "note-conflicted-clear",
      editorMode: "md",
      title: "Local title",
      content: "local unresolved body",
      contentText: "local unresolved body",
      baseVersion: 3,
      savedAt: Date.now(),
      conflicted: true,
      serverVersion: 9,
    });

    expect(clearDraft("note-conflicted-clear")).toBe(false);
    expect(loadDraft("note-conflicted-clear")).toEqual(expect.objectContaining({
      content: "local unresolved body",
      conflicted: true,
    }));
  });

  it("offers a divergent local body even when the server clock is ahead", () => {
    const draft = {
      noteId: "note-clock-skew",
      editorMode: "md" as const,
      title: "Title",
      content: "two days of local writing",
      contentText: "two days of local writing",
      baseVersion: 7,
      savedAt: Date.now(),
    };

    expect(shouldOfferRestore(
      draft,
      8,
      "2099-01-01T00:00:00.000Z",
      "old server body",
    )).toBe(true);
  });

  it("does not offer a draft whose body is already on the server", () => {
    const draft = {
      noteId: "note-equal",
      editorMode: "md" as const,
      title: "Title",
      content: "already persisted",
      contentText: "already persisted",
      baseVersion: 7,
      savedAt: Date.now(),
    };

    expect(shouldOfferRestore(
      draft,
      8,
      "2020-01-01T00:00:00.000Z",
      "already persisted",
    )).toBe(false);
  });

  it("offers restore for a title-only draft when the server body matches", () => {
    const draft = {
      noteId: "note-title-only",
      editorMode: "tiptap" as const,
      title: "Unsaved title",
      content: "same body",
      contentText: "same body",
      baseVersion: 4,
      savedAt: Date.now(),
    };

    expect(shouldOfferRestore(
      draft,
      4,
      "2099-01-01T00:00:00.000Z",
      "same body",
      "Persisted title",
    )).toBe(true);
  });

  it("does not offer restore when both title and body already match", () => {
    const draft = {
      noteId: "note-title-persisted",
      editorMode: "md" as const,
      title: "Persisted title",
      content: "same body",
      contentText: "same body",
      baseVersion: 4,
      savedAt: Date.now(),
    };

    expect(shouldOfferRestore(
      draft,
      5,
      "2020-01-01T00:00:00.000Z",
      "same body",
      "Persisted title",
    )).toBe(false);
  });

  it("allows a genuinely changed local body to start a new draft lineage", () => {
    const now = Date.now();
    saveDraft({
      noteId: "note-1",
      editorMode: "md",
      title: "Title",
      content: "old local body",
      contentText: "old local body",
      baseVersion: 3,
      savedAt: now,
      conflicted: true,
    });
    saveDraft({
      noteId: "note-1",
      editorMode: "md",
      title: "Title",
      content: "new explicit edit",
      contentText: "new explicit edit",
      baseVersion: 9,
      savedAt: now + 100,
    });

    expect(loadDraft("note-1")).toEqual(expect.objectContaining({
      content: "new explicit edit",
      baseVersion: 9,
    }));
    expect(loadDraft("note-1")?.conflicted).toBeUndefined();
  });

  it("keeps a matching acknowledged draft during the editor debounce grace period", () => {
    const savedAt = Date.now();
    saveDraft({
      noteId: "note-ack",
      editorMode: "tiptap",
      title: "Title",
      content: "persisted body",
      contentText: "persisted body",
      baseVersion: 4,
      savedAt,
    });
    markDraftAcknowledged({
      noteId: "note-ack",
      title: "Title",
      content: "persisted body",
      contentText: "persisted body",
      serverVersion: 5,
    });

    expect(clearDraft("note-ack")).toBe(true);
    expect(loadDraft("note-ack")?.content).toBe("persisted body");

    vi.advanceTimersByTime(ACKNOWLEDGED_DRAFT_CLEAR_GRACE_MS - 1);
    expect(loadDraft("note-ack")?.content).toBe("persisted body");
    vi.advanceTimersByTime(1);
    expect(loadDraft("note-ack")).toBeNull();
  });

  it("does not let an older ACK clear a newer local draft", () => {
    const savedAt = Date.now();
    saveDraft({
      noteId: "note-race",
      editorMode: "tiptap",
      title: "Title",
      content: "sent body",
      contentText: "sent body",
      baseVersion: 10,
      savedAt,
    });
    markDraftAcknowledged({
      noteId: "note-race",
      title: "Title",
      content: "sent body",
      contentText: "sent body",
      serverVersion: 11,
    });
    expect(clearDraft("note-race")).toBe(true);

    saveDraft({
      noteId: "note-race",
      editorMode: "tiptap",
      title: "Title",
      content: "new unsent body",
      contentText: "new unsent body",
      baseVersion: 11,
      savedAt: savedAt + 1,
    });
    vi.advanceTimersByTime(ACKNOWLEDGED_DRAFT_CLEAR_GRACE_MS * 2);

    expect(loadDraft("note-race")).toEqual(expect.objectContaining({
      content: "new unsent body",
      savedAt: savedAt + 1,
    }));
  });

  it("refuses immediate cleanup when the current draft differs from the ACK body", () => {
    saveDraft({
      noteId: "note-mismatch",
      editorMode: "md",
      title: "Title",
      content: "new local body",
      contentText: "new local body",
      baseVersion: 12,
      savedAt: Date.now(),
    });
    markDraftAcknowledged({
      noteId: "note-mismatch",
      title: "Title",
      content: "older server body",
      contentText: "older server body",
      serverVersion: 13,
    });

    expect(clearDraft("note-mismatch")).toBe(false);
    vi.advanceTimersByTime(ACKNOWLEDGED_DRAFT_CLEAR_GRACE_MS * 2);
    expect(loadDraft("note-mismatch")?.content).toBe("new local body");
  });
});
