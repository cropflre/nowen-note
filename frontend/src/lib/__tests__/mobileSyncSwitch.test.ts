import { createRequire } from "node:module";
import type { SQLInputValue } from "node:sqlite";
import { randomUUID, webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeMobileLocalFirstRuntime } from "../mobileLocalFirstRuntime";
import { connectSyncServer, disableSync, fetchSyncSettings } from "../syncLocalApi";
import { getLocalRepository } from "../localRepository";
import { openNativeDatabase } from "../nativeDatabase";
import { isMobileSyncEnabled } from "../mobileSyncStatus";
import { installMobileLocalModuleBridge } from "../mobileLocalModuleBridge";
import { api } from "../api";

let DatabaseSync: typeof import("node:sqlite").DatabaseSync | undefined;
try { ({ DatabaseSync } = createRequire(import.meta.url)("node:sqlite")); } catch { /* Run on Node >=22.13. */ }
const mocks = vi.hoisted(() => ({
  databases: new Map<string, any>(),
  createDatabase: null as null | (() => any),
  credentials: new Map<string, string>(),
  listeners: new Map<string, (...args: any[]) => void>(),
  fetch: vi.fn(),
}));
vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => true, getPlatform: () => "android" } }));
vi.mock("@capacitor-community/sqlite", () => ({
  CapacitorSQLite: {},
  SQLiteConnection: class {
    connections = new Map();
    async checkConnectionsConsistency() { return { result: true }; }
    async isConnection(name: string) { return { result: this.connections.has(name) }; }
    async retrieveConnection(name: string) { return this.connections.get(name); }
    async createConnection(name: string) {
      const sqlite = mocks.databases.get(name) || mocks.createDatabase!();
      mocks.databases.set(name, sqlite);
      const raw = {
        isDBOpen: async () => ({ result: true }),
        execute: async (sql: string) => { sqlite.exec(sql); },
        query: async (sql: string, values: SQLInputValue[] = []) => ({ values: sqlite.prepare(sql).all(...values) }),
        run: async (sql: string, values: SQLInputValue[] = []) => {
          const result = sqlite.prepare(sql).run(...values);
          return { changes: { changes: Number(result.changes), lastId: Number(result.lastInsertRowid) } };
        },
        close: async () => undefined,
      };
      this.connections.set(name, raw); return raw;
    }
    async closeConnection(name: string) { this.connections.delete(name); }
  },
}));
vi.mock("@aparajita/capacitor-secure-storage", () => ({ SecureStorage: {
  setKeyPrefix: async () => undefined,
  get: async (key: string) => mocks.credentials.get(key) ?? null,
  set: async (key: string, value: string) => { mocks.credentials.set(key, value); },
} }));
const listen = async (event: string, callback: (...args: any[]) => void) => {
  mocks.listeners.set(event, callback); return { remove: async () => undefined };
};
vi.mock("@capacitor/app", () => ({ App: { addListener: (...args: Parameters<typeof listen>) => listen(...args) } }));
vi.mock("@capacitor/network", () => ({ Network: {
  getStatus: async () => ({ connected: true, connectionType: "wifi" }),
  addListener: (...args: Parameters<typeof listen>) => listen(...args),
} }));
vi.mock("../serverEndpointResolver", () => ({ ServerEndpointResolver: class {
  resolve = async () => undefined;
  dispose = () => undefined;
} }));
vi.mock("../lanDiscovery", () => ({ getLanDiscovery: () => ({}) }));
vi.mock("../api.impl", () => ({
  getCurrentWorkspace: () => "personal", getServerUrl: () => "https://notes.example.com",
  setCurrentWorkspace: vi.fn(), SERVER_URL_CHANGED_EVENT: "nowen:server-url-changed",
}));
vi.mock("../api", () => ({ getBaseUrl: () => "/api", api: { attachments: {}, files: {}, attachmentFolders: {}, dataFile: {} } }));
vi.mock("../authSession", () => ({ getAccessToken: () => localStorage.getItem("nowen-token") }));
vi.mock("../mobileLocalFirstBridge", () => ({ installMobileLocalFirstBridge: () => () => undefined }));
vi.mock("../mobileLocalAccountMigration", () => ({ migrateMobileLocalAccount: async () => undefined }));
vi.mock("../localStore", () => ({
  getAllNotebooks: async () => [], getAllNotes: async () => [], getAllOfflineAttachmentJobs: async () => [],
  getAllTags: async () => [], getOfflineAttachmentsByNote: async () => [], setCurrentUser: vi.fn(),
}));
vi.mock("../offlineQueue", () => ({ getQueue: () => [], clearQueue: vi.fn() }));
vi.mock("../nativeAttachmentStore", () => ({ createNativeAttachmentStore: async () => ({
  resolveUrl: async () => null,
  save: async ({ attachmentId }: { attachmentId: string }) => ({ path: attachmentId, size: 5, sha256: "hash" }),
  read: async () => new Blob(["image"]),
}) }));

let accountId: string;
let userId: string;
const serverUrl = "https://notes.example.com";
const token = (suffix: string) => `header.${btoa(JSON.stringify({ userId }))}.${suffix}`;
beforeEach(async () => {
  vi.useFakeTimers(); localStorage.clear(); mocks.fetch.mockReset(); mocks.listeners.clear();
  vi.stubGlobal("crypto", webcrypto);
  Object.assign(window, { Capacitor: { isNativePlatform: () => true, getPlatform: () => "android" } });
  mocks.createDatabase = () => new DatabaseSync!(":memory:");
  userId = randomUUID(); accountId = `${serverUrl}\n${userId}`;
  localStorage.setItem("nowen-token", token("initial"));
  mocks.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
    let payload: unknown;
    if (url.endsWith("/scopes")) payload = { items: [{ scopeKey: "personal", workspaceId: null, workspaceName: null, role: null, canWrite: true, accessFingerprint: "test" }] };
    else if (url.includes("/push?")) {
      const { mutations } = JSON.parse(String(init?.body));
      payload = { serverSequence: 1, results: mutations.map(({ mutationId }: { mutationId: string }) => ({ mutationId, status: "applied" })) };
    } else if (url.includes("/changes?")) payload = { resetRequired: false, nextSequence: 1, items: [] };
    else if (url.includes("/ack")) payload = {};
    else if (url.includes("/blob/")) return { ok: init?.method !== "HEAD", status: init?.method === "HEAD" ? 404 : 200 };
    else throw new Error(`Unexpected request: ${url}`);
    return { ok: true, json: async () => payload };
  });
  vi.stubGlobal("fetch", mocks.fetch);
  await initializeMobileLocalFirstRuntime();
  const db = await openNativeDatabase(accountId);
  const [{ id }] = await db.query<{ id: string }>("SELECT id FROM sync_profiles");
  await db.run("INSERT INTO sync_state (profileId,scopeKey,lastSequence,accessFingerprint) VALUES (?,'personal',1,'test')", [id]);
});
afterEach(() => {
  vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals();
  Reflect.deleteProperty(window, "Capacitor");
  for (const sqlite of mocks.databases.values()) sqlite.close();
  mocks.databases.clear();
});

describe.skipIf(!DatabaseSync)("Android sync switch with real SQLite, repository and engine", () => {
  it("keeps edits queued without network traffic across reinitialization, then uploads them on enable", async () => {
    await disableSync();
    const repo = getLocalRepository()!;
    const book = await repo.notebooks.create({ id: randomUUID(), name: "Book" });
    const note = await repo.notes.create({ id: randomUUID(), notebookId: book.id, title: "Local", content: "first" });
    await repo.notes.update(note.id, { content: "edited while disabled" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(isMobileSyncEnabled()).toBe(false);
    const db = await openNativeDatabase(accountId);
    expect(await db.query("SELECT * FROM sync_outbox")).toHaveLength(3);

    // Same account/database, new runtime as after restarting or refreshing credentials.
    localStorage.setItem("nowen-token", token("refreshed"));
    await initializeMobileLocalFirstRuntime();
    expect((await fetchSyncSettings()).mode).toBe("device-only");
    mocks.listeners.get("networkStatusChange")!({ connected: true });
    mocks.listeners.get("appStateChange")!({ isActive: true });
    await getLocalRepository()!.sync.requestSync();
    await vi.advanceTimersByTimeAsync(1000);
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect((await getLocalRepository()!.notes.get(note.id))?.content).toBe("edited while disabled");

    await connectSyncServer({ serverUrl });
    await vi.advanceTimersByTimeAsync(1000);
    expect((await fetchSyncSettings()).mode).toBe("server");
    const push = mocks.fetch.mock.calls.find(([url]) => String(url).includes("/push?"));
    expect(JSON.parse(push![1].body).mutations.map((item: any) => item.payload.content)).toContain("edited while disabled");
    expect(await (await openNativeDatabase(accountId)).query("SELECT * FROM sync_outbox")).toHaveLength(0);
  });
  it("drains more than one batch after re-enabling sync", async () => {
    await disableSync();
    const repo = getLocalRepository()!;
    const book = await repo.notebooks.create({ id: randomUUID(), name: "Book" });
    for (let index = 0; index < 102; index++) await repo.notes.create({ id: randomUUID(), notebookId: book.id, title: `Note ${index}` });
    await connectSyncServer({ serverUrl });
    await vi.advanceTimersByTimeAsync(1000);
    expect(mocks.fetch.mock.calls.filter(([url]) => String(url).includes("/push?"))).toHaveLength(2);
    expect(await (await openNativeDatabase(accountId)).query("SELECT * FROM sync_outbox")).toHaveLength(0);
  });
  it("continues sending all attachments after re-enabling sync", async () => {
    await disableSync();
    const repo = getLocalRepository()!;
    const book = await repo.notebooks.create({ id: randomUUID(), name: "Book" });
    const note = await repo.notes.create({ id: randomUUID(), notebookId: book.id });
    for (let index = 0; index < 5; index++) await repo.attachments.save({ id: randomUUID(), noteId: note.id, filename: `${index}.png`, mimeType: "image/png", blob: new Blob(["image"]) });
    await vi.advanceTimersByTimeAsync(1000);
    expect(mocks.fetch).not.toHaveBeenCalled();
    await connectSyncServer({ serverUrl });
    await vi.advanceTimersByTimeAsync(1000);
    expect(mocks.fetch.mock.calls.filter(([,init]) => init?.method === "PUT")).toHaveLength(5);
    expect(await (await openNativeDatabase(accountId)).query("SELECT * FROM attachments WHERE transferStatus <> 'uploaded'")).toHaveLength(0);
  });
  it("cancels an in-flight request when sync is disabled", async () => {
    mocks.fetch.mockImplementation((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")));
    }));
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.fetch).toHaveBeenCalledOnce();
    await disableSync();
    await vi.advanceTimersByTimeAsync(1000);
    expect(mocks.fetch.mock.calls[0][1].signal.aborted).toBe(true);
    expect(mocks.fetch).toHaveBeenCalledOnce();
    expect(isMobileSyncEnabled()).toBe(false);
  });
  it("keeps task changes queued while disabled and sends them after enabling", async () => {
    await disableSync();
    const db = await openNativeDatabase(accountId);
    const restore = installMobileLocalModuleBridge(getLocalRepository()! as never, db, userId);
    try {
      const task = await api.createTask({ title: "Local task" });
      await api.updateTask(task.id, { title: "Edited task" });
      await vi.advanceTimersByTimeAsync(1000);
      expect(mocks.fetch).not.toHaveBeenCalled();
      expect(await db.query("SELECT * FROM sync_outbox WHERE entityType='task'")).toHaveLength(2);
      await connectSyncServer({ serverUrl });
      await vi.advanceTimersByTimeAsync(1000);
      const push = mocks.fetch.mock.calls.find(([url]) => String(url).includes("/push?"));
      expect(JSON.parse(push![1].body).mutations.map((item: any) => item.payload.title)).toContain("Edited task");
      expect(await db.query("SELECT * FROM sync_outbox")).toHaveLength(0);
    } finally { restore(); }
  });
});
