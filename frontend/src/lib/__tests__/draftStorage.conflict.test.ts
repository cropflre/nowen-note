// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import { loadDraft, saveDraft, shouldOfferRestore } from "@/lib/draftStorage";

describe("draft conflict preservation", () => {
  beforeEach(() => localStorage.clear());

  it("does not silently rebase identical stale content to a newer server revision", () => {
    saveDraft({
      noteId: "note-1",
      editorMode: "md",
      title: "Title",
      content: "stale local body",
      contentText: "stale local body",
      baseVersion: 3,
      savedAt: 100,
    });

    saveDraft({
      noteId: "note-1",
      editorMode: "md",
      title: "Title",
      content: "stale local body",
      contentText: "stale local body",
      baseVersion: 9,
      savedAt: 200,
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
      savedAt: 100,
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

  it("allows a genuinely changed local body to start a new draft lineage", () => {
    saveDraft({
      noteId: "note-1",
      editorMode: "md",
      title: "Title",
      content: "old local body",
      contentText: "old local body",
      baseVersion: 3,
      savedAt: 100,
      conflicted: true,
    });
    saveDraft({
      noteId: "note-1",
      editorMode: "md",
      title: "Title",
      content: "new explicit edit",
      contentText: "new explicit edit",
      baseVersion: 9,
      savedAt: 300,
    });

    expect(loadDraft("note-1")).toEqual(expect.objectContaining({
      content: "new explicit edit",
      baseVersion: 9,
    }));
    expect(loadDraft("note-1")?.conflicted).toBeUndefined();
  });
});
