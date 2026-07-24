import assert from "node:assert/strict";
import test from "node:test";

import { PostgresAdapter } from "../src/db/postgresAdapter";
import { createNotesRuntimeRouter } from "../src/routes/notes-runtime";
import { createNoteCollectionRuntime } from "../src/services/note-collection-runtime";
import { NoteCoreRuntimeError } from "../src/services/note-core-runtime";
import { closePgPool, getPgPool, hasPg, initPgSchema } from "./helpers/pg-test-db";

const OWNER = "pg-collection-owner";
const MEMBER = "pg-collection-member";
const OUTSIDER = "pg-collection-outsider";
const WORKSPACE = "pg-collection-workspace";
const PERSONAL_NOTEBOOK = "pg-collection-personal";
const ROOT_NOTEBOOK = "pg-collection-root";
const CHILD_NOTEBOOK = "pg-collection-child";
const PERSONAL_NOTE = "71111111-1111-4111-8111-111111111111";
const ROOT_NOTE = "72222222-2222-4222-8222-222222222222";
const CHILD_NOTE = "73333333-3333-4333-8333-333333333333";
const CREATED_NOTE = "74444444-4444-4444-8444-444444444444";
const TAG = "pg-collection-tag";

async function seed(pool: import("pg").Pool) {
  await pool.query(`DELETE FROM users WHERE id IN ($1, $2, $3)`, [OWNER, MEMBER, OUTSIDER]);
  await pool.query(
    `INSERT INTO users (id, username, "passwordHash", "tokenVersion")
     VALUES ($1, $1, 'hash', 0), ($2, $2, 'hash', 0), ($3, $3, 'hash', 0)`,
    [OWNER, MEMBER, OUTSIDER],
  );
  await pool.query(
    `INSERT INTO workspaces (id, "userId", name) VALUES ($1, $2, 'Collection workspace')`,
    [WORKSPACE, OWNER],
  );
  await pool.query(
    `INSERT INTO workspace_members ("workspaceId", "userId", role)
     VALUES ($1, $2, 'editor')`,
    [WORKSPACE, MEMBER],
  );
  await pool.query(
    `INSERT INTO notebooks (id, "userId", "workspaceId", "parentId", name)
     VALUES
       ($1, $2, NULL, NULL, 'Personal'),
       ($3, $2, $4, NULL, 'Root'),
       ($5, $2, $4, $3, 'Child')`,
    [PERSONAL_NOTEBOOK, OWNER, ROOT_NOTEBOOK, WORKSPACE, CHILD_NOTEBOOK],
  );
  await pool.query(
    `INSERT INTO notes (
       id, "userId", "workspaceId", "notebookId", title, content,
       "contentText", "contentFormat", "isPinned", "isTrashed"
     ) VALUES
       ($1, $2, NULL, $3, 'Personal note', '{"type":"doc","content":[]}', 'personal', 'tiptap-json', false, false),
       ($4, $2, $5, $6, 'Root note', '# Root', 'root', 'markdown', true, false),
       ($7, $2, $5, $8, 'Child note', '# Child', 'child', 'markdown', false, false)`,
    [PERSONAL_NOTE, OWNER, PERSONAL_NOTEBOOK, ROOT_NOTE, WORKSPACE, ROOT_NOTEBOOK, CHILD_NOTE, CHILD_NOTEBOOK],
  );
  await pool.query(
    `INSERT INTO favorites ("userId", "noteId", "workspaceId") VALUES ($1, $2, $3)`,
    [MEMBER, CHILD_NOTE, WORKSPACE],
  );
  await pool.query(
    `INSERT INTO tags (id, "userId", "workspaceId", name) VALUES ($1, $2, $3, 'Runtime')`,
    [TAG, OWNER, WORKSPACE],
  );
  await pool.query(
    `INSERT INTO note_tags ("noteId", "tagId") VALUES ($1, $2)`,
    [CHILD_NOTE, TAG],
  );
}

test("PostgreSQL notes collection lists scoped notes and creates normalized content", { skip: !hasPg }, async () => {
  const pool = await getPgPool();
  assert.ok(pool);
  try {
    await initPgSchema(pool);
    await seed(pool);
    const adapter = new PostgresAdapter(pool);
    const runtime = createNoteCollectionRuntime(adapter, "postgres");

    const personal = await runtime.listNotes(OWNER, {});
    assert.deepEqual(personal.map((note) => note.id), [PERSONAL_NOTE]);

    const workspace = await runtime.listNotes(MEMBER, { workspaceId: WORKSPACE });
    assert.deepEqual(workspace.map((note) => note.id), [ROOT_NOTE, CHILD_NOTE]);
    assert.equal(workspace[0].isPinned, 1);

    const descendants = await runtime.listNotes(MEMBER, { notebookId: ROOT_NOTEBOOK });
    assert.deepEqual(descendants.map((note) => note.id), [ROOT_NOTE, CHILD_NOTE]);

    const favorites = await runtime.listNotes(MEMBER, {
      workspaceId: WORKSPACE,
      isFavorite: "1",
    });
    assert.deepEqual(favorites.map((note) => note.id), [CHILD_NOTE]);
    assert.equal(favorites[0].isFavorite, 1);

    const tagged = await runtime.listNotes(MEMBER, {
      workspaceId: WORKSPACE,
      tagIds: TAG,
    });
    assert.deepEqual(tagged.map((note) => note.id), [CHILD_NOTE]);

    await assert.rejects(
      () => runtime.listNotes(MEMBER, { workspaceId: WORKSPACE, search: "child" }),
      (error: unknown) => error instanceof NoteCoreRuntimeError
        && error.code === "POSTGRES_SEARCH_MIGRATION_PENDING",
    );

    await assert.rejects(
      () => runtime.createNote(OUTSIDER, { notebookId: CHILD_NOTEBOOK, title: "No" }),
      (error: unknown) => error instanceof NoteCoreRuntimeError && error.code === "FORBIDDEN",
    );

    const created = await runtime.createNote(MEMBER, {
      id: CREATED_NOTE,
      notebookId: CHILD_NOTEBOOK,
      title: "Created markdown",
      contentFormat: "markdown",
      content: "# Heading\n\nBody",
    });
    assert.equal(created.id, CREATED_NOTE);
    assert.equal(created.permission, "write");
    assert.equal(created.workspaceId, WORKSPACE);
    assert.equal(created.contentFormat, "markdown");
    assert.match(String(created.content), /\^blk_/);
    assert.equal(created.contentText, "Heading\n\nBody");

    const stored = await pool.query(
      `SELECT content, "contentText", version FROM notes WHERE id = $1`,
      [CREATED_NOTE],
    );
    assert.equal(stored.rows[0].version, 1);
    assert.match(stored.rows[0].content, /\^blk_/);
    assert.equal(stored.rows[0].contentText, "Heading\n\nBody");

    const blocks = await pool.query(
      `SELECT "blockType", "plainText" FROM note_blocks_index
       WHERE "noteId" = $1 ORDER BY "blockOrder"`,
      [CREATED_NOTE],
    );
    assert.deepEqual(
      blocks.rows.map((row) => [row.blockType, row.plainText]),
      [["heading", "Heading"], ["paragraph", "Body"]],
    );

    await assert.rejects(
      () => runtime.createNote(MEMBER, {
        id: CREATED_NOTE,
        notebookId: CHILD_NOTEBOOK,
        title: "Duplicate",
      }),
      (error: unknown) => error instanceof NoteCoreRuntimeError && error.code === "NOTE_ID_CONFLICT",
    );

    const router = createNotesRuntimeRouter(adapter, "postgres");
    const listResponse = await router.request(`/?workspaceId=${WORKSPACE}`, {
      headers: { "X-User-Id": MEMBER },
    });
    assert.equal(listResponse.status, 200);
    const listBody = await listResponse.json() as Array<{ id: string }>;
    assert.ok(listBody.some((note) => note.id === CREATED_NOTE));
  } finally {
    await closePgPool();
  }
});
