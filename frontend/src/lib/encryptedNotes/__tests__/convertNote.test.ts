import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Note } from "@/types";
import vector from "./fixtures/envelope-v2.json";
import { checkNoteConversion, convertNote, cancelNoteConversion } from "../convertNote";
import { readPendingConversion } from "../conversionPending";
import { assertConversionMutation, convertedNoteVersion } from "../conversionBarrier";
import { getOfflineQueueStorageKey } from "../../offlineScope";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), open: vi.fn(), close: vi.fn(), cache: vi.fn(), clearCache: vi.fn(), create: vi.fn(), historyOpen: vi.fn() }));
vi.mock("@/lib/api", () => ({ getBaseUrl: () => "https://server.test/api" }));
vi.mock("../../authSession", () => ({ fetchWithAuthRefresh: mocks.fetch, getAccessToken: () => localStorage.getItem("nowen-token") }));
vi.mock("../../knowledgeTreePassword", () => ({ folderUnlockRequestHeaders: () => ({}) }));
vi.mock("../../localStore", () => ({ getCurrentUserId: () => "owner", inspectCachedNoteSource: mocks.cache, inspectCachedNotePresence: async () => false, clearCachedNoteForEncryptionConversion: mocks.clearCache }));
vi.mock("../../yjsProvider", () => ({ getYjsPersistenceName: () => "target-yjs" }));
vi.mock("../../offlineQueue", async (original) => ({ ...await original<typeof import("../../offlineQueue")>(), isOfflineQueueFlushing: () => false }));
vi.mock("../sessionV2Client", () => ({ EncryptedContentV2Session: class {
  create = mocks.create; open = mocks.open; close = mocks.close;
  encryptHistory = vi.fn(async () => vector.history);
  decryptHistory = mocks.historyOpen;
} }));
const privateBody = "PRIVATE_CONVERSION_CURRENT";
const oldBody = "PRIVATE_CONVERSION_HISTORY";
const content = JSON.stringify(vector.envelope);
const note = { id: "note", userId: "owner", title: "Public", version: 1, content: privateBody, contentFormat: "markdown", contentText: privateBody } as Note;
const history = [{ id: vector.history.historyId, version: vector.history.sourceVersion, content: oldBody, contentFormat: "markdown", changeSummary: "PRIVATE_CHANGE_SUMMARY" }];
const source = () => ({ canConvert: true, blockers: [], note, history });
const committed = () => ({ canConvert: false, blockers: ["already_encrypted"], note: { ...note, content, contentText: "", contentFormat: "encrypted-note-v2", version: 2 },
  history: [{ ...history[0], content: JSON.stringify(vector.history), contentFormat: "encrypted-history-v2" }, { id: "current", version: 2, content, contentFormat: "encrypted-note-v2" }] });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear();
  localStorage.setItem("nowen-token", `header.${btoa(JSON.stringify({ userId: "owner" }))}.signature`);
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("navigator", { locks: { request: vi.fn(async (_name, _options, callback) => callback({})) } });
  vi.stubGlobal("indexedDB", { databases: async () => [] });
  mocks.cache.mockResolvedValue(true); mocks.clearCache.mockResolvedValue(undefined);
  mocks.create.mockResolvedValue(vector.envelope);
  mocks.open.mockResolvedValue({ documentSchemaVersion: 1, content: privateBody, attachments: [] });
  mocks.historyOpen.mockResolvedValue({ document: { documentSchemaVersion: 1, content: oldBody, attachments: [] }, changeSummary: history[0].changeSummary });
  let submitted = false;
  mocks.fetch.mockImplementation(async (_url, init) => {
    if (init.method === "POST") { submitted = true; return json({ noteId: note.id, version: 2 }); }
    return json(submitted ? committed() : source());
  });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("waits for this editor's server collaboration state to settle without a manual recheck", async () => {
  vi.useFakeTimers();
  mocks.fetch.mockResolvedValueOnce(json({ canConvert: false, blockers: ["collaboration_room", "active_collaboration"] })).mockResolvedValueOnce(json(source()));
  const check = checkNoteConversion(note, new AbortController().signal);
  const completed = expect(check).resolves.toBeUndefined();
  await vi.advanceTimersByTimeAsync(200); await completed;
  expect(mocks.fetch).toHaveBeenCalledTimes(2); expect(mocks.create).not.toHaveBeenCalled();
});

it("still refuses persistent server collaboration and never submits or deletes copies", async () => {
  vi.useFakeTimers(); mocks.fetch.mockImplementation(async () => json({ canConvert: false, blockers: ["collaboration_room"] }));
  const check = checkNoteConversion(note, new AbortController().signal);
  const rejected = expect(check).rejects.toMatchObject({ blockers: ["collaboration_room"] });
  await vi.advanceTimersByTimeAsync(5_000); await rejected;
  expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.clearCache).not.toHaveBeenCalled();
});

it("cancels while waiting for server teardown without another source read", async () => {
  vi.useFakeTimers(); mocks.fetch.mockImplementation(async () => json({ canConvert: false, blockers: ["active_collaboration"] }));
  const controller = new AbortController();
  const rejected = expect(checkNoteConversion(note, controller.signal)).rejects.toMatchObject({ code: "scope_changed" });
  await vi.advanceTimersByTimeAsync(0); controller.abort(); await rejected;
  await vi.advanceTimersByTimeAsync(5_000);
  expect(mocks.fetch).toHaveBeenCalledTimes(1); expect(mocks.clearCache).not.toHaveBeenCalled();
});

it("reports an unsupported history immediately even alongside transient collaboration", async () => {
  mocks.fetch.mockResolvedValue(json({ canConvert: false, blockers: ["unsupported_history", "collaboration_room"] }));
  await expect(checkNoteConversion(note, new AbortController().signal)).rejects.toMatchObject({ blockers: ["unsupported_history", "collaboration_room"] });
  expect(mocks.fetch).toHaveBeenCalledTimes(1);
});

it("checks source/cache/drafts without writes and refuses a newer editor snapshot", async () => {
  await checkNoteConversion(note, new AbortController().signal);
  expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.clearCache).not.toHaveBeenCalled();
  expect(mocks.fetch.mock.calls[0][1].cache).toBe("no-store");
  await expect(checkNoteConversion({ ...note, content: "newer draft" }, new AbortController().signal)).rejects.toMatchObject({ code: "pending_writes" });
});
it("verifies body and every history locally, submits only ciphertext and clears only confirmed copies", async () => {
  localStorage.setItem("nowen-draft-note", JSON.stringify({ noteId: "note", content: note.content, title: note.title }));
  localStorage.setItem("nowen-draft-index", '["note","other"]'); localStorage.setItem("nowen-draft-other", "keep");
  const result = await convertNote(note.id, "secret-password", new AbortController().signal, note);
  expect(result.contentFormat).toBe("encrypted-note-v2");
  expect(mocks.open).toHaveBeenCalled(); expect(mocks.historyOpen).toHaveBeenCalled();
  const post = mocks.fetch.mock.calls.find(([, init]) => init.method === "POST")![1];
  expect(post.body).not.toContain(privateBody); expect(post.body).not.toContain(oldBody); expect(post.body).not.toContain("PRIVATE_CHANGE_SUMMARY"); expect(post.body).not.toContain("secret-password");
  expect(JSON.parse(post.body).encryptedHistory[0].sourceDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(mocks.clearCache).toHaveBeenCalledTimes(1); expect(localStorage.getItem("nowen-draft-note")).toBeNull(); expect(localStorage.getItem("nowen-draft-other")).toBe("keep");
  expect(readPendingConversion(note.id)).toBeNull(); expect(convertedNoteVersion(note.id)).toBe(2);
  expect(mocks.close).toHaveBeenCalledTimes(2);
});
it("a bad local decrypt check never submits, records a pending operation or deletes the source", async () => {
  mocks.open.mockResolvedValue({ documentSchemaVersion: 1, content: "wrong content", attachments: [] });
  await expect(convertNote(note.id, "secret-password", new AbortController().signal, note)).rejects.toMatchObject({ code: "VERIFICATION_FAILED" });
  expect(mocks.fetch.mock.calls.some(([, init]) => init.method === "POST")).toBe(false);
  expect(readPendingConversion(note.id)).toBeNull(); expect(mocks.clearCache).not.toHaveBeenCalled();
});
it.each(["scoped", "legacy"])("a %s queued write blocks conversion without discarding it", async (kind) => {
  const key = kind === "scoped" ? getOfflineQueueStorageKey() : "nowen-offline-queue";
  localStorage.setItem(key, '[{"noteId":"note","body":{"content":"newer plaintext"}}]');
  await expect(convertNote(note.id, "secret-password", new AbortController().signal, note)).rejects.toMatchObject({ code: "pending_writes" });
  expect(mocks.create).not.toHaveBeenCalled(); expect(localStorage.getItem(key)).toContain("newer plaintext");
});
it("a newer cached body blocks conversion", async () => {
  mocks.cache.mockResolvedValue(false);
  await expect(convertNote(note.id, "secret-password", new AbortController().signal, note)).rejects.toMatchObject({ code: "pending_writes" });
  expect(mocks.create).not.toHaveBeenCalled();
});
it("resumes cleanup after another device edited ciphertext, proving the retained conversion and complete history", async () => {
  mocks.clearCache.mockRejectedValueOnce(new Error("storage failed"));
  await expect(convertNote(note.id, "secret-password", new AbortController().signal, note)).rejects.toMatchObject({ code: "storage_failed" });
  const newer = committed(); newer.note.version = 3;
  newer.note.content = JSON.stringify({ ...vector.envelope, payload: { ...vector.envelope.payload, iv: btoa(String.fromCharCode(...new Uint8Array(12).fill(7))) } });
  mocks.fetch.mockImplementation(async () => json(newer));
  expect((await convertNote(note.id, "", new AbortController().signal)).version).toBe(3);
  expect(readPendingConversion(note.id)).toBeNull();
});
it("cancellation clears only a server-confirmed pending operation and preserves the local draft", async () => {
  mocks.fetch.mockImplementation(async (_url, init) => init.method === "POST" ? Promise.reject(new TypeError("network")) : json(source()));
  await expect(convertNote(note.id, "secret-password", new AbortController().signal, note)).rejects.toThrow();
  localStorage.setItem("nowen-draft-note", "keep newer edit");
  mocks.fetch.mockResolvedValue(json({ cancelled: true }));
  await cancelNoteConversion(note.id, new AbortController().signal);
  expect(mocks.fetch.mock.calls.at(-1)![0]).toMatch(/\/cancel$/);
  expect(readPendingConversion(note.id)).toBeNull(); expect(localStorage.getItem("nowen-draft-note")).toBe("keep newer edit");
  expect(mocks.clearCache).not.toHaveBeenCalled();
});
it("quota failure occurs before POST and before deleting any source", async () => {
  vi.spyOn(Storage.prototype, "setItem").mockImplementation((key) => { if (key.startsWith("nowen-encryption-pending:")) throw new Error("quota"); });
  await expect(convertNote(note.id, "secret-password", new AbortController().signal, note)).rejects.toMatchObject({ code: "storage_failed" });
  expect(mocks.fetch.mock.calls.some(([, init]) => init.method === "POST")).toBe(false); expect(mocks.clearCache).not.toHaveBeenCalled();
});
it("an uncertain response persists ciphertext only and rejects late plaintext; recovery resumes cleanup without a password", async () => {
  let submitted = false;
  mocks.fetch.mockImplementation(async (_url, init) => {
    if (init.method === "POST") { submitted = true; throw new TypeError("network"); }
    if (submitted) throw new TypeError("network");
    return json(source());
  });
  await expect(convertNote(note.id, "secret-password", new AbortController().signal, note)).rejects.toThrow();
  const pending = readPendingConversion(note.id)!; expect(pending.content).toBe(content);
  expect(JSON.stringify(pending)).not.toContain(privateBody); expect(JSON.stringify(pending)).not.toContain("secret-password");
  expect(() => assertConversionMutation(note.id, { content: privateBody, contentFormat: "markdown" })).toThrow();
  expect(mocks.clearCache).not.toHaveBeenCalled();
  mocks.fetch.mockImplementation(async () => json(committed()));
  await convertNote(note.id, "", new AbortController().signal);
  expect(readPendingConversion(note.id)).toBeNull(); expect(mocks.clearCache).toHaveBeenCalledTimes(1);
});
it("a definitive server rejection releases the pending barrier and preserves the source", async () => {
  mocks.fetch.mockImplementation(async (_url, init) => init.method === "POST" ? json({ code: "VERSION_CONFLICT" }, 409) : json(source()));
  await expect(convertNote(note.id, "secret-password", new AbortController().signal, note)).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  expect(readPendingConversion(note.id)).toBeNull(); expect(mocks.clearCache).not.toHaveBeenCalled();
});
it("readback with a missing encrypted history refuses cleanup and retains the retry record", async () => {
  let submitted = false;
  mocks.fetch.mockImplementation(async (_url, init) => {
    if (init.method === "POST") { submitted = true; return json({ version: 2 }); }
    return json(submitted ? { ...committed(), history: [] } : source());
  });
  await expect(convertNote(note.id, "secret-password", new AbortController().signal, note)).rejects.toMatchObject({ code: "not_committed" });
  expect(readPendingConversion(note.id)).not.toBeNull(); expect(mocks.clearCache).not.toHaveBeenCalled();
});
