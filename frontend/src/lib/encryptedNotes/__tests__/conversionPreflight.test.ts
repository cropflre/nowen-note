import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { getOfflineQueueStorageKey } from "../../offlineQueue";
import { inspectCachedNotePresence } from "../../localStore";
import { getYjsPersistenceName } from "../../yjsProvider";
import { inspectBrowserConversionCopies } from "../conversionPreflight";

vi.mock("../../localStore", () => ({ inspectCachedNotePresence: vi.fn() }));
vi.mock("../../yjsProvider", () => ({ getYjsPersistenceName: vi.fn((note, user) => `y-${user}-${note}`) }));
beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("nowen-token", `header.${btoa(JSON.stringify({ userId: "owner" }))}.signature`);
  vi.mocked(inspectCachedNotePresence).mockResolvedValue(false);
  vi.stubGlobal("indexedDB", { databases: vi.fn(async () => []) });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("reads counts and presence without pruning drafts/queues or opening IndexedDB", async () => {
  localStorage.setItem("nowen-draft-note", "private-source");
  localStorage.setItem(getOfflineQueueStorageKey(), JSON.stringify([
    { noteId: "note", body: { content: "private-source" }, enqueuedAt: 0 },
    { noteId: "other", body: { content: "private-source" } },
  ]));
  localStorage.setItem("nowen-offline-queue", '[{"noteId":"note"}]');
  vi.mocked(inspectCachedNotePresence).mockResolvedValue(true);
  vi.mocked(indexedDB.databases).mockResolvedValue([{ name: "y-owner-note" }, { name: "y-other-note" }]);
  const before = { ...localStorage };
  const set = vi.spyOn(Storage.prototype, "setItem"); const remove = vi.spyOn(Storage.prototype, "removeItem");
  const result = await inspectBrowserConversionCopies("note", "owner");
  expect(result).toEqual({ draft: true, queue: 1, cache: true, collaboration: true });
  expect(JSON.stringify(result)).not.toContain("private-source");
  expect(inspectCachedNotePresence).toHaveBeenCalledWith("note", "owner");
  expect(getYjsPersistenceName).toHaveBeenCalledWith("note", "owner");
  expect({ ...localStorage }).toEqual(before); expect(set).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
});
it("counts only the current account queue and scoped collaboration database", async () => {
  const oldKey = getOfflineQueueStorageKey();
  localStorage.setItem(oldKey, '[{"noteId":"note"}]');
  localStorage.setItem("nowen-token", `header.${btoa(JSON.stringify({ userId: "other" }))}.signature`);
  vi.mocked(indexedDB.databases).mockResolvedValue([{ name: "y-owner-note" }]);
  expect(await inspectBrowserConversionCopies("note", "other")).toEqual({ draft: false, queue: 0, cache: false, collaboration: false });
  expect(localStorage.getItem(oldKey)).toBe('[{"noteId":"note"}]');
});
it.each(["not-json", "{}", '[{"body":{}}]'])("invalid queue %s is unknown instead of zero", async (queue) => {
  localStorage.setItem(getOfflineQueueStorageKey(), queue);
  expect((await inspectBrowserConversionCopies("note", "owner")).queue).toBeNull();
});
it("unavailable storage and failed cache reads remain unknown", async () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("unavailable"); });
  vi.mocked(inspectCachedNotePresence).mockRejectedValue(new Error("unavailable"));
  vi.mocked(indexedDB.databases).mockRejectedValue(new Error("unavailable"));
  expect(await inspectBrowserConversionCopies("note", "owner")).toEqual({ draft: null, queue: null, cache: null, collaboration: null });
});
it("browsers without database enumeration cannot confirm collaboration cache absence", async () => {
  vi.stubGlobal("indexedDB", {});
  expect((await inspectBrowserConversionCopies("note", "owner")).collaboration).toBeNull();
});
