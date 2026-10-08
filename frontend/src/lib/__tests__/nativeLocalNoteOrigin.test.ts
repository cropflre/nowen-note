import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NativeLocalRepository } from "../nativeLocalRepository";
import { MobileSyncEngine } from "../mobileSyncEngine";
import { forgetUnsentLocalNotes, unsentLocalNoteKey } from "../nativeLocalNoteOrigin";
import type { NativeDatabase } from "../nativeDatabase";

interface SqliteDatabase {
  run(sql: string, values?: unknown[]): void;
  getRowsModified(): number;
  prepare(sql: string): { bind(values: unknown[]): void; step(): boolean; getAsObject(): Record<string, unknown>; free(): void };
  export(): Uint8Array;
  close(): void;
}
const require = createRequire(import.meta.url);
const initSqlJs = require("sql.js") as (options: { wasmBinary: Uint8Array }) => Promise<{ Database: new (bytes?: Uint8Array) => SqliteDatabase }>;
let SQLite: Awaited<ReturnType<typeof initSqlJs>>;
let sqlite: SqliteDatabase;
let db: NativeDatabase;
let repository: NativeLocalRepository;
const scope = { scopeKey: "personal", workspaceId: null, workspaceName: null, role: null, canWrite: true, accessFingerprint: "test" };
const marker = async (key = unsentLocalNoteKey("personal", "local")) => (await db.query<{ value: string }>("SELECT value FROM native_runtime_meta WHERE key=?", [key]))[0]?.value;

function connect(bytes?: Uint8Array): NativeDatabase {
  sqlite = new SQLite.Database(bytes);
  sqlite.run("PRAGMA foreign_keys=ON");
  return {
    async run(sql, values = []) { sqlite.run(sql, values); return { changes: sqlite.getRowsModified() }; },
    async query<T>(sql: string, values: unknown[] = []) {
      const statement = sqlite.prepare(sql);
      try { statement.bind(values); const rows: T[] = []; while (statement.step()) rows.push(statement.getAsObject() as T); return rows; }
      finally { statement.free(); }
    },
    async transaction(work) {
      sqlite.run("BEGIN");
      try { const result = await work(db); sqlite.run("COMMIT"); return result; }
      catch (error) { sqlite.run("ROLLBACK"); throw error; }
    },
    async close() { sqlite.close(); },
  };
}

beforeAll(async () => { SQLite = await initSqlJs({ wasmBinary: readFileSync(require.resolve("sql.js/dist/sql-wasm.wasm")) }); });
beforeEach(async () => {
  db = connect();
  // 使用生产文件中的 SQLite 表定义，避免测试夹具的简化 schema 漏掉约束。
  const source = readFileSync(require.resolve("../nativeDatabase.ts"), "utf8");
  const scopeCheck = source.match(/const SCOPE_CHECK = `([\s\S]*?)`;/)![1];
  const entityTypes = source.match(/const ENTITY_TYPE_CHECK = `([\s\S]*?)`;/)![1];
  for (const [, sql] of source.matchAll(/`(CREATE TABLE IF NOT EXISTS [\s\S]*?)`/g)) {
    sqlite.run(sql.replaceAll("${SCOPE_CHECK}", scopeCheck).replaceAll("${ENTITY_TYPE_CHECK}", entityTypes));
  }
  await db.run("INSERT INTO sync_profiles (id,name,serverUrl,remoteUserId,enabled,createdAt,updatedAt) VALUES ('profile','test','http://server','user',1,'now','now')");
  await db.run("INSERT INTO sync_devices (profileId,deviceId,platform,createdAt) VALUES ('profile','device','android','now')");
  await db.run("INSERT INTO notebooks (id,userId,name,createdAt,updatedAt) VALUES ('public','user','public','now','now')");
  repository = new NativeLocalRepository({ db, attachments: {} as never, accountId: "account", userId: "user", getScopeKey: () => "personal" });
});
afterEach(async () => { await db.close(); vi.unstubAllGlobals(); });

function engine() {
  return new MobileSyncEngine({ db, attachments: {} as never, serverUrl: "http://server", token: "token", userId: "user", profileId: "profile", deviceId: "device" }) as unknown as {
    push: (value: typeof scope) => Promise<void>;
    applyEntries: (value: typeof scope, entries: unknown[], bootstrap: boolean) => Promise<void>;
  };
}

describe("persisted provenance for unsent native notes", () => {
  it("persists a local creation through restart and edits, but does not infer origin from version or outbox", async () => {
    await repository.notes.create({ id: "local", notebookId: "public" });
    await repository.notes.update("local", { title: "edited offline" });
    expect(await marker()).toBe("1");
    expect((await repository.notes.get("local"))?.version).toBe(2);
    await db.run("INSERT INTO notes (id,userId,notebookId,createdAt,updatedAt) VALUES ('imported','user','public','now','now')");
    await db.run(`INSERT INTO sync_outbox (id,mutationId,profileId,deviceId,scopeKey,entityType,entityId,operation,createdAt)
      VALUES ('import','import','profile','device','personal','note','imported','upsert','now')`);
    expect(await marker(unsentLocalNoteKey("personal", "imported"))).toBeUndefined();
    const bytes = sqlite.export(); await db.close(); db = connect(bytes);
    expect(await marker()).toBe("1");
  });

  it("rolls back local creation if its outbox write fails and cleans provenance when deleting or emptying trash", async () => {
    sqlite.run("CREATE TRIGGER reject_outbox BEFORE INSERT ON sync_outbox BEGIN SELECT RAISE(ABORT,'outbox rejected'); END");
    await expect(repository.notes.create({ id: "local", notebookId: "public" })).rejects.toThrow("outbox rejected");
    expect(await repository.notes.get("local")).toBeNull(); expect(await marker()).toBeUndefined();
    sqlite.run("DROP TRIGGER reject_outbox");
    await repository.notes.create({ id: "local", notebookId: "public" }); await repository.notes.remove("local");
    expect(await marker()).toBeUndefined();
    await repository.notes.create({ id: "local", notebookId: "public", isTrashed: 1 }); await repository.emptyTrash();
    expect(await marker()).toBeUndefined();
  });

  it("revokes fallback before transmitting, including lost responses, without deleting the pending mutation or local body", async () => {
    await repository.notes.create({ id: "local", notebookId: "public", content: "unsynced draft" });
    const fetchMock = vi.fn(async () => { expect(await marker()).toBeUndefined(); throw new TypeError("response lost"); });
    vi.stubGlobal("fetch", fetchMock);
    await expect(engine().push(scope)).rejects.toMatchObject({ code: "NETWORK_UNAVAILABLE" });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect((await repository.notes.get("local"))?.content).toBe("unsynced draft");
    expect(await db.query("SELECT mutationId FROM sync_outbox WHERE entityId='local'")).toHaveLength(1);
    expect(await marker()).toBeUndefined();
  });

  it.each([false, true])("revokes fallback on remote existence even when the local body is retained by conflict handling (bootstrap=%s)", async (bootstrap) => {
    await repository.notes.create({ id: "local", notebookId: "public", content: "local draft" });
    await engine().applyEntries(scope, [{ entityType: "note", entityId: "local", payload: { id: "local", notebookId: "public", content: "remote version", version: 2 } }], bootstrap);
    expect(await marker()).toBeUndefined();
    expect((await repository.notes.get("local"))?.content).toBe("local draft");
    expect(await db.query("SELECT id FROM sync_conflicts WHERE entityId='local'")).toHaveLength(1);
  });

  it("isolates identical IDs in different scopes and batches large remote marker removals", async () => {
    await repository.notes.create({ id: "local", notebookId: "public" });
    const other = unsentLocalNoteKey("workspace:other", "local");
    await db.run("INSERT INTO native_runtime_meta (key,value,updatedAt) VALUES (?,'1','now')", [other]);
    const ids = Array.from({ length: 1000 }, (_, index) => `n${index}`);
    for (const id of ids) await db.run("INSERT INTO native_runtime_meta (key,value,updatedAt) VALUES (?,'1','now')", [unsentLocalNoteKey("personal", id)]);
    await db.transaction((tx) => forgetUnsentLocalNotes(tx, "personal", ["local", ...ids]));
    expect(await marker()).toBeUndefined(); expect(await marker(other)).toBe("1");
    expect(await db.query("SELECT key FROM native_runtime_meta WHERE key LIKE 'unsentLocalNote:%'")).toHaveLength(1);
  });
});
