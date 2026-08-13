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

const NOTE = {
  personalTrash1: "a1111111-1111-4111-8111-111111111111",
  personalTrash2: "a2222222-2222-4222-8222-222222222222",
  personalLocked: "a3333333-3333-4333-8333-333333333333",
  personalActive: "a4444444-4444-4444-8444-444444444444",
  workspaceTrash1: "a5555555-5555-4555-8555-555555555555",
  workspaceTrash2: "a6666666-6666-4666-8666-666666666666",
  workspaceLocked: "a7777777-7777-4777-8777-777777777777",
  workspaceActive: "a8888888-8888-4888-8888-888888888888",
} as const;

const ATTACHMENT = {
  personalUnique: "b1111111-1111-4111-8111-111111111111",
  personalSharedDeleted: "b2222222-2222-4222-8222-222222222222",
  personalSharedLive: "b3333333-3333-4333-8333-333333333333",
  workspace: "b4444444-4444-4444-8444-444444444444",
} as const;

const PATH = {
  personalUnique: "c1111111-1111-4111-8111-111111111111.png",
  shared: "c2222222-2222-4222-8222-222222222222.png",
  workspace: "c3333333-3333-4333-8333-333333333333.png",
} as const;

const TAG = {
  personalUnused: "pg-trash-personal-unused",
  personalKept: "pg-trash-personal-kept",
  workspaceUnused: "pg-trash-workspace-unused",
  workspaceKept: "pg-trash-workspace-kept",
} as const;

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

  const notes: Array<[string, string | null, string, boolean, boolean]> = [
    [NOTE.personalTrash1, null, PERSONAL_NOTEBOOK, true, false],
    [NOTE.personalTrash2, null, PERSONAL_NOTEBOOK, true, false],
    [NOTE.personalLocked, null, PERSONAL_NOTEBOOK, true, true],
    [NOTE.personalActive, null, PERSONAL_NOTEBOOK, false, false],
    [NOTE.workspaceTrash1, WORKSPACE, WORKSPACE_NOTEBOOK, true, false],
    [NOTE.workspaceTrash2, WORKSPACE, WORKSPACE_NOTEBOOK, true, false],
    [NOTE.workspaceLocked, WORKSPACE, WORKSPACE_NOTEBOOK, true, true],
    [NOTE.workspaceActive, WORKSPACE, WORKSPACE_NOTEBOOK, false, false],
  ];
  for (const [id, workspaceId, notebookId, isTrashed, isLocked] of notes) {
    await pool.query(
      `INSERT INTO notes (
         id, "userId", "workspaceId", "notebookId", title, content,
         "contentText", "contentFormat", "isTrashed", "isLocked", version
       ) VALUES ($1, $2, $3, $4, $1, '# body', 'body', 'markdown', $5, $6, 1)`,
      [id, OWNER, workspaceId, notebookId, isTrashed, isLocked],
    );
  }

  const attachments: Array<[string, string, number, string]> = [
    [ATTACHMENT.personalUnique, NOTE.personalTrash1, 10, PATH.personalUnique],
    [ATTACHMENT.personalSharedDeleted, NOTE.personalTrash2, 20, PATH.shared],
    [ATTACHMENT.personalSharedLive, NOTE.personalActive, 20, PATH.shared],
    [ATTACHMENT.workspace, NOTE.workspaceTrash1, 30, PATH.workspace],
  ];
  for (const [id, noteId, size, attachmentPath] of attachments) {
    await pool.query(
      `INSERT INTO attachments (id, "noteId", "userId", filename, "mimeType", size, path)
       VALUES ($1, $2, $3, $1, 'image/png', $4, $5)`,
      [id, noteId, OWNER, size, attachmentPath],
    );
  }

  await pool.query(
    `INSERT INTO tags (id, "userId", name, "workspaceId")
     VALUES ($1, $2, 'personal-unused', NULL), ($3, $2, 'personal-kept', NULL),
            ($4, $2, 'workspace-unused', $5), ($6, $2, 'workspace-kept', $5)`,
    [TAG.personalUnused, OWNER, TAG.personalKept, TAG.workspaceUnused, WORKSPACE, TAG.workspaceKept],
  );
  await pool.query(
    `INSERT INTO note_tags ("noteId", "tagId") VALUES ($1, $2), ($3, $4), ($5, $6), ($7, $8)`,
    [
      NOTE.personalTrash1, TAG.personalUnused,
      NOTE.personalActive, TAG.personalKept,
      NOTE.workspaceTrash1, TAG.workspaceUnused,
      NOTE.workspaceActive, TAG.workspaceKept,
    ],
  );
  await pool.query(
    `INSERT INTO favorites ("userId", "noteId") VALUES ($1, $2), ($1, $3)`,
    [OWNER, NOTE.personalTrash1, NOTE.workspaceTrash1],
  );
  await pool.query(
    `INSERT INTO note_versions (
       id, "noteId", "userId", title, content, "contentText", "contentFormat", version
     ) VALUES ('pg-trash-personal-version', $1, $3, 'Old', '# Old', 'Old', 'markdown', 0),
              ('pg-trash-workspace-version', $2, $3, 'Old W', '# Old W', 'Old W', 'markdown', 0)`,
    [NOTE.personalTrash1, NOTE.workspaceTrash1, OWNER],
  );
  await pool.query(
    `INSERT INTO note_ysnapshots ("noteId", snapshot_blob, "updatesMergedTo") VALUES ($1, $2, 0)`,
    [NOTE.personalTrash1, Buffer.from([1, 2, 3])],
  );
  await pool.query(
    `INSERT INTO note_yupdates ("noteId", "userId", update_blob, clock) VALUES ($1, $2, $3, 1)`,
    [NOTE.personalTrash1, OWNER, Buffer.from([4, 5, 6])],
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
    const result = await createNoteDeletionRuntime(new PostgresAdapter(pool)).emptyTrash(OWNER);

    assert.equal(result.count, 2);
    assert.equal(result.skipped, 1);
    assert.deepEqual(result.noteIds, [NOTE.personalTrash1, NOTE.personalTrash2]);
    assert.equal(result.attachmentCount, 2);
    assert.equal(result.skippedSharedPaths, 1);
    assert.deepEqual(result.cleanupWarnings, []);
    assert.equal(result.walTruncated, false);
    assert.equal(result.incrementalVacuumed, false);
    assert.equal(result.vacuumed, false);
    assert.ok(result.freedBytesEstimate > 0);

    assert.equal(await count(pool, `SELECT COUNT(*) FROM notes WHERE id = ANY($1::text[])`, [[NOTE.personalTrash1, NOTE.personalTrash2]]), 0);
    assert.equal(await count(pool, `SELECT COUNT(*) FROM notes WHERE id = ANY($1::text[])`, [[NOTE.personalLocked, NOTE.personalActive]]), 2);
    assert.equal(await count(pool, `SELECT COUNT(*) FROM notes WHERE "workspaceId" = $1`, [WORKSPACE]), 4);
    assert.equal(await count(pool, `SELECT COUNT(*) FROM attachments WHERE id = $1`, [ATTACHMENT.personalSharedLive]), 1);
    assert.equal(await count(pool, `SELECT COUNT(*) FROM note_versions WHERE "noteId" = $1`, [NOTE.personalTrash1]), 0);
    assert.equal(await count(pool, `SELECT COUNT(*) FROM note_ysnapshots WHERE "noteId" = $1`, [NOTE.personalTrash1]), 0);
    assert.equal(await count(pool, `SELECT COUNT(*) FROM note_yupdates WHERE "noteId" = $1`, [NOTE.personalTrash1]), 0);
    assert.equal(await count(pool, `SELECT COUNT(*) FROM tags WHERE id = $1`, [TAG.personalUnused]), 0);
    assert.equal(await count(pool, `SELECT COUNT(*) FROM tags WHERE id = $1`, [TAG.personalKept]), 1);
    assert.equal(await count(pool, `SELECT COUNT(*) FROM tags WHERE id = $1`, [TAG.workspaceUnused]), 1);
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

    const response = await createNotesRuntimeRouter(adapter, "postgres").request(
      `/trash/empty?workspaceId=${WORKSPACE}`,
      { method: "DELETE", headers: { "X-User-Id": ADMIN } },
    );
    assert.equal(response.status, 200);
    const result = await response.json() as { count: number; skipped: number; noteIds: string[] };
    assert.equal(result.count, 2);
    assert.equal(result.skipped, 1);
    assert.deepEqual(result.noteIds, [NOTE.workspaceTrash1, NOTE.workspaceTrash2]);

    assert.equal(await count(pool, `SELECT COUNT(*) FROM notes WHERE id = ANY($1::text[])`, [[NOTE.workspaceTrash1, NOTE.workspaceTrash2]]), 0);
    assert.equal(await count(pool, `SELECT COUNT(*) FROM notes WHERE id = ANY($1::text[])`, [[NOTE.workspaceLocked, NOTE.workspaceActive]]), 2);
    assert.equal(await count(pool, `SELECT COUNT(*) FROM tags WHERE id = $1`, [TAG.workspaceUnused]), 0);
    assert.equal(await count(pool, `SELECT COUNT(*) FROM tags WHERE id = $1`, [TAG.workspaceKept]), 1);
    assert.equal(await count(
      pool,
      `SELECT COUNT(*) FROM notes WHERE "userId" = $1 AND "workspaceId" IS NULL`,
      [OWNER],
    ), 4);
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
      cleanupAttachments: async () => { throw new Error("simulated object store outage"); },
      destroyYDoc: (noteId) => { throw new Error(`simulated Yjs cleanup failure ${noteId}`); },
    });

    const result = await runtime.emptyTrash(OWNER, "personal");
    assert.equal(result.count, 2);
    assert.equal(result.cleanupWarnings.length, 3);
    assert.match(result.cleanupWarnings[0], /object store outage/);
    assert.match(result.cleanupWarnings[1], /Yjs cleanup failure/);
    assert.match(result.cleanupWarnings[2], /Yjs cleanup failure/);
    assert.equal(await count(pool, `SELECT COUNT(*) FROM notes WHERE id = ANY($1::text[])`, [[NOTE.personalTrash1, NOTE.personalTrash2]]), 0);
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
          await this.execute(`UPDATE notes SET "isLocked" = 1 WHERE id = ?`, [NOTE.personalTrash2]);
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
    assert.equal(await count(pool, `SELECT COUNT(*) FROM notes WHERE id = ANY($1::text[])`, [[NOTE.personalTrash1, NOTE.personalTrash2]]), 2);
  } finally {
    await closePgPool(pool);
  }
});
