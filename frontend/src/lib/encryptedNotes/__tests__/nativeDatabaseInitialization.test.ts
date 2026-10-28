import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openNativeDatabase } from "../../nativeDatabase";
import { NATIVE_ENCRYPTED_NOTE_GUARDS } from "../nativeStorageGuards";

const mocks = vi.hoisted(() => ({ version: 0, execute: vi.fn(), run: vi.fn(), close: vi.fn() }));
vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => true } }));
vi.mock("@capacitor-community/sqlite", () => ({
  CapacitorSQLite: {},
  SQLiteConnection: class {
    async checkConnectionsConsistency() { return { result: true }; }
    async isConnection() { return { result: false }; }
    async closeConnection() {}
    async createConnection() { return {
      isDBOpen: async () => ({ result: true }), close: mocks.close,
      execute: mocks.execute, run: mocks.run,
      query: async (sql: string) => ({ values: sql === "PRAGMA user_version" ? [{ user_version: mocks.version }] : [] }),
    }; }
  },
}));
beforeEach(() => { mocks.version = 0; mocks.execute.mockReset().mockResolvedValue({}); mocks.run.mockReset().mockResolvedValue({}); mocks.close.mockReset().mockResolvedValue(undefined); Reflect.deleteProperty(globalThis, "__nowenNoteNativeDatabaseState"); });
afterEach(() => { Reflect.deleteProperty(globalThis, "__nowenNoteNativeDatabaseState"); });

it.each([0, 4, 12])("initializing schema %s installs all persisted guards before acknowledging version 13", async (version) => {
  mocks.version = version;
  const db = await openNativeDatabase("encryption-test-account");
  const statements = mocks.execute.mock.calls.map(([sql]) => sql);
  for (const guard of NATIVE_ENCRYPTED_NOTE_GUARDS) {
    expect(statements).toContain(guard);
    expect(statements.indexOf(guard)).toBeLessThan(statements.indexOf("PRAGMA user_version = 13"));
  }
  expect(statements.at(-1)).toBe("COMMIT");
  await db.close();
});
it.each([4, 12])("a failed guard install on schema %s rolls back without acknowledging a migrated schema", async (version) => {
  mocks.version = version;
  mocks.execute.mockImplementation(async (sql: string) => { if (sql.startsWith("CREATE TRIGGER native_encrypted_notes_update")) throw new Error("Failed DDL"); return {}; });
  await expect(openNativeDatabase("encryption-test-account")).rejects.toThrow("Failed DDL");
  const statements = mocks.execute.mock.calls.map(([sql]) => sql);
  expect(statements.at(-1)).toBe("ROLLBACK");
  expect(statements).not.toContain("PRAGMA user_version = 13"); expect(statements).not.toContain("COMMIT");
});

it("upgrades schema 5 with structural metadata and queues before acknowledging version 13", async () => {
  mocks.version = 5;
  const db = await openNativeDatabase("tree-upgrade-account");
  const statements = mocks.execute.mock.calls.map(([sql]) => sql as string);
  const table = statements.findIndex((sql) => sql.startsWith("CREATE TABLE IF NOT EXISTS native_knowledge_tree_nodes"));
  expect(table).toBeGreaterThan(0);
  expect(table).toBeLessThan(statements.indexOf("PRAGMA user_version = 13"));
  expect(statements.some((sql) => /DELETE FROM/.test(sql))).toBe(false);
  expect(statements.some((sql) => sql.includes("FROM sync_outbox"))).toBe(true);
  expect(statements.some((sql) => sql.includes("FROM sync_conflicts"))).toBe(true);
  await db.close();
});

it("rolls back a failed schema 5 tree migration without advancing the version", async () => {
  mocks.version = 5;
  mocks.execute.mockImplementation(async (sql: string) => {
    if (sql.startsWith("CREATE TABLE IF NOT EXISTS native_knowledge_tree_nodes")) throw new Error("Tree DDL failure");
    return {};
  });
  await expect(openNativeDatabase("tree-failed-upgrade-account")).rejects.toThrow("Tree DDL failure");
  const statements = mocks.execute.mock.calls.map(([sql]) => sql);
  expect(statements.at(-1)).toBe("ROLLBACK");
  expect(statements).not.toContain("PRAGMA user_version = 13");
});

async function verifyConcurrentRead(rollback: boolean) {
  const db = await openNativeDatabase("concurrent-sync-account");
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let expired: typeof db | undefined;
  const apply = db.transaction(async (tx) => {
    expired = tx;
    await tx.run("UPDATE notes SET title='fixture'");
    entered(); await gate;
    if (rollback) throw new Error("apply failure");
  });
  const completion = apply.catch((error) => error.message);
  await started;
  // The reader belongs to another event/UI callback, not the transaction body.
  let read: Promise<unknown[]>;
  try { read = db.query("SELECT id FROM notes"); }
  finally { release(); }
  expect(await completion).toBe(rollback ? "apply failure" : undefined);
  expect(await read!).toEqual([]);
  expect(mocks.execute.mock.calls.at(-1)?.[0]).toBe(rollback ? "ROLLBACK" : "COMMIT");
  expect(() => expired!.query("SELECT id FROM notes")).toThrow("事务视图已失效");
  await db.close();
}
it("external UI reads wait for an in-progress Apply transaction to commit", () => verifyConcurrentRead(false));
it("external UI reads wait for an in-progress Apply transaction to roll back", () => verifyConcurrentRead(true));

it("a failed schema 10 asset migration rolls back before acknowledging version 13",async()=>{
  mocks.version=10;
  mocks.execute.mockImplementation(async(sql:string)=>{if(sql.startsWith("CREATE TABLE IF NOT EXISTS native_asset_metadata"))throw new Error("Asset DDL failure");return {};});
  await expect(openNativeDatabase("asset-failed-upgrade-account")).rejects.toThrow("Asset DDL failure");
  const statements=mocks.execute.mock.calls.map(([sql])=>sql);
  expect(statements.at(-1)).toBe("ROLLBACK");expect(statements).not.toContain("PRAGMA user_version = 13");
});
