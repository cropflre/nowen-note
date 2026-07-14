// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import { markOfflineNoteSnapshot, clearOfflineNoteSnapshot } from "@/lib/offlineRead";
import {
  installNoteSyncSafety,
  NOTE_SYNC_PENDING_EVENT,
} from "@/lib/noteSyncSafety";
import {
  getQueue,
  OFFLINE_QUEUE_CONFLICT_EVENT,
} from "@/lib/offlineQueue";

const INSTALL_KEY = "__NOWEN_NOTE_SYNC_SAFETY_V1__";
const realGetNote = api.getNote;
const realUpdateNote = api.updateNote;

function note(version: number, content = "server body") {
  return {
    id: "note-1",
    userId: "user-1",
    notebookId: "notebook-1",
    workspaceId: null,
    title: "Title",
    content,
    contentText: content,
    contentFormat: "markdown",
    version,
    isPinned: 0,
    isFavorite: 0,
    isLocked: 0,
    isArchived: 0,
    isTrashed: 0,
    sortOrder: 0,
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
    tags: [],
  } as any;
}

beforeEach(() => {
  localStorage.clear();
  clearOfflineNoteSnapshot("note-1");
  const uninstall = (window as any)[INSTALL_KEY] as (() => void) | undefined;
  uninstall?.();
  (api as any).getNote = realGetNote;
  (api as any).updateNote = realUpdateNote;
});

afterEach(() => {
  const uninstall = (window as any)[INSTALL_KEY] as (() => void) | undefined;
  uninstall?.();
  (api as any).getNote = realGetNote;
  (api as any).updateNote = realUpdateNote;
  clearOfflineNoteSnapshot("note-1");
});

describe("installed note sync safety", () => {
  it("does not report an optimistic offline response as server-confirmed", async () => {
    const transportUpdate = vi.fn().mockResolvedValue(note(4, "local body"));
    (api as any).getNote = vi.fn().mockResolvedValue(note(4));
    (api as any).updateNote = transportUpdate;
    installNoteSyncSafety();

    const pending = vi.fn();
    window.addEventListener(NOTE_SYNC_PENDING_EVENT, pending);
    await expect(api.updateNote("note-1", {
      version: 4,
      title: "Title",
      content: "local body",
      contentText: "local body",
      contentFormat: "markdown",
    } as any)).rejects.toMatchObject({
      code: "OFFLINE_WRITE_QUEUED",
      queued: true,
    });
    window.removeEventListener(NOTE_SYNC_PENDING_EVENT, pending);

    expect(transportUpdate).toHaveBeenCalledTimes(1);
    expect(pending).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem("nowen-draft-note-1")).toContain("local body");
  });

  it("fetches the server revision and blocks PUT when an offline detail is stale", async () => {
    const transportGet = vi.fn().mockResolvedValue(note(9, "new server body"));
    const transportUpdate = vi.fn();
    (api as any).getNote = transportGet;
    (api as any).updateNote = transportUpdate;
    markOfflineNoteSnapshot(note(4, "old cached body"));
    installNoteSyncSafety();

    await expect(api.updateNote("note-1", {
      version: 4,
      title: "Title",
      content: "old cached body",
      contentText: "old cached body",
      contentFormat: "markdown",
    } as any)).rejects.toMatchObject({
      status: 409,
      code: "VERSION_CONFLICT",
      currentVersion: 9,
    });

    expect(transportGet).toHaveBeenCalledTimes(1);
    expect(transportUpdate).not.toHaveBeenCalled();
    expect(localStorage.getItem("nowen-note-sync-conflicts:v1")).toContain("new server body");
  });

  it("pauses later writes after one conflict and only refreshes the preserved local payload", async () => {
    const transportGet = vi.fn().mockResolvedValue(note(9, "new server body"));
    const transportUpdate = vi.fn();
    (api as any).getNote = transportGet;
    (api as any).updateNote = transportUpdate;
    markOfflineNoteSnapshot(note(4, "old cached body"));
    installNoteSyncSafety();

    const conflictEvents = vi.fn();
    window.addEventListener(OFFLINE_QUEUE_CONFLICT_EVENT, conflictEvents);
    await expect(api.updateNote("note-1", {
      version: 4,
      title: "Title",
      content: "first local body",
      contentText: "first local body",
      contentFormat: "markdown",
    } as any)).rejects.toMatchObject({ code: "VERSION_CONFLICT" });

    await expect(api.updateNote("note-1", {
      version: 4,
      title: "Title",
      content: "latest local body",
      contentText: "latest local body",
      contentFormat: "markdown",
    } as any)).resolves.toMatchObject({
      id: "note-1",
      version: 9,
      content: "latest local body",
    });
    window.removeEventListener(OFFLINE_QUEUE_CONFLICT_EVENT, conflictEvents);

    expect(transportGet).toHaveBeenCalledTimes(1);
    expect(transportUpdate).not.toHaveBeenCalled();
    expect(conflictEvents).toHaveBeenCalledTimes(1);
    expect(getQueue()).toEqual([
      expect.objectContaining({
        noteId: "note-1",
        conflict: true,
        localPayload: expect.objectContaining({ content: "latest local body" }),
      }),
    ]);
  });

  it("blocks same-version writes when the cached base body differs from the server", async () => {
    const transportGet = vi.fn().mockResolvedValue(note(4, "important server body"));
    const transportUpdate = vi.fn();
    (api as any).getNote = transportGet;
    (api as any).updateNote = transportUpdate;
    markOfflineNoteSnapshot(note(4, ""));
    installNoteSyncSafety();

    await expect(api.updateNote("note-1", {
      version: 4,
      title: "Title",
      content: "",
      contentText: "",
      contentFormat: "markdown",
    } as any)).rejects.toMatchObject({
      status: 409,
      code: "VERSION_CONFLICT",
      currentVersion: 4,
      baseContentMismatch: true,
    });

    expect(transportUpdate).not.toHaveBeenCalled();
  });

  it("allows a cached detail only after a fresh GET confirms revision and base body", async () => {
    const transportGet = vi.fn().mockResolvedValue(note(4, "cached body"));
    const transportUpdate = vi.fn().mockResolvedValue(note(5, "edited body"));
    (api as any).getNote = transportGet;
    (api as any).updateNote = transportUpdate;
    markOfflineNoteSnapshot(note(4, "cached body"));
    installNoteSyncSafety();

    await expect(api.updateNote("note-1", {
      version: 4,
      title: "Title",
      content: "edited body",
      contentText: "edited body",
      contentFormat: "markdown",
    } as any)).resolves.toMatchObject({ version: 5, content: "edited body" });

    expect(transportGet).toHaveBeenCalledTimes(1);
    expect(transportUpdate).toHaveBeenCalledTimes(1);
  });

  it("still permits an intentional clear when the cached base matches the server", async () => {
    const transportGet = vi.fn().mockResolvedValue(note(4, "cached body"));
    const transportUpdate = vi.fn().mockResolvedValue(note(5, ""));
    (api as any).getNote = transportGet;
    (api as any).updateNote = transportUpdate;
    markOfflineNoteSnapshot(note(4, "cached body"));
    installNoteSyncSafety();

    await expect(api.updateNote("note-1", {
      version: 4,
      title: "Title",
      content: "",
      contentText: "",
      contentFormat: "markdown",
    } as any)).resolves.toMatchObject({ version: 5, content: "" });

    expect(transportUpdate).toHaveBeenCalledTimes(1);
  });
});
