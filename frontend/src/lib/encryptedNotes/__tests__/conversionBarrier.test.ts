import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { assertConversionNote, convertedNoteVersion, markConvertedNote, subscribeConversionInvalidation } from "../conversionBarrier";
import { getOfflineQueueStorageKey } from "../../offlineScope";
import { enqueue, flushQueue, getQueue } from "../../offlineQueue";
import { loadDraft, saveDraft } from "../../draftStorage";
import { api } from "../../api";
import { readNotesList } from "../../offlineRead";
import vector from "./fixtures/envelope-v1.json";

const note = { id: "note", version: 2, contentFormat: "encrypted-note-v1", contentText: "", content: JSON.stringify(vector.envelope) };
const original = { ...note, version: 1, contentFormat: "markdown", contentText: "private source", content: "private source" };
const draft = { noteId: "note", editorMode: "md" as const, content: original.content, contentText: original.contentText, title: "title", baseVersion: 1, savedAt: Date.now() };
beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("nowen-token", `header.${btoa(JSON.stringify({ userId: "owner" }))}.signature`);
  localStorage.setItem("nowen-server-url", "https://notes.example.test");
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("retains only a monotonic metadata version and rejects stale details, text summaries and forged envelopes", () => {
  const scope = getOfflineQueueStorageKey();
  markConvertedNote("note", 2, scope); markConvertedNote("note", 1, scope);
  expect(convertedNoteVersion("note")).toBe(2);
  expect(localStorage.getItem(`nowen-encrypted-converted:v1:${encodeURIComponent(scope)}:note`)).toBe("2");
  for (const copy of [original, { ...note, version: 1 }, { ...note, contentText: "private source" }, { ...note, content: "private source" }]) {
    expect(() => assertConversionNote(copy)).toThrow("converted_note");
  }
  expect(() => assertConversionNote(note)).not.toThrow();
  expect(() => assertConversionNote({ ...note, content: "" })).not.toThrow();
});

it("shares markers across token refresh but isolates another account or server", () => {
  markConvertedNote("note", 2, getOfflineQueueStorageKey());
  localStorage.setItem("nowen-token", `refresh.${btoa(JSON.stringify({ userId: "owner" }))}.other-signature`);
  expect(convertedNoteVersion("note")).toBe(2);
  localStorage.setItem("nowen-token", `header.${btoa(JSON.stringify({ userId: "other" }))}.signature`);
  expect(convertedNoteVersion("note")).toBeNull();
  localStorage.setItem("nowen-server-url", "https://other.example.test");
  expect(() => assertConversionNote(original)).not.toThrow();
});

it("late autosaves cannot restore drafts or enqueue plaintext, while encrypted updates remain available", () => {
  saveDraft(draft);
  markConvertedNote("note", 2, getOfflineQueueStorageKey());
  expect(loadDraft("note")).toBeNull();
  expect(() => saveDraft(draft)).toThrow("converted_note");
  expect(() => enqueue({ noteId: "note", type: "updateNote", method: "PUT", url: "/notes/note", body: original })).toThrow("converted_note");
  expect(getQueue()).toEqual([]);
  enqueue({ noteId: "note", type: "updateNote", method: "PUT", url: "/notes/note", body: note });
  expect(getQueue()).toHaveLength(1);
});

it("retains a legacy late queue entry for explicit recovery and never replays its plaintext", async () => {
  markConvertedNote("note", 2, getOfflineQueueStorageKey());
  localStorage.setItem(getOfflineQueueStorageKey(), JSON.stringify([{ id: "legacy", noteId: "note", type: "updateNote", method: "PUT", url: "/notes/note", body: original, retryCount: 0, enqueuedAt: Date.now() }]));
  const fetch = vi.fn();
  await flushQueue(fetch);
  expect(fetch).not.toHaveBeenCalled();
  expect(getQueue()[0]).toMatchObject({ blocked: true, retryable: false, errorCode: "CONVERTED_NOTE", body: original });
});

it("invalidates only the current scope from same-window and cross-window confirmation", () => {
  const listener = vi.fn(); const unsubscribe = subscribeConversionInvalidation(listener);
  try {
    const scope = getOfflineQueueStorageKey();
    markConvertedNote("note", 2, scope);
    window.dispatchEvent(new StorageEvent("storage", { key: `nowen-encrypted-converted:v1:${encodeURIComponent(scope)}:note`, newValue: "2" }));
    markConvertedNote("other", 2, "other-scope");
    expect(listener.mock.calls).toEqual([["note"], ["note"]]);
  } finally { unsubscribe(); }
});

it("fails closed when a persisted marker is corrupt", () => {
  localStorage.setItem(`nowen-encrypted-converted:v1:${encodeURIComponent(getOfflineQueueStorageKey())}:note`, "private invalid marker");
  expect(() => assertConversionNote(original)).toThrow("storage_failed");
  expect(() => saveDraft(draft)).toThrow("storage_failed");
});

it.each(["updateNote", "updateNoteConfirmed"] as const)("%s never sends or queues a late plaintext mutation", async (method) => {
  markConvertedNote("note", 2, getOfflineQueueStorageKey());
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  await expect(api[method]("note", original)).rejects.toMatchObject({ code: "converted_note" });
  expect(fetch).not.toHaveBeenCalled(); expect(getQueue()).toEqual([]);
});

it.each(["getNote", "getNotes", "updateNoteConfirmed"] as const)("%s discards a late response after account changes", async (method) => {
  let resolve!: (value: unknown) => void;
  const fetch = vi.fn(() => new Promise((ready) => { resolve = ready; })); vi.stubGlobal("fetch", fetch);
  const pending = method === "getNote" ? api.getNote("note") : method === "getNotes" ? api.getNotes() : api.updateNoteConfirmed("note", original);
  await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
  localStorage.setItem("nowen-token", `header.${btoa(JSON.stringify({ userId: "other" }))}.signature`);
  resolve(new Response(JSON.stringify(original), { status: 200, headers: { "Content-Type": "application/json" } }));
  await expect(pending).rejects.toMatchObject({ code: "scope_changed" });
  expect(getQueue()).toEqual([]);
});

it("late list responses omit converted plaintext summaries but retain unrelated notes", async () => {
  let resolve!: (value: Awaited<ReturnType<typeof api.getNotes>>) => void;
  const pending = readNotesList(() => new Promise((ready) => { resolve = ready; }));
  markConvertedNote("note", 2, getOfflineQueueStorageKey());
  resolve([original, { ...original, id: "other" }] as unknown as Awaited<ReturnType<typeof api.getNotes>>);
  await expect(pending).resolves.toEqual([{ ...original, id: "other" }]);
});

it("a remote confirmation makes a late plaintext GET fail without offline fallback", async () => {
  let resolve!: (value: unknown) => void;
  const fetch = vi.fn(() => new Promise((ready) => { resolve = ready; })); vi.stubGlobal("fetch", fetch);
  const pending = api.getNote("note");
  await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
  markConvertedNote("note", 2, getOfflineQueueStorageKey());
  resolve(new Response(JSON.stringify(original), { headers: { "Content-Type": "application/json" } }));
  await expect(pending).rejects.toMatchObject({ code: "converted_note" });
});

it("a late failed save cannot enqueue the old account's plaintext into the new account", async () => {
  let reject!: (reason: unknown) => void;
  const fetch = vi.fn(() => new Promise((_ready, fail) => { reject = fail; })); vi.stubGlobal("fetch", fetch);
  const scope = getOfflineQueueStorageKey();
  const pending = api.updateNote("note", original);
  await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
  localStorage.setItem("nowen-token", `header.${btoa(JSON.stringify({ userId: "other" }))}.signature`);
  reject(new TypeError("Failed to fetch"));
  await expect(pending).rejects.toMatchObject({ code: "scope_changed" });
  expect(getQueue()).toEqual([]); expect(localStorage.getItem(scope)).toBeNull();
});

it("a late replay response cannot dequeue or rewrite another account's queue", async () => {
  enqueue({ noteId: "note", type: "updateNote", method: "PUT", url: "/notes/note", body: original });
  const scope = getOfflineQueueStorageKey(); const before = localStorage.getItem(scope);
  let resolve!: (value: { ok: boolean; status: number }) => void;
  const fetch = vi.fn(() => new Promise<{ ok: boolean; status: number }>((ready) => { resolve = ready; }));
  const pending = flushQueue(fetch);
  await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
  localStorage.setItem("nowen-token", `header.${btoa(JSON.stringify({ userId: "other" }))}.signature`);
  resolve({ ok: true, status: 200 });
  await expect(pending).rejects.toMatchObject({ code: "scope_changed" });
  expect(localStorage.getItem(scope)).toBe(before); expect(getQueue()).toEqual([]);
});
