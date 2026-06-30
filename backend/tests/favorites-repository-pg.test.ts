/**
 * favoritesRepository PostgreSQL 双库测试（PG-PILOT-03）
 *
 * 需要 TEST_PG_DATABASE_URL 环境变量。
 * 无 TEST_PG_DATABASE_URL 时全部 skip。
 *
 * 启动：
 *   docker compose -f docker-compose.postgres.yml up -d
 *   $env:TEST_PG_DATABASE_URL="postgres://nowen:nowen_dev_password@localhost:5432/nowen_note_test"
 */

import assert from "node:assert/strict";
import test from "node:test";
import { hasPg, getPgPool, initPgSchema, cleanTable, closePgPool } from "./helpers/pg-test-db";

// Skip all tests if no PostgreSQL available
const skip = !hasPg;

const USER_ID = "user-pg-fav";
const NOTE_ID = "note-pg-fav";
const NOTE_ID_2 = "note-pg-fav-2";
const NOTE_ID_3 = "note-pg-fav-3";
const WS_ID = "ws-pg-fav";

/** 创建 FK 依赖数据 */
async function seedBase(pool: import("pg").Pool) {
  await pool.query(`INSERT INTO users (id, username, "passwordHash") VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [USER_ID, USER_ID, "hash"]);
  await pool.query(`INSERT INTO notebooks (id, "userId", name) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, ["nb-pg-fav", USER_ID, "Test NB"]);
  await pool.query(`INSERT INTO notes (id, "userId", "notebookId", title) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`, [NOTE_ID, USER_ID, "nb-pg-fav", "Test Note"]);
  await pool.query(`INSERT INTO notes (id, "userId", "notebookId", title) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`, [NOTE_ID_2, USER_ID, "nb-pg-fav", "Note 2"]);
  await pool.query(`INSERT INTO notes (id, "userId", "notebookId", title) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`, [NOTE_ID_3, USER_ID, "nb-pg-fav", "Note 3"]);
}

/** 清理测试数据 */
async function cleanAll(pool: import("pg").Pool) {
  await pool.query("DELETE FROM favorites");
  await pool.query("DELETE FROM notes WHERE id IN ($1, $2, $3)", [NOTE_ID, NOTE_ID_2, NOTE_ID_3]);
  await pool.query("DELETE FROM notebooks WHERE id = $1", ["nb-pg-fav"]);
  await pool.query("DELETE FROM users WHERE id = $1", [USER_ID]);
}

test("PG: isFavoritedAsync returns true when favorited", { skip }, async () => {
  const pool = await getPgPool()!;
  await initPgSchema(pool);
  await cleanAll(pool);
  await seedBase(pool);

  const { PostgresAdapter } = await import("../src/db/postgresAdapter");
  const { createFavoritesRepository } = await import("../src/repositories/favoritesRepository");
  const repo = createFavoritesRepository(
    new PostgresAdapter(pool), "NOW()", "INSERT", 'ON CONFLICT ("userId", "noteId") DO NOTHING'
  );

  await repo.addFavoriteAsync(USER_ID, NOTE_ID, null);
  const result = await repo.isFavoritedAsync(USER_ID, NOTE_ID);
  assert.equal(result, true);

  await cleanAll(pool);
  await closePgPool(pool);
});

test("PG: isFavoritedAsync returns false when not favorited", { skip }, async () => {
  const pool = await getPgPool()!;
  await initPgSchema(pool);
  await cleanAll(pool);

  const { PostgresAdapter } = await import("../src/db/postgresAdapter");
  const { createFavoritesRepository } = await import("../src/repositories/favoritesRepository");
  const repo = createFavoritesRepository(
    new PostgresAdapter(pool), "NOW()", "INSERT", 'ON CONFLICT ("userId", "noteId") DO NOTHING'
  );

  const result = await repo.isFavoritedAsync(USER_ID, "nonexistent");
  assert.equal(result, false);

  await closePgPool(pool);
});

test("PG: addFavoriteAsync inserts favorite", { skip }, async () => {
  const pool = await getPgPool()!;
  await initPgSchema(pool);
  await cleanAll(pool);
  await seedBase(pool);

  const { PostgresAdapter } = await import("../src/db/postgresAdapter");
  const { createFavoritesRepository } = await import("../src/repositories/favoritesRepository");
  const repo = createFavoritesRepository(
    new PostgresAdapter(pool), "NOW()", "INSERT", 'ON CONFLICT ("userId", "noteId") DO NOTHING'
  );

  await repo.addFavoriteAsync(USER_ID, NOTE_ID, WS_ID);
  const result = await repo.isFavoritedAsync(USER_ID, NOTE_ID);
  assert.equal(result, true);

  await cleanAll(pool);
  await closePgPool(pool);
});

test("PG: addFavoriteAsync duplicate is idempotent", { skip }, async () => {
  const pool = await getPgPool()!;
  await initPgSchema(pool);
  await cleanAll(pool);
  await seedBase(pool);

  const { PostgresAdapter } = await import("../src/db/postgresAdapter");
  const { createFavoritesRepository } = await import("../src/repositories/favoritesRepository");
  const repo = createFavoritesRepository(
    new PostgresAdapter(pool), "NOW()", "INSERT", 'ON CONFLICT ("userId", "noteId") DO NOTHING'
  );

  await repo.addFavoriteAsync(USER_ID, NOTE_ID, null);
  await repo.addFavoriteAsync(USER_ID, NOTE_ID, null); // 重复添加不报错
  const result = await repo.isFavoritedAsync(USER_ID, NOTE_ID);
  assert.equal(result, true);

  await cleanAll(pool);
  await closePgPool(pool);
});

test("PG: removeFavoriteAsync deletes favorite", { skip }, async () => {
  const pool = await getPgPool()!;
  await initPgSchema(pool);
  await cleanAll(pool);
  await seedBase(pool);

  const { PostgresAdapter } = await import("../src/db/postgresAdapter");
  const { createFavoritesRepository } = await import("../src/repositories/favoritesRepository");
  const repo = createFavoritesRepository(
    new PostgresAdapter(pool), "NOW()", "INSERT", 'ON CONFLICT ("userId", "noteId") DO NOTHING'
  );

  await repo.addFavoriteAsync(USER_ID, NOTE_ID, null);
  await repo.removeFavoriteAsync(USER_ID, NOTE_ID);
  const result = await repo.isFavoritedAsync(USER_ID, NOTE_ID);
  assert.equal(result, false);

  await cleanAll(pool);
  await closePgPool(pool);
});

test("PG: toggleFavoriteAsync toggles state", { skip }, async () => {
  const pool = await getPgPool()!;
  await initPgSchema(pool);
  await cleanAll(pool);
  await seedBase(pool);

  const { PostgresAdapter } = await import("../src/db/postgresAdapter");
  const { createFavoritesRepository } = await import("../src/repositories/favoritesRepository");
  const repo = createFavoritesRepository(
    new PostgresAdapter(pool), "NOW()", "INSERT", 'ON CONFLICT ("userId", "noteId") DO NOTHING'
  );

  const first = await repo.toggleFavoriteAsync(USER_ID, NOTE_ID, null);
  assert.equal(first, true);

  const second = await repo.toggleFavoriteAsync(USER_ID, NOTE_ID, null);
  assert.equal(second, false);

  await cleanAll(pool);
  await closePgPool(pool);
});

test("PG: listFavoriteNoteIdsAsync returns note ids ordered by createdAt DESC", { skip }, async () => {
  const pool = await getPgPool()!;
  await initPgSchema(pool);
  await cleanAll(pool);
  await seedBase(pool);

  const { PostgresAdapter } = await import("../src/db/postgresAdapter");
  const { createFavoritesRepository } = await import("../src/repositories/favoritesRepository");
  const repo = createFavoritesRepository(
    new PostgresAdapter(pool), "NOW()", "INSERT", 'ON CONFLICT ("userId", "noteId") DO NOTHING'
  );

  await repo.addFavoriteAsync(USER_ID, NOTE_ID_2, null);
  await new Promise((r) => setTimeout(r, 50));
  await repo.addFavoriteAsync(USER_ID, NOTE_ID_3, null);

  const ids = await repo.listFavoriteNoteIdsAsync(USER_ID);
  assert.ok(ids.length >= 2);
  assert.equal(ids[0], NOTE_ID_3); // 最新在前

  await cleanAll(pool);
  await closePgPool(pool);
});

test("PG: listFavoriteNoteIdsAsync filters by workspaceId", { skip }, async () => {
  const pool = await getPgPool()!;
  await initPgSchema(pool);
  await cleanAll(pool);
  await seedBase(pool);

  const { PostgresAdapter } = await import("../src/db/postgresAdapter");
  const { createFavoritesRepository } = await import("../src/repositories/favoritesRepository");
  const repo = createFavoritesRepository(
    new PostgresAdapter(pool), "NOW()", "INSERT", 'ON CONFLICT ("userId", "noteId") DO NOTHING'
  );

  await repo.addFavoriteAsync(USER_ID, NOTE_ID_2, WS_ID);
  await repo.addFavoriteAsync(USER_ID, NOTE_ID_3, null);

  const wsIds = await repo.listFavoriteNoteIdsAsync(USER_ID, WS_ID);
  assert.equal(wsIds.length, 1);
  assert.equal(wsIds[0], NOTE_ID_2);

  await cleanAll(pool);
  await closePgPool(pool);
});

test("PG: deleteByNoteIdAsync returns changes", { skip }, async () => {
  const pool = await getPgPool()!;
  await initPgSchema(pool);
  await cleanAll(pool);
  await seedBase(pool);

  const { PostgresAdapter } = await import("../src/db/postgresAdapter");
  const { createFavoritesRepository } = await import("../src/repositories/favoritesRepository");
  const repo = createFavoritesRepository(
    new PostgresAdapter(pool), "NOW()", "INSERT", 'ON CONFLICT ("userId", "noteId") DO NOTHING'
  );

  await repo.addFavoriteAsync(USER_ID, NOTE_ID, null);
  const count = await repo.deleteByNoteIdAsync(NOTE_ID);
  assert.equal(count, 1);

  await cleanAll(pool);
  await closePgPool(pool);
});

test("PG: deleteByUserIdAsync returns changes", { skip }, async () => {
  const pool = await getPgPool()!;
  await initPgSchema(pool);
  await cleanAll(pool);
  await seedBase(pool);

  const { PostgresAdapter } = await import("../src/db/postgresAdapter");
  const { createFavoritesRepository } = await import("../src/repositories/favoritesRepository");
  const repo = createFavoritesRepository(
    new PostgresAdapter(pool), "NOW()", "INSERT", 'ON CONFLICT ("userId", "noteId") DO NOTHING'
  );

  await repo.addFavoriteAsync(USER_ID, NOTE_ID_2, null);
  await repo.addFavoriteAsync(USER_ID, NOTE_ID_3, null);
  const count = await repo.deleteByUserIdAsync(USER_ID);
  assert.equal(count, 2);

  await cleanAll(pool);
  await closePgPool(pool);
});
