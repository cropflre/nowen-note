import assert from "node:assert/strict";
import test from "node:test";

import { PostgresAdapter } from "../src/db/postgresAdapter";
import { createNotesRuntimeRouter } from "../src/routes/notes-runtime";
import { createNoteCoreRuntime, NoteCoreRuntimeError } from "../src/services/note-core-runtime";
import { createNoteLifecycleRuntime } from "../src/services/note-lifecycle-runtime";
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

const META_OWNER = "pg-metadata-owner";
const META_EDITOR = "pg-metadata-editor";
const META_OUTSIDER = "pg-metadata-outsider";
const META_WORKSPACE = "pg-metadata-workspace";
const META_NOTEBOOK = "pg-metadata-notebook";
const META_NOTE = "84444444-4444-4444-8444-444444444444";

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

async function seedMetadata(pool: import("pg").Pool) {
  await pool.query(`DELETE FROM users WHERE id IN ($1, $2, $3)`, [META_OWNER, META_EDITOR, META_OUTSIDER]);
  await pool.query(
    `INSERT INTO users (id, username, "passwordHash", "tokenVersion")
     VALUES ($1, $1, 'hash', 0), ($2, $2, 'hash', 0), ($3, $3, 'hash', 0)`,
    [META_OWNER, META_EDITOR, META_OUTSIDER],
  );
  await pool.query(
    `INSERT INTO workspaces (id, "ownerId", name) VALUES ($1, $2, 'Metadata workspace')`,
    [META_WORKSPACE, META_OWNER],
  );
  await pool.query(
    `INSERT INTO workspace_members ("workspaceId", "userId", role)
     VALUES ($1, $2, 'editor')`,
    [META_WORKSPACE, META_EDITOR],
  );
  await pool.query(
    `INSERT INTO notebooks (id, "userId", "workspaceId", name)
     VALUES ($1, $2, $3, 'Metadata notebook')`,
    [META_NOTEBOOK, META_OWNER, META_WORKSPACE],
  );
  await pool.query(
    `INSERT INTO notes (
       id, "userId", "workspaceId", "notebookId", title, content,
       "contentText", "contentFormat", version, "isPinned", "isArchived", "isLocked"
     ) VALUES ($1, $2, $3, $4, 'Metadata note', '# Metadata', 'Metadata', 'markdown', 1, false, false, false)`,
    [META_NOTE, META_OWNER, META_WORKSPACE, META_NOTEBOOK],
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

test("PostgreSQL note metadata preserves permissions, versions and per-user favorites", { skip: !hasPg }, async () => {
  const pool = await getPgPool();
  assert.ok(pool);
  try {
    await initPgSchema(pool);
    await seedMetadata(pool);
    const adapter = new PostgresAdapter(pool);
    const runtime = createNoteCoreRuntime(adapter, "postgres");

    const editorSaved = await runtime.saveNote(META_EDITOR, META_NOTE, {
      isPinned: true,
      isArchived: true,
      isFavorite: true,
    });
    assert.equal(editorSaved.note.isPinned, 1);
    assert.equal(editorSaved.note.isArchived, 1);
    assert.equal(editorSaved.note.isFavorite, 1);
    assert.equal(editorSaved.note.version, 2);

    let stored = await pool.query(
      `SELECT "isPinned", "isArchived", "isLocked", version FROM notes WHERE id = $1`,
      [META_NOTE],
    );
    assert.equal(stored.rows[0].isPinned, true);
    assert.equal(stored.rows[0].isArchived, true);
    assert.equal(stored.rows[0].isLocked, false);
    assert.equal(stored.rows[0].version, 2);
    assert.equal(Number((await pool.query(
      `SELECT COUNT(*)::int AS count FROM favorites WHERE "userId" = $1 AND "noteId" = $2`,
      [META_EDITOR, META_NOTE],
    )).rows[0].count), 1);

    const ownerView = await runtime.getNote(META_OWNER, META_NOTE);
    assert.equal(ownerView.isFavorite, 0);

    const favoriteRemoved = await runtime.saveNote(META_EDITOR, META_NOTE, { isFavorite: false });
    assert.equal(favoriteRemoved.note.isFavorite, 0);
    assert.equal(favoriteRemoved.note.version, 2);
    const favoriteRestored = await runtime.saveNote(META_EDITOR, META_NOTE, { isFavorite: true });
    assert.equal(favoriteRestored.note.isFavorite, 1);
    assert.equal(favoriteRestored.note.version, 2);

    await assert.rejects(
      () => runtime.saveNote(META_EDITOR, META_NOTE, { isLocked: true }),
      (error: unknown) => error instanceof NoteCoreRuntimeError && error.code === "FORBIDDEN",
    );
    await assert.rejects(
      () => runtime.saveNote(META_OUTSIDER, META_NOTE, { isPinned: false }),
      (error: unknown) => error instanceof NoteCoreRuntimeError && error.code === "FORBIDDEN",
    );

    const ownerLocked = await runtime.saveNote(META_OWNER, META_NOTE, { isLocked: true });
    assert.equal(ownerLocked.note.isLocked, 1);
    assert.equal(ownerLocked.note.version, 3);

    const router = createNotesRuntimeRouter(adapter, "postgres");
    const routeResponse = await router.request(`/${META_NOTE}`, {
      method: "PUT",
      headers: { "X-User-Id": META_EDITOR, "Content-Type": "application/json" },
      body: JSON.stringify({ isPinned: false, isArchived: false }),
    });
    assert.equal(routeResponse.status, 200);
    const routeBody = await routeResponse.json() as {
      isPinned: number;
      isArchived: number;
      isLocked: number;
      version: number;
    };
    assert.equal(routeBody.isPinned, 0);
    assert.equal(routeBody.isArchived, 0);
    assert.equal(routeBody.isLocked, 1);
    assert.equal(routeBody.version, 4);

    const favoriteOnlyResponse = await router.request(`/${META_NOTE}`, {
      method: "PUT",
      headers: { "X-User-Id": META_EDITOR, "Content-Type": "application/json" },
      body: JSON.stringify({ isFavorite: false }),
    });
    assert.equal(favoriteOnlyResponse.status, 200);
    const favoriteOnlyBody = await favoriteOnlyResponse.json() as { isFavorite: number; version: number };
    assert.equal(favoriteOnlyBody.isFavorite, 0);
    assert.equal(favoriteOnlyBody.version, 4);

    stored = await pool.query(
      `SELECT "isPinned", "isArchived", "isLocked", version FROM notes WHERE id = $1`,
      [META_NOTE],
    );
    assert.equal(stored.rows[0].isPinned, false);
    assert.equal(stored.rows[0].isArchived, false);
    assert.equal(stored.rows[0].isLocked, true);
    assert.equal(stored.rows[0].version, 4);
  } finally {
    await closePgPool(pool);
  }
});