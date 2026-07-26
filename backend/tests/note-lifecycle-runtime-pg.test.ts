import assert from "node:assert/strict";
import test from "node:test";

import { PostgresAdapter } from "../src/db/postgresAdapter";
import { createNotesRuntimeRouter } from "../src/routes/notes-runtime";
import { createNoteLifecycleRuntime } from "../src/services/note-lifecycle-runtime";
import { NoteCoreRuntimeError } from "../src/services/note-core-runtime";
import { closePgPool, getPgPool, hasPg, initPgSchema } from "./helpers/pg-test-db";

const OWNER = "pg-lifecycle-owner";
const MEMBER = "pg-lifecycle-member";
const OUTSIDER = "pg-lifecycle-outsider";
const WORKSPACE = "pg-lifecycle-workspace";
const OTHER_WORKSPACE = "pg-lifecycle-other-workspace";
const ROOT_NOTEBOOK = "pg-lifecycle-root";
const TARGET_NOTEBOOK = "pg-lifecycle-target";
const OTHER_NOTEBOOK = "pg-lifecycle-other";
const PERSONAL_NOTEBOOK = "pg-lifecycle-personal";
const NOTE = "81111111-1111-4111-8111-111111111111";
const LOCKED_NOTE = "82222222-2222-4222-8222-222222222222";
const PERSONAL_NOTE = "83333333-3333-4333-8333-333333333333";

async function seed(pool: import("pg").Pool) {
  await pool.query(`DELETE FROM users WHERE id IN ($1, $2, $3)`, [OWNER, MEMBER, OUTSIDER]);
  await pool.query(
    `INSERT INTO users (id, username, "passwordHash", "tokenVersion")
     VALUES ($1, $1, 'hash', 0), ($2, $2, 'hash', 0), ($3, $3, 'hash', 0)`,
    [OWNER, MEMBER, OUTSIDER],
  );
  await pool.query(
    `INSERT INTO workspaces (id, "ownerId", name)
     VALUES ($1, $2, 'Lifecycle workspace'), ($3, $2, 'Other workspace')`,
    [WORKSPACE, OWNER, OTHER_WORKSPACE],
  );
  await pool.query(
    `INSERT INTO workspace_members ("workspaceId", "userId", role)
     VALUES ($1, $2, 'editor')`,
    [WORKSPACE, MEMBER],
  );
  await pool.query(
    `INSERT INTO notebooks (id, "userId", "workspaceId", "parentId", name)
     VALUES
       ($1, $2, $3, NULL, 'Root'),
       ($4, $2, $3, NULL, 'Target'),
       ($5, $2, $6, NULL, 'Other'),
       ($7, $2, NULL, NULL, 'Personal')`,
    [ROOT_NOTEBOOK, OWNER, WORKSPACE, TARGET_NOTEBOOK, OTHER_NOTEBOOK, OTHER_WORKSPACE, PERSONAL_NOTEBOOK],
  );
  await pool.query(
    `INSERT INTO notes (
       id, "userId", "workspaceId", "notebookId", title, content,
       "contentText", "contentFormat", "isLocked", "isTrashed", "sortOrder"
     ) VALUES
       ($1, $2, $3, $4, 'Lifecycle note', '# Note', 'Note', 'markdown', false, false, 0),
       ($5, $2, $3, $4, 'Locked note', '# Locked', 'Locked', 'markdown', true, false, 1),
       ($6, $2, NULL, $7, 'Personal note', '# Personal', 'Personal', 'markdown', false, false, 0)`,
    [NOTE, OWNER, WORKSPACE, ROOT_NOTEBOOK, LOCKED_NOTE, PERSONAL_NOTE, PERSONAL_NOTEBOOK],
  );
}

test("PostgreSQL note lifecycle supports trash, restore, same-space move and reorder", { skip: !hasPg }, async () => {
  const pool = await getPgPool();
  assert.ok(pool);
  try {
    await initPgSchema(pool);
    await seed(pool);
    const adapter = new PostgresAdapter(pool);
    const runtime = createNoteLifecycleRuntime(adapter);

    await runtime.updateNote(MEMBER, NOTE, { isTrashed: true });
    let stored = await pool.query(
      `SELECT "isTrashed", "trashedAt", "notebookId", "sortOrder" FROM notes WHERE id = $1`,
      [NOTE],
    );
    assert.equal(stored.rows[0].isTrashed, true);
    assert.ok(stored.rows[0].trashedAt);

    await runtime.updateNote(MEMBER, NOTE, {
      isTrashed: false,
      notebookId: TARGET_NOTEBOOK,
      sortOrder: 7,
    });
    stored = await pool.query(
      `SELECT "isTrashed", "trashedAt", "notebookId", "sortOrder" FROM notes WHERE id = $1`,
      [NOTE],
    );
    assert.equal(stored.rows[0].isTrashed, false);
    assert.equal(stored.rows[0].trashedAt, null);
    assert.equal(stored.rows[0].notebookId, TARGET_NOTEBOOK);
    assert.equal(stored.rows[0].sortOrder, 7);

    const reordered = await runtime.reorderNotes(MEMBER, [
      { id: NOTE, sortOrder: 11 },
      { id: PERSONAL_NOTE, sortOrder: 12 },
    ]);
    assert.deepEqual(reordered, { success: true, updated: 1, skipped: [PERSONAL_NOTE] });
    stored = await pool.query(`SELECT "sortOrder" FROM notes WHERE id = $1`, [NOTE]);
    assert.equal(stored.rows[0].sortOrder, 11);

    await assert.rejects(
      () => runtime.updateNote(MEMBER, NOTE, { notebookId: OTHER_NOTEBOOK }),
      (error: unknown) => error instanceof NoteCoreRuntimeError
        && error.code === "CROSS_WORKSPACE_MOVE_FORBIDDEN",
    );
    await assert.rejects(
      () => runtime.updateNote(MEMBER, LOCKED_NOTE, { notebookId: TARGET_NOTEBOOK }),
      (error: unknown) => error instanceof NoteCoreRuntimeError && error.code === "NOTE_LOCKED",
    );
    await assert.rejects(
      () => runtime.updateNote(OUTSIDER, NOTE, { isTrashed: true }),
      (error: unknown) => error instanceof NoteCoreRuntimeError && error.code === "FORBIDDEN",
    );

    const router = createNotesRuntimeRouter(adapter, "postgres");
    const trashResponse = await router.request(`/${NOTE}`, {
      method: "PUT",
      headers: { "X-User-Id": MEMBER, "Content-Type": "application/json" },
      body: JSON.stringify({ isTrashed: true }),
    });
    assert.equal(trashResponse.status, 200);
    const trashBody = await trashResponse.json() as { isTrashed: number };
    assert.equal(trashBody.isTrashed, 1);

    const reorderResponse = await router.request("/reorder/batch", {
      method: "PUT",
      headers: { "X-User-Id": MEMBER, "Content-Type": "application/json" },
      body: JSON.stringify({ items: [{ id: NOTE, sortOrder: 21 }] }),
    });
    assert.equal(reorderResponse.status, 200);
    assert.deepEqual(await reorderResponse.json(), { success: true, updated: 1, skipped: [] });
  } finally {
    await closePgPool(pool);
  }
});
