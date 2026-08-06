import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import type { Pool } from "pg";
import {
  initializeDatabase,
  resetDatabaseRuntimeForTests,
} from "../src/db/runtime";

const silentLogger = {
  log() { /* no-op */ },
  warn() { /* no-op */ },
};

afterEach(async () => {
  await resetDatabaseRuntimeForTests();
});

test("runtime-backed pilot repositories use PostgreSQL adapter and dialect", async () => {
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  let ended = false;

  const fakePool = {
    async query(sql: string, params: unknown[] = []) {
      statements.push({ sql, params });
      return { rows: [{ ok: 1 }], rowCount: 1 };
    },
    async end() {
      ended = true;
    },
  } as unknown as Pool;

  await initializeDatabase({
    env: {
      DB_DRIVER: "postgres",
      DATABASE_URL: "postgres://user:secret@db.example.com:5432/nowen",
    },
    dependencies: {
      createPostgresPool: () => fakePool,
      logger: silentLogger,
    },
  });

  const [
    { systemSettingsRepository },
    { customFontsRepository },
    { favoritesRepository },
    { noteTagsRepository },
  ] = await Promise.all([
    import("../src/repositories/systemSettingsRepository"),
    import("../src/repositories/customFontsRepository"),
    import("../src/repositories/favoritesRepository"),
    import("../src/repositories/noteTagsRepository"),
  ]);

  await systemSettingsRepository.setAsync("runtime:test", "1");
  await customFontsRepository.createAsync({
    id: "font-runtime",
    name: "Runtime Font",
    fileName: "runtime.woff2",
    format: "woff2",
    fileSize: 42,
  });
  await favoritesRepository.addFavoriteAsync("user-runtime", "note-runtime", null);
  await noteTagsRepository.addTagToNoteAsync("note-runtime", "tag-runtime");

  const sql = statements.slice(1).map((entry) => entry.sql);
  assert.equal(sql.length, 4);
  assert.match(sql[0], /NOW\(\)/);
  assert.match(sql[0], /\$1/);
  assert.match(sql[1], /NOW\(\)/);
  assert.match(sql[2], /ON CONFLICT \("userId", "noteId"\) DO NOTHING/);
  assert.match(sql[3], /ON CONFLICT \("noteId", "tagId"\) DO NOTHING/);

  await resetDatabaseRuntimeForTests();
  assert.equal(ended, true);
});
