import assert from "node:assert/strict";
import test from "node:test";

import type { DbStatement } from "../src/db/adapters/types";
import { PostgresAdapter } from "../src/db/postgresAdapter";
import { createNotesRuntimeRouter } from "../src/routes/notes-runtime";
import { NoteCoreRuntimeError } from "../src/services/note-core-runtime";
import { createNoteDeletionRuntime } from "../src/services/note-deletion-runtime";
import { closePgPool, getPgPool, hasPg, initPgSchema } from "./helpers/pg-test-db";

const OWNER = "pg-trash-owner";
const ADMIN = "pg-trash-admin";
const EDITOR = "pg-trash-editor";
const OUTSIDER = "pg-trash-outsider";
const WORKSPACE = "pg-trash-workspace";
const PERSONAL_NOTEBOOK = "pg-trash-personal-notebook";
const WORKSPACE_NOTEBOOK = "pg-trash-workspace-notebook";

const PERSONAL_TRASH_1 = "a1111111-1111-4111-8111-111111111111";
const PERSONAL_TRASH_2 = "a2222222-2222-4222-8222-222222222222";
const PERSONAL_LOCKED = "a3333333-3333-4333-8333-333333333333";
const PERSONAL_ACTIVE = "a4444444-4444-4444-8444-444444444444";
const WORKSPACE_TRASH_1 = "a5555555-5555-4555-8555-555555555555";
const WORKSPACE_TRASH_2 = "a6666666-6666-4666-8666-666666666666";
const WORKSPACE_LOCKED = "a7777777-7777-4777-8777-777777777777";
const WORKSPACE_ACTIVE = "a8888888-8888-4888-8888-888888888888";

const PERSONAL_UNIQUE_ATTACHMENT = "b1111111-1111-4111-8111-111111111111";
const PERSONAL_SHARED_DELETED = "b2222222-2222-4222-8222-222222222222";
const PERSONAL_SHARED_LIVE = "b3333333-3333-4333-8333-333333333333";
const WORKSPACE_ATTACHMENT = "b4444444-4444-4444-8444-444444444444";
const PERSONAL_UNIQUE_PATH = "c1111111-1111-4111-8111-111111111111.png";
const SHARED_PATH = "c2222222-2222-4222-8222-222222222222.png";
const WORKSPACE_PATH = "c3333333-3333-4333-8333-333333333333.png";

const PERSONAL_UNUSED_TAG = "pg-trash-personal-unused";
const PERSONAL_KEPT_TAG = "pg-trash-personal-kept";
const WORKSPACE_UNUSED_TAG = "pg-trash-workspace-unused";
const WORKSPACE_KEPT_TAG = "pg-trash-workspace-kept";

async function seed(pool: import("pg").Pool) {
  await pool.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [[OWNER, ADMIN, EDITOR, OUTSIDER]]);
  await pool.query(
    `INSERT INTO users (id, username, "passwordHash", "tokenVersion")
     VALUES ($1, $1, 'hash', 0), ($2, $2, 'hash', 0),
            ($3, $3, 'hash', 0), ($4, $4, 'hash', 0)`,
    [OWNER, ADMIN, EDITOR, OUTSIDER],
  );
  await pool.query(
    `INSERT INTO workspaces (id, "ownerId", name) VALUES ($1, $2, 'Trash workspace')`,
    [WORKSPACE, OWNER],
  );
  await pool.query(
    `INSERT INTO workspace_members ("workspaceId", "userId", role)
     VALUES ($1, $2, 'admin'), ($1, $3, 'editor')`,
    [WORKSPACE, ADMIN, EDITOR],
  );
  await pool.query(
    `INSERT INTO notebooks (id, "userId", "workspaceId", name)
     VALUES ($1, $2, NULL, 'Personal trash'), ($3, $2, $4, 'Workspace trash')`,
    [PERSONAL_NOTEBOOK, OWNER, WORKSPACE_NOTEBOOK, WORKSPACE],
  );
  await pool.query(
    `INSERT INTO notes (
       id, "userId", "workspaceId", "notebookId", title, content,
       "contentText", "contentFormat", "isTrashed", "isLocked", version
     ) VALUES
       ($1, $9, NULL, $10, 'Personal trash one', '# One', 'One', 'markdown', true, false, 1),
       ($2, $9, NULL, $10, 'Personal trash two', '# Two', 'Two', 'markdown', true, false, 1),
       ($3, $9, NULL, $10, 'Personal locked', '# Locked', 'Locked', 'markdown', true, true, 1),
       ($4, $9, NULL, $10, 'Personal active', '# Active', 'Active', 'markdown', false, false, 1),
       ($5, $9, $11, $12, 'Workspace trash one', '# W1', 'W1', 'markdown', true, false, 1),
       ($6, $9, $11, $12, 'Workspace trash two', '# W2', 'W2', 'markdown', true, false, 1),
       ($7, $9, $11, $12, 'Workspace locked', '# WL', 'WL', 'markdown', true, true, 1),
       ($8, $9, $11, $12, 'Workspace active', '# WA', 'WA', 'markdown', false, false, 1)`,
    [
      PERSONAL_TRASH_1,
      PERSONAL_TRASH_2,
      PERSONAL_LOCKED,
      PERSONAL_ACTIVE,
      WORKSPACE_TRASH_1,
      WORKSPACE_TRASH_2,
      WORKSPACE_LOCKED,
      WORKSPACE_ACTIVE,
      OWNER,
      PERSONAL_NOTEBOOK,
      WORKSPACE,
      WORKSPACE_NOTEBOOK,
    ],
  );
  await pool.query(
    `INSERT INTO attachments (id, "noteId", "userId", filename, "mimeType", size, path)
     VALUES
       ($1, $2, $3, 'personal-unique.png', 'image/png', 10, $4),
       ($5, $6, $3, 'personal-shared-deleted.png', 'image/png', 20, $7),
       ($8, $9, $3, 'personal-shared-live.png', 'image/png', 20, $7),
       ($10, $11, $3, 'workspace.png', 'image/png', 30, $12)`,
    [
      PERSONAL_UNIQUE_ATTACHMENT,
      PERSONAL_TRASH_1,
      OWNER,
      PERSONAL_UNIQUE_PATH,
      PERSONAL_SHARED_DELETED,
      PERSONAL_TRASH_2,
      SHARED_PATH,
      PERSONAL_SHARED_LIVE,
      PERSONAL_ACTIVE,
      WORKSPACE_ATTACHMENT,
      WORKSPACE_TRASH_1,
      WORKSPACE_PATH,
    ],
  );
  await pool.query(
    `INSERT INTO tags (id, "userId", name, "workspaceId")
     VALUES
       ($1, $2, 'personal-unused', NULL),
       ($3, $2, 'personal-kept', NULL),
       ($4, $2, 'workspace-unused', $5),
       ($6, $2, 'workspace-kept', $5)`,
    [
      PERSONAL_UNUSED_TAG,
      OWNER,
      PERSONAL_KEPT_TAG,
      WORKSPACE_UNUSED_TAG,
      WORKSPACE,
      WORKSPACE_KEPT_TAG,
    ],
  );
  await pool.query(
    `INSERT INTO note_tags ("noteId", "tagId")
     VALUES ($1, $2), ($3, $4), ($5, $6), ($7, $8)`,
    [
      PERSONAL_TRASH_1,
      PERSONAL_UNUSED_TAG,
      PERSONAL_ACTIVE,
      PERSONAL_KEPT_TAG,
      WORKSPACE_TRASH_1,
      WORKSPACE_UNUSED_TAG,
      WORKSPACE_ACTIVE,
      WORKSPACE_KEPT_TAG,
    ],
  );
  await pool.query(
    `INSERT INTO favorites ("userId", "noteId") VALUES ($1, $2), ($1, $3)`,
    [OWNER, PERSONAL_TRASH_1, WORKSPACE_TRASH_1],
  );
  await pool.query(
    `INSERT INTO note_versions (
       id, "noteId", "userId", title, content, "contentText", "contentFormat", version
     ) VALUES
       ('pg-trash-personal-version', $1, $3, 'Old', '# Old', 'Old', 'markdown', 0),
       ('pg-trash-workspace-version', $2, $3, 'Old W', '# Old W', 'Old W', 'markdown', 0)`,
    [PERSONAL_TRASH_1, WORKSPACE_TRASH_1, OWNER],
  );
  await pool.query(
    `INSERT INTO note_ysnapshots ("noteId", snapshot_blob, "updatesMergedTo")
     VALUES ($1, $2, 0)`,
    [PERSONAL_TRASH_1, Buffer.from([1, 2, 3])],
  );
  await pool.query(
    `INSERT INTO note_yupdates ("noteId", "userId", update_blob, clock)
     VALUES ($1, $2, $3, 1)`,
    [PERSONAL_TRASH_1, OWNER, Buffer.from([4, 5, 6])],
  );
}

async function count(pool: import("pg").Pool, sql: string, params: unknown[] = []) {
  return Number((await pool.query(sql, params)).rows[0].count);
}

test("personal trash empty atomically deletes unlocked notes and preserves shared attachment paths", { skip: !hasPg }, async () => {
  const pool = await getPgPool();
  assert.ok(pool);
  try {
    await initPgSchema(pool);
    await seed(pool);
    const runtime = createNoteDeletionRuntime(new PostgresAdapter(pool));

    const result = await runtime.emptyTrash(OWNER);
    assert.equal(result.success, true);
    assert.equal(result.count, 2);
    assert.equal(result.skipped, 1);
    assert.deepEqual(result.noteIds, [PERSONAL_TRASH_1, PERSONAL_TRASH_2]);
    assert.equal(result.attachmentCount, 2);
    assert.equal(result.removedFiles, 0);
    assert.equal(result.skippedSharedPaths, 1);
    assert.deepEqual(result.cleanupWarnings, []);
    assert.equal(result.walTruncated, false);
    assert.equal(result.incrementalVacuumed, false);
    assert.equal(result.vacuumed, false);
    assert.ok(result.freedBytesEstimate > 0);

    assert.equal(await count(pool, `SELECT COUNT(*) FROM notes WHERE id = ANY($1::text[])`, [[PERSONAL_TRASH_1, PERSONAL_TRASH_2]]), 0);
    assert.equal(await count(pool, `SELECT COUNT(*) FROM notes WHERE id = ANY($1::text[])`, [[PERSONAL_LOCKED, PERSONAL_ACTIVE]]), 2);
    assert.equal(await count(pool, `SELECT COUNT(*) FROM notes WHERE "workspaceId" = $1`, [WORKSPACE]), 4);
    assert.equal(await count(pool, `SELECT COUNT(*) FROM attachments WHERE id = $1`, [PERSONAL_SHARED_LIVE]), 1);
    assert.equal(await count(pool, `SELECT COUNT(*) FROM favorites WHERE "noteId" = $1`, [PERSONAL_TRASH_1]), 0);
    assert.equal(await count(pool, `SELECT COUNT(*) FROM note_versions WHERE "noteId" = $1`, [PERSONAL_TRASH_1]), 0);
    assert.equal(await count(pool, `SELECT COUNT(*) FROM note_ysnapshots WHERE "noteId" = $1`, [PERSONAL_TRASH_1]), 0);
    assert.equal(await count(pool, `SELECT COUNT(*) FROM note_yupdates WHERE "noteId" = $1`, [PERSONAL_TRASH_1]), 0);
    assert.equal(await count(pool, `SELECT COUNT(*) FROM tags WHERE id = $1`, [PERSONAL_UNUSED_TAG]), 0);
    assert.equal(await count(pool, `SELECT COUNT(*) FROM tags WHERE id = $1`, [PERSONAL_KEPT_TAG]), 1);
    assert.equal(await count(pool, `SELECT COUNT(*) FROM tags WHERE id = $1`, [WORKSPACE_UNUSED_TAG]), 1);
  } finally {
    await closePgPool(pool);
  }
});

test("workspace trash empty requires admin and keeps locked notes", { skip: !hasPg }, async () => {
  const pool = await getPgPool();
  assert.ok(pool);
  try {
    await initPgSchema(pool);
    await seed(pool);
    const adapter = new PostgresAdapter(pool);
    const runtime = createNoteDeletionRuntime(adapter);

    await assert.rejects(
      () => runtime.emptyTrash(EDITOR, WORKSPACE),
      (error: unknown) => error instanceof NoteCoreRuntimeError && error.code === "FORBIDDEN",
    );
    await assert.rejects(
      () => runtime.emptyTrash(OUTSIDER, WORKSPACE),
      (error: unknown) => error instanceof NoteCoreRuntimeError && error.code === "FORBIDDEN",
    );

    const router = createNotesRuntimeRouter(adapter, "postgres");
    const response = await router.request(`/trash/empty?workspaceId=${WORKSPACE}`, {
      method: "DELETE",
      headers: { "X-User-Id": ADMIN },
    });
    assert.equal(response.status, 200);
    const result = await response.json() as {
      success: boolean;
      count: number;
      skipped: number;
      noteIds: string[];
    };
    assert.equal(result.success, true);
    assert.equal(result.count, 2);
    assert.equal(result.skipped, 1);
    assert.deepEqual(result.noteIds, [WORKSPACE_TRASH_1, WORKSPACE_TRASH_2]);

    assert.equal(await count(pool, `SELECT COUNT(*) FROM notes WHERE id = ANY($1::text[])`, [[WORKSPACE_TRASH_1, WORKSPACE_TRASH_2]]), 0);
    assert.equal(await count(pool, `SELECT COUNT(*) FROM notes WHERE id = ANY($1::text[])`, [[WORKSPACE_LOCKED, WORKSPACE_ACTIVE]]), 2);
    assert.equal(await count(pool, `SELECT COUNT(*) FROM tags WHERE id = $1`, [WORKSPACE_UNUSED_TAG]), 0);
    assert.equal(await count(pool, `SELECT COUNT(*) FROM tags WHERE id = $1`, [WORKSPACE_KEPT_TAG]), 1);
    assert.equal(await count(pool, `SELECT COUNT(*) FROM notes WHERE "workspaceId" IS NULL`), 4);
  } finally {
    await closePgPool(pool);
  }
});

test("trash empty reports post-commit cleanup failures without restoring database rows", { skip: !hasPg }, async () => {
  const pool = await getPgPool();
  assert.ok(pool);
  try {
    await initPgSchema(pool);
    await seed(pool);
    const runtime = createNoteDeletionRuntime(new PostgresAdapter(pool), {
      cleanupAttachments: async () => {
        throw new Error("simulated object store outage");
      },
      destroyYDoc: (noteId) => {
        throw new Error(`simulated Yjs cleanup failure ${noteId}`);
      },
    });

    const result = await runtime.emptyTrash(OWNER, "personal");
    assert.equal(result.count, 2);
    assert.equal(result.cleanupWarnings.length, 3);
    assert.match(result.cleanupWarnings[0], /object store outage/);
    assert.match(result.cleanupWarnings[1], /Yjs cleanup failure/);
    assert.match(result.cleanupWarnings[2], /Yjs cleanup failure/);
    assert.equal(await count(pool, `SELECT COUNT(*) FROM notes WHERE id = ANY($1::text[])`, [[PERSONAL_TRASH_1, PERSONAL_TRASH_2]]), 0);
  } finally {
    await closePgPool(pool);
  }
});

test("trash empty rolls back when the eligible target set changes before commit", { skip: !hasPg }, async () => {
  const pool = await getPgPool();
  assert.ok(pool);
  try {
    await initPgSchema(pool);
    await seed(pool);

    class RacingAdapter extends PostgresAdapter {
      private raced = false;

      override async executeStatements(statements: DbStatement[]): Promise<{ changes: number }> {
        if (!this.raced) {
          this.raced = true;
          await this.execute(
            `UPDATE notes SET "isLocked" = 1 WHERE id = ?`,
            [PERSONAL_TRASH_2],
          );
        }
        return super.executeStatements(statements);
      }
    }

    let cleanupCalls = 0;
    const runtime = createNoteDeletionRuntime(new RacingAdapter(pool), {
      cleanupAttachments: async () => {
        cleanupCalls++;
        return { removedFiles: 0, skippedSharedPaths: 0, warnings: [] };
      },
    });

    await assert.rejects(
      () => runtime.emptyTrash(OWNER),
      (error: unknown) => error instanceof NoteCoreRuntimeError
        && error.code === "TRASH_EMPTY_CONFLICT"
        && error.status === 409,
    );
    assert.equal(cleanupCalls, 0);
    assert.equal(await count(pool, `SELECT COUNT(*) FROM notes WHERE id = ANY($1::text[])`, [[PERSONAL_TRASH_1, PERSONAL_TRASH_2]]), 2);
  } finally {
    await closePgPool(pool);
  }
});
