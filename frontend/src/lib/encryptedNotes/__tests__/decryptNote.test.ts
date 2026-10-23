// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import fixture from "./fixtures/envelope-v1.json";
import type { Note } from "@/types";
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), open: vi.fn(), read: vi.fn(), close: vi.fn(), clear: vi.fn(), pending: vi.fn(), scope: "owner-a" }));
vi.mock("@/lib/api", () => ({ getBaseUrl: () => "https://notes.example/api" }));
vi.mock("@/lib/authSession", () => ({ fetchWithAuthRefresh: mocks.fetch, getAccessToken: () => "session-token" }));
vi.mock("@/lib/offlineScope", () => ({ getOfflineQueueStorageKey: () => mocks.scope }));
vi.mock("@/lib/knowledgeTreePassword", () => ({ folderUnlockRequestHeaders: () => ({}) }));
vi.mock("../conversionCleanup", () => ({ assertNoPendingConversionWrites: mocks.pending }));
vi.mock("../conversionPending", () => ({ readPendingConversion: () => null }));
vi.mock("../conversionBarrier", () => ({ clearDecryptedNoteBarrier: mocks.clear }));
vi.mock("../conversionCoordination", async () => {
  const actual = await vi.importActual<typeof import("../conversionCoordination")>("../conversionCoordination");
  return { ...actual, withConversionCleanupLease: async (_id: string, operation: () => Promise<unknown>) => operation() };
});
vi.mock("../noteSession", () => ({ EncryptedNoteSession: class {
  open = mocks.open; readVersion = mocks.read; close = mocks.close;
} }));
import { decryptNotePermanently } from "../decryptNote";
import { EncryptedContentError } from "../envelope";

const note = { id: "note-id", userId: "owner", title: "Keep title", content: JSON.stringify(fixture.envelope), contentFormat: "encrypted-note-v1", version: 3 } as Note;
const plain = "# Restored body";
const storedHistory = { id: "history-id", version: 2, content: note.content, contentFormat: note.contentFormat, changeSummary: null };
let source: { note: Note; history: Array<{ id: string; version?: number; content: string; contentFormat?: string; changeSummary?: string | null }> };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
beforeEach(() => {
  vi.clearAllMocks(); mocks.scope = "owner-a";
  source = { note: { ...note }, history: [{ ...storedHistory }] };
  mocks.open.mockResolvedValue(plain);
  mocks.read.mockResolvedValue({ content: "Old body", format: "markdown", changeSummary: "Old change" });
  mocks.clear.mockImplementation(() => {}); mocks.pending.mockImplementation(() => {});
  mocks.fetch.mockImplementation(async (_url: string, init: RequestInit) => {
    if (init.method !== "POST") return json(source);
    const payload = JSON.parse(init.body as string);
    source = { note: { ...note, content: payload.content, contentFormat: payload.contentFormat, version: note.version + 1 }, history: payload.decryptedHistory };
    return json(source.note);
  });
});
const run = (assertCurrent = () => {}) => decryptNotePermanently(note, fixture.passphrase, new AbortController().signal, assertCurrent);
describe("permanent note decryption", () => {
  it("verifies the password in a Worker and confirms the complete ordinary target before clearing the barrier", async () => {
    const saved = await run();
    expect(saved.content).toBe(plain); expect(saved.contentFormat).toBe("markdown");
    const posted = mocks.fetch.mock.calls.find(([, init]) => init.method === "POST")!;
    const payload = JSON.parse(posted[1].body);
    expect(payload.confirmPlaintext).toBe(true);
    expect(payload.decryptedHistory[0]).toMatchObject({ id: "history-id", content: "Old body", contentFormat: "markdown", changeSummary: "Old change" });
    expect(posted[1].body).not.toContain(fixture.passphrase);
    expect(posted[1].body).not.toContain("wrappedKey");
    expect(mocks.clear).toHaveBeenCalledWith(note.id, 4, "owner-a"); expect(mocks.close).toHaveBeenCalledOnce();
  });
  it("wrong passwords cannot read or overwrite server content", async () => {
    mocks.open.mockRejectedValueOnce(new EncryptedContentError("unlock-failed"));
    await expect(run()).rejects.toMatchObject({ code: "unlock-failed" });
    expect(mocks.fetch).not.toHaveBeenCalled(); expect(mocks.clear).not.toHaveBeenCalled(); expect(mocks.close).toHaveBeenCalledOnce();
  });
  it("rejects concurrent ciphertext changes without submitting plaintext (DCC-004)", async () => {
    source.note.version++;
    await expect(run()).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    expect(mocks.fetch.mock.calls.every(([, init]) => init.method === "GET")).toBe(true);
    expect(mocks.clear).not.toHaveBeenCalled();
  });
  it("rejects account changes while decrypting (DCC-006)", async () => {
    mocks.open.mockImplementationOnce(async () => { mocks.scope = "owner-b"; return plain; });
    await expect(run()).rejects.toMatchObject({ code: "scope_changed" });
    expect(mocks.fetch).not.toHaveBeenCalled(); expect(mocks.clear).not.toHaveBeenCalled();
  });
  it("rechecks current editor permissions and pending writes before posting", async () => {
    let writable = true;
    mocks.read.mockImplementationOnce(async () => { writable = false; return { content: "Old body", format: "markdown", changeSummary: null }; });
    await expect(run(() => { if (!writable) throw new Error("permission changed"); })).rejects.toThrow("permission changed");
    expect(mocks.fetch.mock.calls.every(([, init]) => init.method === "GET")).toBe(true);
  });
  it("recovers a lost commit response by reading the exact ordinary body and history", async () => {
    const normal = mocks.fetch.getMockImplementation()!;
    mocks.fetch.mockImplementation(async (url, init) => {
      const response = await normal(url, init);
      if (init.method === "POST") throw new TypeError("lost response");
      return response;
    });
    expect((await run()).content).toBe(plain); expect(mocks.fetch).toHaveBeenCalledTimes(3); expect(mocks.clear).toHaveBeenCalledOnce();
  });
  it("a failed server write preserves the encrypted barrier and does not queue plaintext (DCC-003)", async () => {
    mocks.fetch.mockImplementation(async (_url, init) => init.method === "POST" ? json({ code: "DECRYPTION_FAILED" }, 500) : json(source));
    await expect(run()).rejects.toMatchObject({ code: "DECRYPTION_FAILED" });
    expect(source.note.contentFormat).toBe("encrypted-note-v1"); expect(mocks.clear).not.toHaveBeenCalled();
  });
});
