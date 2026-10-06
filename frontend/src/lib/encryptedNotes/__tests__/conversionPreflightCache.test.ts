import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openDB } from "idb";
import { getNote, inspectCachedNotePresence, setCurrentUser } from "../../localStore";

vi.mock("idb", () => ({ openDB: vi.fn() }));
const getKey = vi.fn(); const close = vi.fn();
beforeEach(() => {
  vi.resetAllMocks(); localStorage.clear(); setCurrentUser(null);
  vi.mocked(openDB).mockResolvedValue({ getKey, close, get: vi.fn().mockResolvedValue(undefined) } as unknown as import("idb").IDBPDatabase<unknown>);
  getKey.mockResolvedValue("note");
});
afterEach(() => setCurrentUser(null));
it("an uninitialized cache remains unknown without opening or creating a database", async () => {
  setCurrentUser("owner");
  expect(await inspectCachedNotePresence("note", "owner")).toBeNull();
  expect(openDB).not.toHaveBeenCalled();
});
it("uses only the existing account cache and reads keys without loading note bodies", async () => {
  setCurrentUser("owner"); await getNote("initialize");
  const connection = await vi.mocked(openDB).mock.results[0].value;
  vi.mocked(connection.get).mockClear();
  expect(await inspectCachedNotePresence("note", "owner")).toBe(true);
  expect(getKey).toHaveBeenCalledWith("notes", "note"); expect(connection.get).not.toHaveBeenCalled();
  expect(await inspectCachedNotePresence("note", "other")).toBeNull();
  getKey.mockResolvedValue(undefined);
  expect(await inspectCachedNotePresence("note", "owner")).toBe(false);
  expect(openDB).toHaveBeenCalledTimes(1);
});
it("read errors propagate as unknown-worthy failures rather than cache absence", async () => {
  setCurrentUser("owner"); await getNote("initialize");
  getKey.mockRejectedValue(new Error("IndexedDB read failed"));
  await expect(inspectCachedNotePresence("note", "owner")).rejects.toThrow("IndexedDB read failed");
});
it("an account switch during a cache read discards the old presence result", async () => {
  setCurrentUser("owner"); await getNote("initialize");
  let resolve!: (value: string) => void;
  getKey.mockImplementation(() => new Promise((done) => { resolve = done; }));
  const pending = inspectCachedNotePresence("note", "owner");
  await Promise.resolve(); setCurrentUser("other"); resolve("note");
  expect(await pending).toBeNull();
});
