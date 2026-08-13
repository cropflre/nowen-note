import assert from "node:assert/strict";
import test from "node:test";

import { Hono } from "hono";

import { PostgresAdapter } from "../src/db/postgresAdapter";
import createTagsRuntimeRouter from "../src/routes/tags-runtime";
import { closePgPool, getPgPool, hasPg, initPgSchema } from "./helpers/pg-test-db";

const OWNER = "pg-tags-owner";
const EDITOR = "pg-tags-editor";
const VIEWER = "pg-tags-viewer";
const OUTSIDER = "pg-tags-outsider";
const WORKSPACE = "pg-tags-workspace";
const PERSONAL_NOTEBOOK = "pg-tags-personal-notebook";
const WORKSPACE_NOTEBOOK = "pg-tags-workspace-notebook";
const PERSONAL_NOTE = "pg-tags-personal-note";
const WORKSPACE_NOTE = "pg-tags-workspace-note";

async function resetFixture(pool: import("pg").Pool) {
  await pool.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [[OWNER, EDITOR, VIEWER, OUTSIDER]]);

  await pool.query(
    `INSERT INTO users (id, username, "passwordHash", "tokenVersion") VALUES
       ($1, 'pg_tags_owner', 'hash', 0),
       ($2, 'pg_tags_editor', 'hash', 0),
       ($3, 'pg_tags_viewer', 'hash', 0),
       ($4, 'pg_tags_outsider', 'hash', 0)`,
    [OWNER, EDITOR, VIEWER, OUTSIDER],
  );
  await pool.query(
    `INSERT INTO workspaces (id, name, "ownerId") VALUES ($1, 'Tags Workspace', $2)`,
    [WORKSPACE, OWNER],
  );
  await pool.query(
    `INSERT INTO workspace_members ("workspaceId", "userId", role) VALUES
       ($1, $2, 'owner'),
       ($1, $3, 'editor'),
       ($1, $4, 'viewer')`,
    [WORKSPACE, OWNER, EDITOR, VIEWER],
  );
  await pool.query(
    `INSERT INTO notebooks (id, "userId", name, "workspaceId") VALUES
       ($1, $2, 'Personal', NULL),
       ($3, $2, 'Workspace', $4)`,
    [PERSONAL_NOTEBOOK, OWNER, WORKSPACE_NOTEBOOK, WORKSPACE],
  );
  await pool.query(
    `INSERT INTO notes (
       id, "userId", "notebookId", title, content, "contentText", "contentFormat", "workspaceId"
     ) VALUES
       ($1, $2, $3, 'Personal note', '{}', '', 'tiptap-json', NULL),
       ($4, $2, $5, 'Workspace note', '{}', '', 'tiptap-json', $6)`,
    [PERSONAL_NOTE, OWNER, PERSONAL_NOTEBOOK, WORKSPACE_NOTE, WORKSPACE_NOTEBOOK, WORKSPACE],
  );
}

function createApp(adapter: PostgresAdapter) {
  const app = new Hono();
  app.route("/api/tags", createTagsRuntimeRouter(adapter));
  return app;
}

async function jsonRequest(
  app: Hono,
  path: string,
  userId: string,
  method: string,
  body?: Record<string, unknown>,
) {
  return app.request(path, {
    method,
    headers: {
      "X-User-Id": userId,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

test("PostgreSQL tag runtime preserves scoped idempotency, ACL and note-link mutations", { skip: !hasPg }, async () => {
  const pool = await getPgPool();
  assert.ok(pool);
  try {
    await initPgSchema(pool);
    await resetFixture(pool);
    const app = createApp(new PostgresAdapter(pool));

    const personal = await jsonRequest(app, "/api/tags", OWNER, "POST", {
      name: "  Personal Tag  ",
      color: "#123456",
    });
    const personalText = await personal.text();
    assert.equal(personal.status, 201, personalText);
    const personalTag = JSON.parse(personalText) as { id: string; name: string; userId: string; workspaceId: null };
    assert.equal(personalTag.name, "Personal Tag");
    assert.equal(personalTag.userId, OWNER);
    assert.equal(personalTag.workspaceId, null);

    const idempotent = await jsonRequest(app, "/api/tags", OWNER, "POST", {
      name: "personal tag",
      color: "#ffffff",
    });
    assert.equal(idempotent.status, 200);
    assert.equal(((await idempotent.json()) as any).id, personalTag.id);

    const raceResponses = await Promise.all(
      Array.from({ length: 8 }, (_, index) => jsonRequest(app, "/api/tags", OWNER, "POST", {
        name: index % 2 === 0 ? "Race Tag" : "  race tag  ",
      })),
    );
    assert.ok(raceResponses.every((response) => response.status === 200 || response.status === 201));
    const raceBodies = await Promise.all(raceResponses.map((response) => response.json() as Promise<{ id: string }>));
    assert.equal(new Set(raceBodies.map((row) => row.id)).size, 1);
    const raceCount = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM tags
        WHERE "userId" = $1 AND "workspaceId" IS NULL AND lower(trim(name)) = 'race tag'`,
      [OWNER],
    );
    assert.equal(Number(raceCount.rows[0].count), 1);

    const personalForbidden = await jsonRequest(app, `/api/tags/${personalTag.id}`, OUTSIDER, "PUT", {
      name: "stolen",
    });
    assert.equal(personalForbidden.status, 403);

    const viewerCreate = await jsonRequest(app, "/api/tags", VIEWER, "POST", {
      name: "viewer denied",
      workspaceId: WORKSPACE,
    });
    assert.equal(viewerCreate.status, 403);

    const workspaceCreate = await jsonRequest(app, "/api/tags", EDITOR, "POST", {
      name: "Workspace Tag",
      color: "#abcdef",
      workspaceId: WORKSPACE,
    });
    const workspaceText = await workspaceCreate.text();
    assert.equal(workspaceCreate.status, 201, workspaceText);
    const workspaceTag = JSON.parse(workspaceText) as { id: string; workspaceId: string; userId: string };
    assert.equal(workspaceTag.workspaceId, WORKSPACE);
    assert.equal(workspaceTag.userId, EDITOR);

    const workspaceUpdate = await jsonRequest(app, `/api/tags/${workspaceTag.id}`, EDITOR, "PUT", {
      name: "Workspace Renamed",
      color: "#fedcba",
    });
    assert.equal(workspaceUpdate.status, 200);
    const updated = await workspaceUpdate.json() as any;
    assert.equal(updated.name, "Workspace Renamed");
    assert.equal(updated.color, "#fedcba");

    const secondWorkspace = await jsonRequest(app, "/api/tags", OWNER, "POST", {
      name: "Already Exists",
      workspaceId: WORKSPACE,
    });
    assert.ok(secondWorkspace.status === 200 || secondWorkspace.status === 201);

    const renameConflict = await jsonRequest(app, `/api/tags/${workspaceTag.id}`, EDITOR, "PUT", {
      name: "  already exists  ",
    });
    assert.equal(renameConflict.status, 409);

    const viewerUpdate = await jsonRequest(app, `/api/tags/${workspaceTag.id}`, VIEWER, "PUT", {
      color: "#000000",
    });
    assert.equal(viewerUpdate.status, 403);

    const link = await jsonRequest(
      app,
      `/api/tags/note/${WORKSPACE_NOTE}/tag/${workspaceTag.id}`,
      EDITOR,
      "POST",
    );
    assert.equal(link.status, 200);
    const linkAgain = await jsonRequest(
      app,
      `/api/tags/note/${WORKSPACE_NOTE}/tag/${workspaceTag.id}`,
      EDITOR,
      "POST",
    );
    assert.equal(linkAgain.status, 200);
    const linkCount = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM note_tags WHERE "noteId" = $1 AND "tagId" = $2`,
      [WORKSPACE_NOTE, workspaceTag.id],
    );
    assert.equal(Number(linkCount.rows[0].count), 1);

    const crossScope = await jsonRequest(
      app,
      `/api/tags/note/${PERSONAL_NOTE}/tag/${workspaceTag.id}`,
      EDITOR,
      "POST",
    );
    assert.equal(crossScope.status, 400);

    const unlink = await jsonRequest(
      app,
      `/api/tags/note/${WORKSPACE_NOTE}/tag/${workspaceTag.id}`,
      EDITOR,
      "DELETE",
    );
    assert.equal(unlink.status, 200);
    const unlinkedCount = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM note_tags WHERE "noteId" = $1 AND "tagId" = $2`,
      [WORKSPACE_NOTE, workspaceTag.id],
    );
    assert.equal(Number(unlinkedCount.rows[0].count), 0);

    const relink = await jsonRequest(
      app,
      `/api/tags/note/${WORKSPACE_NOTE}/tag/${workspaceTag.id}`,
      EDITOR,
      "POST",
    );
    assert.equal(relink.status, 200);
    const deleteTag = await jsonRequest(app, `/api/tags/${workspaceTag.id}`, EDITOR, "DELETE");
    assert.equal(deleteTag.status, 200);

    const gone = await pool.query(`SELECT id FROM tags WHERE id = $1`, [workspaceTag.id]);
    assert.equal(gone.rowCount, 0);
    const linksGone = await pool.query(`SELECT 1 FROM note_tags WHERE "tagId" = $1`, [workspaceTag.id]);
    assert.equal(linksGone.rowCount, 0);
  } finally {
    await pool.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [[OWNER, EDITOR, VIEWER, OUTSIDER]]).catch(() => {});
    await closePgPool(pool);
  }
});
