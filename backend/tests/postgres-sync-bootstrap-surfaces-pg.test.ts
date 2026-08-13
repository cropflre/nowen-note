import assert from "node:assert/strict";
import test from "node:test";

import { Hono } from "hono";

import { PostgresAdapter } from "../src/db/postgresAdapter";
import createNotebooksRuntimeRouter from "../src/routes/notebooks-runtime";
import createTagsRuntimeRouter from "../src/routes/tags-runtime";
import { closePgPool, getPgPool, hasPg, initPgSchema } from "./helpers/pg-test-db";

const USER = "pg-bootstrap-user";
const OTHER = "pg-bootstrap-other";
const PERSONAL_ROOT = "pg-bootstrap-personal-root";
const PERSONAL_CHILD = "pg-bootstrap-personal-child";
const OTHER_PERSONAL = "pg-bootstrap-other-personal";
const WORKSPACE = "pg-bootstrap-workspace";
const OTHER_WORKSPACE = "pg-bootstrap-other-workspace";
const WORKSPACE_ROOT = "pg-bootstrap-workspace-root";
const WORKSPACE_CHILD = "pg-bootstrap-workspace-child";
const PERSONAL_NOTE_ROOT = "pg-bootstrap-note-root";
const PERSONAL_NOTE_CHILD = "pg-bootstrap-note-child";
const WORKSPACE_NOTE = "pg-bootstrap-note-workspace";
const TAG_PERSONAL = "pg-bootstrap-tag-personal";
const TAG_PERSONAL_EMPTY = "pg-bootstrap-tag-personal-empty";
const TAG_WORKSPACE = "pg-bootstrap-tag-workspace";

async function resetFixture(pool: import("pg").Pool) {
  await pool.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [[USER, OTHER]]);

  await pool.query(
    `INSERT INTO users (id, username, "passwordHash", "tokenVersion") VALUES
       ($1, 'pg_bootstrap_user', 'hash', 0),
       ($2, 'pg_bootstrap_other', 'hash', 0)`,
    [USER, OTHER],
  );

  await pool.query(
    `INSERT INTO workspaces (id, name, "ownerId") VALUES
       ($1, 'Bootstrap Workspace', $2),
       ($3, 'Other Workspace', $4)`,
    [WORKSPACE, USER, OTHER_WORKSPACE, OTHER],
  );
  await pool.query(
    `INSERT INTO workspace_members ("workspaceId", "userId", role) VALUES
       ($1, $2, 'owner'),
       ($3, $4, 'owner')`,
    [WORKSPACE, USER, OTHER_WORKSPACE, OTHER],
  );

  await pool.query(
    `INSERT INTO notebooks (
       id, "userId", "parentId", name, "sortOrder", "workspaceId", "isDeleted"
     ) VALUES
       ($1, $2, NULL, 'Personal Root', 0, NULL, false),
       ($3, $2, $1, 'Personal Child', 1, NULL, false),
       ($4, $5, NULL, 'Other Personal', 0, NULL, false),
       ($6, $2, NULL, 'Workspace Root', 0, $7, false),
       ($8, $2, $6, 'Workspace Child', 1, $7, false)`,
    [
      PERSONAL_ROOT,
      USER,
      PERSONAL_CHILD,
      OTHER_PERSONAL,
      OTHER,
      WORKSPACE_ROOT,
      WORKSPACE,
      WORKSPACE_CHILD,
    ],
  );

  await pool.query(
    `INSERT INTO notes (
       id, "userId", "notebookId", title, content, "contentText", "contentFormat", "workspaceId", "isTrashed"
     ) VALUES
       ($1, $2, $3, 'Personal Root Note', '{}', '', 'tiptap-json', NULL, false),
       ($4, $2, $5, 'Personal Child Note', '{}', '', 'tiptap-json', NULL, false),
       ($6, $2, $7, 'Workspace Note', '{}', '', 'tiptap-json', $8, false)`,
    [
      PERSONAL_NOTE_ROOT,
      USER,
      PERSONAL_ROOT,
      PERSONAL_NOTE_CHILD,
      PERSONAL_CHILD,
      WORKSPACE_NOTE,
      WORKSPACE_CHILD,
      WORKSPACE,
    ],
  );

  await pool.query(
    `INSERT INTO tags (id, "userId", name, color, "workspaceId") VALUES
       ($1, $2, 'personal', '#111111', NULL),
       ($3, $2, 'empty', '#222222', NULL),
       ($4, $2, 'workspace', '#333333', $5)`,
    [TAG_PERSONAL, USER, TAG_PERSONAL_EMPTY, TAG_WORKSPACE, WORKSPACE],
  );
  await pool.query(
    `INSERT INTO note_tags ("noteId", "tagId") VALUES ($1, $2), ($3, $4)`,
    [PERSONAL_NOTE_CHILD, TAG_PERSONAL, WORKSPACE_NOTE, TAG_WORKSPACE],
  );
}

function appFor(adapter: PostgresAdapter) {
  const app = new Hono();
  app.route("/api/notebooks", createNotebooksRuntimeRouter(adapter));
  app.route("/api/tags", createTagsRuntimeRouter(adapter));
  return app;
}

test("PostgreSQL sync bootstrap exposes scoped recursive notebooks and tags", { skip: !hasPg }, async () => {
  const pool = await getPgPool();
  assert.ok(pool);
  try {
    await initPgSchema(pool);
    await resetFixture(pool);
    const app = appFor(new PostgresAdapter(pool));

    const personalNotebooks = await app.request("/api/notebooks", {
      headers: { "X-User-Id": USER },
    });
    assert.equal(personalNotebooks.status, 200);
    const personalRows = await personalNotebooks.json() as Array<Record<string, any>>;
    assert.deepEqual(personalRows.map((row) => row.id), [PERSONAL_ROOT, PERSONAL_CHILD]);
    assert.equal(personalRows.find((row) => row.id === PERSONAL_ROOT)?.noteCount, 2);
    assert.equal(personalRows.find((row) => row.id === PERSONAL_CHILD)?.noteCount, 1);
    assert.equal(personalRows.some((row) => row.id === OTHER_PERSONAL), false);

    const personalExplicit = await app.request("/api/notebooks?workspaceId=personal", {
      headers: { "X-User-Id": USER },
    });
    assert.equal(personalExplicit.status, 200);
    assert.deepEqual(
      (await personalExplicit.json() as Array<Record<string, any>>).map((row) => row.id),
      [PERSONAL_ROOT, PERSONAL_CHILD],
    );

    const workspaceNotebooks = await app.request(`/api/notebooks?workspaceId=${WORKSPACE}`, {
      headers: { "X-User-Id": USER },
    });
    assert.equal(workspaceNotebooks.status, 200);
    const workspaceRows = await workspaceNotebooks.json() as Array<Record<string, any>>;
    assert.deepEqual(workspaceRows.map((row) => row.id), [WORKSPACE_ROOT, WORKSPACE_CHILD]);
    assert.equal(workspaceRows.find((row) => row.id === WORKSPACE_ROOT)?.noteCount, 1);

    const forbiddenNotebooks = await app.request(`/api/notebooks?workspaceId=${OTHER_WORKSPACE}`, {
      headers: { "X-User-Id": USER },
    });
    assert.equal(forbiddenNotebooks.status, 403);

    const personalTags = await app.request("/api/tags", { headers: { "X-User-Id": USER } });
    assert.equal(personalTags.status, 200);
    const personalTagRows = await personalTags.json() as Array<Record<string, any>>;
    assert.deepEqual(personalTagRows.map((row) => row.id), [TAG_PERSONAL]);
    assert.equal(personalTagRows[0].noteCount, 1);

    const personalTagsWithEmpty = await app.request("/api/tags?includeEmpty=true", {
      headers: { "X-User-Id": USER },
    });
    assert.equal(personalTagsWithEmpty.status, 200);
    assert.deepEqual(
      (await personalTagsWithEmpty.json() as Array<Record<string, any>>).map((row) => row.id),
      [TAG_PERSONAL_EMPTY, TAG_PERSONAL],
    );

    const workspaceTags = await app.request(`/api/tags?workspaceId=${WORKSPACE}`, {
      headers: { "X-User-Id": USER },
    });
    assert.equal(workspaceTags.status, 200);
    const workspaceTagRows = await workspaceTags.json() as Array<Record<string, any>>;
    assert.deepEqual(workspaceTagRows.map((row) => row.id), [TAG_WORKSPACE]);
    assert.equal(workspaceTagRows[0].noteCount, 1);

    const forbiddenTags = await app.request(`/api/tags?workspaceId=${OTHER_WORKSPACE}`, {
      headers: { "X-User-Id": USER },
    });
    assert.equal(forbiddenTags.status, 403);
  } finally {
    await pool.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [[USER, OTHER]]).catch(() => {});
    await closePgPool(pool);
  }
});
