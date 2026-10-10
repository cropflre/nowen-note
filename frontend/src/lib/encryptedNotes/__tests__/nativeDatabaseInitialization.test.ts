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

it.each([0, 4])("initializing schema %s installs all persisted guards before acknowledging version 5", async (version) => {
  mocks.version = version;
  const db = await openNativeDatabase("encryption-test-account");
  const statements = mocks.execute.mock.calls.map(([sql]) => sql);
  for (const guard of NATIVE_ENCRYPTED_NOTE_GUARDS) {
    expect(statements).toContain(guard);
    expect(statements.indexOf(guard)).toBeLessThan(statements.indexOf("PRAGMA user_version = 5"));
  }
  expect(statements.at(-1)).toBe("COMMIT");
  await db.close();
});
it("a failed guard install rolls back without acknowledging a migrated schema", async () => {
  mocks.version = 4;
  mocks.execute.mockImplementation(async (sql: string) => { if (sql.startsWith("CREATE TRIGGER native_encrypted_notes_update")) throw new Error("Failed DDL"); return {}; });
  await expect(openNativeDatabase("encryption-test-account")).rejects.toThrow("Failed DDL");
  const statements = mocks.execute.mock.calls.map(([sql]) => sql);
  expect(statements.at(-1)).toBe("ROLLBACK");
  expect(statements).not.toContain("PRAGMA user_version = 5"); expect(statements).not.toContain("COMMIT");
});
