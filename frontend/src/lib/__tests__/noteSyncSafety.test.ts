// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import {
  isServerConfirmedNoteWrite,
  isVersionedNoteMutation,
  listNoteSyncConflicts,
  preserveNoteSyncConflictSnapshot,
  recordNoteSyncConflict,
} from "@/lib/noteSyncSafety";
import { getQueue } from "@/lib/offlineQueue";

describe("note sync safety", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("requires server revision advancement before a versioned write is considered synced", () => {
    expect(isServerConfirmedNoteWrite(7, 8)).toBe(true);
    expect(isServerConfirmedNoteWrite(7, 7)).toBe(false);
    expect(isServerConfirmedNoteWrite(7, 6)).toBe(false);
    expect(isServerConfirmedNoteWrite(7, undefined)).toBe(false);
  });

  it("classifies content, title and format mutations as revision-sensitive", () => {
    expect(isVersionedNoteMutation({ content: "new" })).toBe(true);
    expect(isVersionedNoteMutation({ contentText: "new" })).toBe(true);
    expect(isVersionedNoteMutation({ title: "renamed" })).toBe(true);
    expect(isVersionedNoteMutation({ contentFormat: "markdown" })).toBe(true);
    expect(isVersionedNoteMutation({ isPinned: 1 })).toBe(false);
  });

  it("keeps both local and server snapshots in a bounded conflict vault", () => {
    recordNoteSyncConflict({
      noteId: "note-1",
      baseVersion: 3,
      serverVersion: 10,
      serverUpdatedAt: "2026-07-10T09:00:00Z",
      localTitle: "local",
      localContent: "local body",
      localContentText: "local body",
      serverTitle: "server",
      serverContent: "server body",
      serverContentText: "server body",
      createdAt: 1,
      reason: "VERSION_CONFLICT",
    });

    expect(listNoteSyncConflicts()).toEqual([
      expect.objectContaining({
        noteId: "note-1",
        baseVersion: 3,
        serverVersion: 10,
        localContent: "local body",
        serverContent: "server body",
        reason: "VERSION_CONFLICT",
      }),
    ]);
  });

  it("preserves a debounced editor snapshot without issuing a server write", () => {
    preserveNoteSyncConflictSnapshot(
      "note-1",
      {
        version: 8,
        title: "刚输入的标题",
        content: "刚输入的正文",
        contentText: "刚输入的正文",
        contentFormat: "tiptap-json",
      },
      8,
      {
        id: "note-1",
        version: 8,
        title: "服务器标题",
        content: "服务器正文",
        contentText: "服务器正文",
      },
    );

    expect(getQueue()).toEqual([
      expect.objectContaining({
        noteId: "note-1",
        conflict: true,
        localPayload: expect.objectContaining({ content: "刚输入的正文" }),
      }),
    ]);
    expect(localStorage.getItem("nowen-draft-note-1")).toContain("刚输入的正文");
    expect(listNoteSyncConflicts()).toEqual([
      expect.objectContaining({
        noteId: "note-1",
        serverVersion: 8,
        localContent: "刚输入的正文",
      }),
    ]);
  });

  it("limits stored conflict metadata to the newest twenty records", () => {
    for (let index = 0; index < 25; index += 1) {
      recordNoteSyncConflict({
        noteId: `note-${index}`,
        baseVersion: index,
        createdAt: index,
        reason: "STALE_OFFLINE_BASE",
      });
    }

    const records = listNoteSyncConflicts();
    expect(records).toHaveLength(20);
    expect(records[0].noteId).toBe("note-24");
    expect(records[19].noteId).toBe("note-5");
  });
});
