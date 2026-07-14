import { beforeEach, describe, expect, it } from "vitest";
import {
  clearNoteSyncConflict,
  getNoteSyncConflict,
  listNoteSyncConflicts,
  recordNoteSyncConflict,
  type NoteSyncConflictRecord,
} from "@/lib/noteSyncSafety";

function record(overrides: Partial<NoteSyncConflictRecord> = {}): NoteSyncConflictRecord {
  return {
    noteId: "note-1",
    baseVersion: 3,
    serverVersion: 8,
    localTitle: "本地标题",
    localContent: "本地正文",
    localContentText: "本地正文",
    createdAt: Date.now(),
    reason: "VERSION_CONFLICT",
    ...overrides,
  };
}

describe("noteSyncSafety conflict records", () => {
  beforeEach(() => localStorage.clear());

  it("stores only the latest record for one note and suppresses an identical conflict notification", () => {
    expect(recordNoteSyncConflict(record({ createdAt: 1 }))).toBe(true);
    expect(recordNoteSyncConflict(record({ createdAt: 2 }))).toBe(false);
    expect(listNoteSyncConflicts()).toHaveLength(1);
    expect(getNoteSyncConflict("note-1")?.createdAt).toBe(2);
  });

  it("treats changed local content as a new conflict while still replacing the old record", () => {
    recordNoteSyncConflict(record({ createdAt: 1 }));
    expect(recordNoteSyncConflict(record({ localContent: "更新后的本地正文", createdAt: 2 }))).toBe(true);
    expect(listNoteSyncConflicts()).toHaveLength(1);
    expect(getNoteSyncConflict("note-1")?.localContent).toBe("更新后的本地正文");
  });

  it("clears one resolved note without deleting other conflict records", () => {
    recordNoteSyncConflict(record({ noteId: "note-1" }));
    recordNoteSyncConflict(record({ noteId: "note-2" }));
    clearNoteSyncConflict("note-1");
    expect(getNoteSyncConflict("note-1")).toBeNull();
    expect(getNoteSyncConflict("note-2")).not.toBeNull();
  });
});
