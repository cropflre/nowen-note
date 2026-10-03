import { convertedNoteVersion, assertConversionNote } from "../conversionBarrier";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanupConvertedNoteCopies, type ConversionCleanupInput } from "../conversionCleanup";
import { clearCachedNoteForEncryptionConversion, getCurrentUserId, inspectCachedNotePresence } from "../../localStore";
import { getOfflineQueueStorageKey, isOfflineQueueFlushing } from "../../offlineQueue";
import vector from "./fixtures/envelope-v1.json";

vi.mock("../../localStore", () => ({ clearCachedNoteForEncryptionConversion: vi.fn(), getCurrentUserId: vi.fn(), inspectCachedNotePresence: vi.fn() }));
vi.mock("../../yjsProvider", () => ({ getYjsPersistenceName: () => "target-yjs" }));
vi.mock("../../offlineQueue", async (original) => ({ ...await original<typeof import("../../offlineQueue")>(), isOfflineQueueFlushing: vi.fn() }));
const input: ConversionCleanupInput = { noteId: "note", userId: "owner", version: 2, content: JSON.stringify(vector.envelope), discardLocalCopies: true };
const committed = () => ({ id: input.noteId, userId: input.userId, version: input.version, content: input.content, contentText: "", contentFormat: "encrypted-note-v1" });
const load = vi.fn();
beforeEach(() => {
  vi.resetAllMocks(); localStorage.clear();
  localStorage.setItem("nowen-token", `header.${btoa(JSON.stringify({ userId: "owner" }))}.signature`);
  localStorage.setItem("nowen-draft-note", "private-source");
  localStorage.setItem("nowen-draft-other", "other-source");
  localStorage.setItem("nowen-draft-index", '["note","other"]');
  vi.mocked(getCurrentUserId).mockReturnValue("owner");
  vi.mocked(inspectCachedNotePresence).mockResolvedValueOnce(true).mockResolvedValue(false);
  vi.mocked(isOfflineQueueFlushing).mockReturnValue(false);
  load.mockResolvedValue(committed());
  const locks = { request: vi.fn(async (_name: string, _options: unknown, callback: (lock: unknown) => unknown) => callback({})) };
  vi.stubGlobal("navigator", { get locks() { return locks; } });
  vi.stubGlobal("indexedDB", { databases: vi.fn(async () => []), deleteDatabase: vi.fn() });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("clears only the confirmed note, preserves unrelated drafts/queues, and exposes no source", async () => {
  const unrelated = '[{"noteId":"other","body":{"content":"other-source"}}]';
  localStorage.setItem(getOfflineQueueStorageKey(), unrelated);
  const result = await cleanupConvertedNoteCopies(input, load);
  expect(result).toEqual({ noteId: "note", localCleanup: true, physicalErasure: "not_verified" });
  expect(JSON.stringify(result)).not.toContain("private-source");
  expect(localStorage.getItem("nowen-draft-note")).toBeNull();
  expect(localStorage.getItem("nowen-draft-other")).toBe("other-source");
  expect(localStorage.getItem("nowen-draft-index")).toBe('["other"]');
  expect(localStorage.getItem(getOfflineQueueStorageKey())).toBe(unrelated);
  expect(indexedDB.deleteDatabase).not.toHaveBeenCalled();
  expect(clearCachedNoteForEncryptionConversion).toHaveBeenCalledWith("note", "owner", expect.any(Function));
});
it.each(["id", "userId", "version", "content", "contentText", "contentFormat"])("rejects an unconfirmed %s before any cleanup", async (field) => {
  load.mockResolvedValue({ ...committed(), [field]: "different" });
  await expect(cleanupConvertedNoteCopies(input, load)).rejects.toMatchObject({ code: "not_committed" });
  expect(clearCachedNoteForEncryptionConversion).not.toHaveBeenCalled();
  expect(localStorage.getItem("nowen-draft-note")).toBe("private-source");
});
it("requires explicit discard consent", async () => {
  await expect(cleanupConvertedNoteCopies({ ...input, discardLocalCopies: false } as any, load)).rejects.toMatchObject({ code: "invalid_consent" });
  expect(load).not.toHaveBeenCalled();
});
it.each(["scoped", "legacy"])("refuses %s pending writes instead of silently dropping newer text", async (scope) => {
  const key = scope === "scoped" ? getOfflineQueueStorageKey() : "nowen-offline-queue";
  localStorage.setItem(key, '[{"noteId":"note","body":{"content":"newer-source"}}]');
  await expect(cleanupConvertedNoteCopies(input, load)).rejects.toMatchObject({ code: "pending_writes" });
  expect(load).not.toHaveBeenCalled(); expect(localStorage.getItem(key)).toContain("newer-source");
});
it("an in-flight replay blocks cleanup", async () => {
  vi.mocked(isOfflineQueueFlushing).mockReturnValue(true);
  await expect(cleanupConvertedNoteCopies(input, load)).rejects.toMatchObject({ code: "pending_writes" });
});
it("corrupt storage fails closed without revealing its payload", async () => {
  localStorage.setItem(getOfflineQueueStorageKey(), "private-source");
  await expect(cleanupConvertedNoteCopies(input, load)).rejects.toMatchObject({ code: "storage_failed", message: "storage_failed" });
  expect(load).not.toHaveBeenCalled();
});
it("a corrupt draft index refuses cleanup without overwriting unrelated index entries", async () => {
  localStorage.setItem("nowen-draft-index", "private-index");
  await expect(cleanupConvertedNoteCopies(input, load)).rejects.toMatchObject({ code: "storage_failed" });
  expect(load).not.toHaveBeenCalled(); expect(clearCachedNoteForEncryptionConversion).not.toHaveBeenCalled();
  expect(localStorage.getItem("nowen-draft-note")).toBe("private-source");
  expect(localStorage.getItem("nowen-draft-index")).toBe("private-index");
});
it("an uninitialized or other-account cache is unknown, never silently skipped", async () => {
  vi.mocked(inspectCachedNotePresence).mockReset().mockResolvedValue(null);
  await expect(cleanupConvertedNoteCopies(input, load)).rejects.toMatchObject({ code: "unavailable" });
  expect(load).not.toHaveBeenCalled();
});
it("busy or unavailable coordination performs no server read or deletion", async () => {
  vi.mocked(navigator.locks.request).mockImplementation(async (_name: any, _options: any, callback: any) => callback(null));
  await expect(cleanupConvertedNoteCopies(input, load)).rejects.toMatchObject({ code: "busy" });
  vi.spyOn(navigator, "locks", "get").mockReturnValue(undefined as any);
  await expect(cleanupConvertedNoteCopies(input, load)).rejects.toMatchObject({ code: "unavailable" });
  expect(load).not.toHaveBeenCalled();
});
it("a cross-window logout discards a late confirmation without deleting anything", async () => {
  load.mockImplementation(async () => {
    window.dispatchEvent(new StorageEvent("storage", { key: "nowen-token" }));
    return committed();
  });
  await expect(cleanupConvertedNoteCopies(input, load)).rejects.toMatchObject({ code: "scope_changed" });
  expect(clearCachedNoteForEncryptionConversion).not.toHaveBeenCalled();
});
it("failed IndexedDB cleanup preserves the draft for retry and does not claim success", async () => {
  vi.mocked(clearCachedNoteForEncryptionConversion).mockRejectedValue(new Error("private-db-error"));
  await expect(cleanupConvertedNoteCopies(input, load)).rejects.toMatchObject({ code: "storage_failed", message: "storage_failed" });
  expect(localStorage.getItem("nowen-draft-note")).toBe("private-source");
  expect(convertedNoteVersion("note")).toBe(2);
  expect(() => assertConversionNote({ id: "note", version: 1, contentFormat: "markdown", content: "private-source" })).toThrow("converted_note");
});
it("failed localStorage deletion is not treated as success", async () => {
  vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => { throw new Error("quota"); });
  await expect(cleanupConvertedNoteCopies(input, load)).rejects.toMatchObject({ code: "storage_failed" });
});
it("unavailable localStorage is a content-free failure before any cleanup", async () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("private-source"); });
  await expect(cleanupConvertedNoteCopies(input, load)).rejects.toMatchObject({ code: "storage_failed", message: "storage_failed" });
  expect(load).not.toHaveBeenCalled();
});
it("a resurrected cache record cannot be reported as cleaned", async () => {
  vi.mocked(inspectCachedNotePresence).mockReset().mockResolvedValue(true);
  await expect(cleanupConvertedNoteCopies(input, load)).rejects.toMatchObject({ code: "storage_failed" });
});
it("a failed Yjs delete keeps cache and draft and reveals no browser error", async () => {
  vi.mocked(indexedDB.databases).mockResolvedValue([{ name: "target-yjs" }]);
  vi.mocked(indexedDB.deleteDatabase).mockImplementation(() => {
    const request: any = {};
    queueMicrotask(() => request.onerror());
    return request;
  });
  await expect(cleanupConvertedNoteCopies(input, load)).rejects.toMatchObject({ code: "storage_failed" });
  expect(clearCachedNoteForEncryptionConversion).not.toHaveBeenCalled();
  expect(localStorage.getItem("nowen-draft-note")).toBe("private-source");
});
it("a recreated collaboration database fails final verification", async () => {
  vi.mocked(indexedDB.databases).mockReset().mockResolvedValueOnce([]).mockResolvedValue([{ name: "target-yjs" }]);
  await expect(cleanupConvertedNoteCopies(input, load)).rejects.toMatchObject({ code: "storage_failed" });
});
