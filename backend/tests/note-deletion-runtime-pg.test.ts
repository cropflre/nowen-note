import assert from "node:assert/strict";
import test from "node:test";

import { PostgresAdapter } from "../src/db/postgresAdapter";
import { createNotesRuntimeRouter } from "../src/routes/notes-runtime";
import { createNoteCoreRuntime, NoteCoreRuntimeError } from "../src/services/note-core-runtime";
import { createNoteDeletionRuntime } from "../src/services/note-deletion-runtime";
import { closePgPool, getPgPool, hasPg, initPgSchema } from "./helpers/pg-test-db";

const OWNER = "pg-delete-owner";
const ADMIN = "pg-delete-admin";
const EDITOR = "pg-delete-editor";
const OUTSIDER = "pg-delete-outsider";
const WORKSPACE = "pg-delete-workspace";
const PERSONAL_NOTEBOOK = "pg-delete-personal-notebook";
const WORKSPACE_NOTEBOOK = "pg-delete-workspace-notebook";

const PERSONAL_DELETE = "91111111-1111-4111-8111-111111111111";
const PERSONAL_SURVIVOR = "92222222-2222-4222-8222-222222222222";
const CLEANUP_FAILURE = "93333333-3333-4333-8333-333333333333";
const WORKSPACE_DELETE = "94444444-4444-4444-8444-444444444444";
const WORKSPACE_LOCKED = "95555555-5555-4555-8555-555555555555";
const WORKSPACE_ROUTE = "96666666-6666-4666-8666-666666666666";

const UNIQUE_ATTACHMENT = "97777777-7777-4777-8777-777777777777";
const SHARED_ATTACHMENT_DELETED = "98888888-8888-4888-8888-888888888888";
const SHARED_ATTACHMENT_LIVE = "99999999-9999-4999-8999-999999999999";
const FAILURE_ATTACHMENT = "9aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const UNIQUE_PATH = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png";
const SHARED_PATH = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.png";
const FAILURE_PATH = "cccccccc-cccc-4ccc-8ccc-cccccccccccc.png";
const UNUSED_TAG = "pg-delete-unused-tag";
const KEPT_TAG = "pg-delete-kept-tag";

async function seed(pool: import("pg").Pool) {
  await pool.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [[OWNER, ADMIN, EDITOR, OUTSIDER]]);
  await pool.query(
    `INSERT INTO users (id, username, "passwordHash", "tokenVersion")
     VALUES ($1, $1, 'hash', 0), ($2, $2, 'hash', 0),
            ($3, $3, 'hash', 0), ($4, $4, 'hash', 0)`,
    [OWNER, ADMIN, EDITOR, OUTSIDER],
  );
  await pool.query(
    `INSERT INTO workspaces (id, "ownerId", name) VALUES ($1, $2, 'Delete workspace')`,
    [WORKSPACE, OWNER],
  );
  await pool.query(
    `INSERT INTO workspace_members ("workspaceId", "userId", role)
     VALUES ($1, $2, 'admin'), ($1, $3, 'editor')`,
    [WORKSPACE, ADMIN, EDITOR],
  );
  await pool.query(
    `INSERT INTO notebooks (id, "userId", "workspaceId", name)
     VALUES ($1, $2, NULL, 'Personal delete'), ($3, $2, $4, 'Workspace delete')`,
    [PERSONAL_NOTEBOOK, OWNER, WORKSPACE_NOTEBOOK, WORKSPACE],
  );
  await pool.query(
    `INSERT INTO notes (
       id, "userId", "workspaceId", "notebookId", title, content,
       "contentText", "contentFormat", "isTrashed", "isLocked", version
     ) VALUES
       ($1, $2, NULL, $3, 'Delete personal', '# Delete', 'Delete', 'markdown', false, false, 1),
       ($4, $2, NULL, $3, 'Survivor', '# Survivor', 'Survivor', 'markdown', false, false, 1),
       ($5, $2, NULL, $3, 'Cleanup failure', '# Failure', 'Failure', 'markdown', true, false, 1),
       ($6, $2, $7, $8, 'Delete workspace', '# Workspace', 'Workspace', 'markdown', true, false, 1),
       ($9, $2, $7, $8, 'Locked workspace', '# Locked', 'Locked', 'markdown', true, true, 1),
       ($10, $2, $7, $8, 'Route workspace', '# Route', 'Route', 'markdown', true, false, 1)`,
    [
      PERSONAL_DELETE,
      OWNER,
      PERSONAL_NOTEBOOK,
      PERSONAL_SURVIVOR,
      CLEANUP_FAILURE,
      WORKSPACE_DELETE,
      WORKSPACE,
      WORKSPACE_NOTEBOOK,
      WORKSPACE_LOCKED,
      WORKSPACE_ROUTE,
    ],
  );
  await pool.query(
    `INSERT INTO attachments (id, "noteId", "userId", filename, "mimeType", size, path)
     VALUES
       ($1, $2, $3, 'unique.png', 'image/png', 10, $4),
       ($5, $2, $3, 'shared-deleted.png', 'image/png', 20, $6),
       ($7, $8, $3, 'shared-live.png', 'image/png', 20, $6),
       ($9, $10, $3, 'failure.png', 'image/png', 30, $11)`,
    [
      UNIQUE_ATTACHMENT,
      PERSONAL_DELETE,
      OWNER,
      UNIQUE_PATH,
      SHARED_ATTACHMENT_DELETED,
      SHARED_PATH,
      SHARED_ATTACHMENT_LIVE,
      PERSONAL_SURVIVOR,
      FAILURE_ATTACHMENT,
      CLEANUP_FAILURE,
      FAILURE_PATH,
    ],
  );
  await pool.query(
    `INSERT INTO tags (id, "userId", name, "workspaceId")
     VALUES ($1, $2, 'unused-delete', NULL), ($3, $2, 'kept-delete', NULL)`,
    [UNUSED_TAG, OWNER, KEPT_TAG],
  );
  await pool.query(
    `INSERT INTO note_tags ("noteId", "tagId")
     VALUES ($1, $2), ($1, $3), ($4, $3)`,
    [PERSONAL_DELETE, UNUSED_TAG, KEPT_TAG, PERSONAL_SURVIVOR],
  );
  await pool.query(
    `INSERT INTO favorites ("userId", "noteId") VALUES ($1, $2)`,
    [OWNER, PERSONAL_DELETE],
  );
  await pool.query(
    `INSERT INTO note_versions (
       id, "noteId", "userId", title, content, "contentText", "contentFormat", version
     ) VALUES ('pg-delete-version', $1, $2, 'Old', '# Old', 'Old', 'markdown', 0)`,
    [PERSONAL_DELETE, OWNER],
  );
  await pool.query(
    `INSERT INTO note_links (
       id, "userId", "sourceNoteId", "targetNoteId", "linkType"
     ) VALUES ('pg-delete-link', $1, $2, $3, 'note')`,
    [OWNER, PERSONAL_DELETE, PERSONAL_SURVIVOR],
  );
  await pool.query(
    `INSERT INTO note_ysnapshots ("noteId", snapshot_blob, "updatesMergedTo")
     VALUES ($1, $2, 0)`,
    [PERSONAL_DELETE, Buffer.from([1, 2, 3])],
  );
  await pool.query(
    `INSERT INTO note_yupdates ("noteId", "userId", update_blob, clock)
     VALUES ($1, $2, $3, 1)`,
    [PERSONAL_DELETE, OWNER, Buffer.from([4, 5, 6])],
  );
}

test("PostgreSQL permanent note deletion commits cascades before best-effort cleanup", { skip: !hasPg }, async () => {
  const pool = await getPgPool();
  assert.ok(pool);
  try {
    await initPgSchema(pool);
    await seed(pool);
    const adapter = new PostgresAdapter(pool);
    const runtime = createNoteDeletionRuntime(adapter);

    const deleted = await runtime.permanentDeleteNote(OWNER, PERSONAL_DELETE);
    assert.equal(deleted.success, true);
    assert.equal(deleted.attachmentCount, 2);
    assert.equal(deleted.removedFiles, 0);
    assert.equal(deleted.skippedSharedPaths, 1);
    assert.deepEqual(deleted.cleanupWarnings, []);

    assert.equal(Number((await pool.query(
      `SELECT COUNT(*)::int AS count FROM notes WHERE id = $1`,
      [PERSONAL_DELETE],
    )).rows[0].count), 0);
    for (const [table, column] of [
      ["attachments", "noteId"],
      ["favorites", "noteId"],
      ["note_versions", "noteId"],
      ["note_yupdates", "noteId"],
      ["note_ysnapshots", "noteId"],
    ] as const) {
      assert.equal(Number((await pool.query(
        `SELECT COUNT(*)::int AS count FROM ${table} WHERE "${column}" = $1`,
        [PERSONAL_DELETE],
      )).rows[0].count), 0);
    }
    assert.equal(Number((await pool.query(
      `SELECT COUNT(*)::int AS count FROM note_links
        WHERE "sourceNoteId" = $1 OR "targetNoteId" = $1`,
      [PERSONAL_DELETE],
    )).rows[0].count), 0);
    assert.equal(Number((await pool.query(
      `SELECT COUNT(*)::int AS count FROM attachments WHERE id = $1`,
      [SHARED_ATTACHMENT_LIVE],
    )).rows[0].count), 1);
    assert.equal(Number((await pool.query(
      `SELECT COUNT(*)::int AS count FROM tags WHERE id = $1`,
      [UNUSED_TAG],
    )).rows[0].count), 0);
    assert.equal(Number((await pool.query(
      `SELECT COUNT(*)::int AS count FROM tags WHERE id = $1`,
      [KEPT_TAG],
    )).rows[0].count), 1);

    await assert.rejects(
      () => runtime.permanentDeleteNote(EDITOR, WORKSPACE_DELETE),
      (error: unknown) => error instanceof NoteCoreRuntimeError && error.code === "FORBIDDEN",
    );
    await assert.rejects(
      () => runtime.permanentDeleteNote(OUTSIDER, WORKSPACE_DELETE),
      (error: unknown) => error instanceof NoteCoreRuntimeError && error.code === "FORBIDDEN",
    );
    await assert.rejects(
      () => runtime.permanentDeleteNote(ADMIN, WORKSPACE_LOCKED),
      (error: unknown) => error instanceof NoteCoreRuntimeError && error.code === "NOTE_LOCKED",
    );

    const workspaceDeleted = await runtime.permanentDeleteNote(ADMIN, WORKSPACE_DELETE);
    assert.equal(workspaceDeleted.success, true);
    assert.equal(Number((await pool.query(
      `SELECT COUNT(*)::int AS count FROM notes WHERE id = $1`,
      [WORKSPACE_DELETE],
    )).rows[0].count), 0);

    const router = createNotesRuntimeRouter(adapter, "postgres");
    const response = await router.request(`/${WORKSPACE_ROUTE}`, {
      method: "DELETE",
      headers: { "X-User-Id": ADMIN },
    });
    assert.equal(response.status, 200);
    const body = await response.json() as { success: boolean; noteId: string };
    assert.equal(body.success, true);
    assert.equal(body.noteId, WORKSPACE_ROUTE);
  } finally {
    await closePgPool(pool);
  }
});

test("post-commit cleanup failure is reported without restoring the deleted note", { skip: !hasPg }, async () => {
  const pool = await getPgPool();
  assert.ok(pool);
  try {
    await initPgSchema(pool);
    await seed(pool);
    const adapter = new PostgresAdapter(pool);
    const runtime = createNoteDeletionRuntime(adapter, {
      cleanupAttachments: async () => {
        throw new Error("simulated object store outage");
      },
      destroyYDoc: () => {
        throw new Error("simulated Yjs cleanup failure");
      },
    });

    const result = await runtime.permanentDeleteNote(OWNER, CLEANUP_FAILURE);
    assert.equal(result.success, true);
    assert.equal(result.attachmentCount, 1);
    assert.equal(result.cleanupWarnings.length, 2);
    assert.match(result.cleanupWarnings[0], /object store outage/);
    assert.match(result.cleanupWarnings[1], /Yjs cleanup failure/);
    assert.equal(Number((await pool.query(
      `SELECT COUNT(*)::int AS count FROM notes WHERE id = $1`,
      [CLEANUP_FAILURE],
    )).rows[0].count), 0);

    const core = createNoteCoreRuntime(adapter, "postgres");
    await assert.rejects(
      () => core.getNote(OWNER, CLEANUP_FAILURE),
      (error: unknown) => error instanceof NoteCoreRuntimeError && error.code === "NOT_FOUND",
    );
  } finally {
    await closePgPool(pool);
  }
});
