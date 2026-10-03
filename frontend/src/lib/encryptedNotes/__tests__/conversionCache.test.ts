import { beforeEach, expect, it, vi } from "vitest";
import type { Note } from "@/types";
vi.mock("@/lib/api", () => ({ api: {}, getCurrentWorkspace: () => "personal" }));
vi.mock("@/lib/localStore", () => ({ isReady: () => true, putNote: vi.fn() }));
import { putNote } from "../../localStore";
import { cacheNoteContent } from "../../syncEngine";
import { getOfflineQueueStorageKey } from "../../offlineScope";
import { markConvertedNote } from "../conversionBarrier";
import vector from "./fixtures/envelope-v1.json";

const original = { id: "note", userId: "owner", notebookId: "book", title: "title", version: 1, content: "private source", contentText: "private source", contentFormat: "markdown", createdAt: "2026-10-03", updatedAt: "2026-10-03" } as Note;
beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); });
it("a deferred cache callback cannot write a former account's body into the current cache", async () => {
  const scope = getOfflineQueueStorageKey();
  localStorage.setItem("nowen-server-url", "https://other.example.test");
  await cacheNoteContent(original, scope);
  expect(putNote).not.toHaveBeenCalled();
});
it("a deferred cache callback rejects the converted source but still caches confirmed ciphertext", async () => {
  const scope = getOfflineQueueStorageKey();
  markConvertedNote("note", 2, scope);
  await cacheNoteContent(original, scope);
  expect(putNote).not.toHaveBeenCalled();
  const encrypted = { ...original, version: 2, contentFormat: "encrypted-note-v1", contentText: "", content: JSON.stringify(vector.envelope) };
  await cacheNoteContent(encrypted, scope);
  expect(putNote).toHaveBeenCalledWith({ ...encrypted, __detailCached: true });
});
