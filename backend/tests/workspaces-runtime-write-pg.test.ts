import assert from "node:assert/strict";
import test from "node:test";

import { Hono } from "hono";

import { PostgresAdapter } from "../src/db/postgresAdapter";
import createWorkspacesRuntimeRouter from "../src/routes/workspaces-runtime";
import { closePgPool, getPgPool, hasPg, initPgSchema } from "./helpers/pg-test-db";

const OWNER = "pg-workspace-owner";
const WS_ADMIN = "pg-workspace-admin-member";
const EDITOR = "pg-workspace-editor";
const OUTSIDER = "pg-workspace-outsider";
const SYS_ADMIN = "pg-workspace-system-admin";
const WORKSPACE = "pg-workspace-existing";
const NOTEBOOK = "pg-workspace-notebook";

async function resetFixture(pool: import("pg").Pool) {
  await pool.query(
    `DELETE FROM users WHERE id = ANY($1::text[])`,
    [[OWNER, WS_ADMIN, EDITOR, OUTSIDER, SYS_ADMIN]],
  );
  await pool.query(
    `INSERT INTO users (id, username, "passwordHash", role, "tokenVersion") VALUES
       ($1, 'pg_workspace_owner', 'hash', 'user', 0),
       ($2, 'pg_workspace_admin_member', 'hash', 'user', 0),
       ($3, 'pg_workspace_editor', 'hash', 'user', 0),
       ($4, 'pg_workspace_outsider', 'hash', 'user', 0),
       ($5, 'pg_workspace_system_admin', 'hash', 'admin', 0)`,
    [OWNER, WS_ADMIN, EDITOR, OUTSIDER, SYS_ADMIN],
  );
  await pool.query(
    `INSERT INTO workspaces (id, name, description, icon, "ownerId")
     VALUES ($1, 'Existing Workspace', 'before', '📚', $2)`,
    [WORKSPACE, OWNER],
  );
  await pool.query(
    `INSERT INTO workspace_members ("workspaceId", "userId", role) VALUES
       ($1, $2, 'owner'),
       ($1, $3, 'admin'),
       ($1, $4, 'editor')`,
    [WORKSPACE, OWNER, WS_ADMIN, EDITOR],
  );
  await pool.query(
    `INSERT INTO notebooks (id, "userId", name, "workspaceId") VALUES ($1, $2, 'Workspace Notebook', $3)`,
    [NOTEBOOK, OWNER, WORKSPACE],
  );
}

function requestJson(
  app: Hono,
  path: string,
  userId: string,
  method = "GET",
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

test("PostgreSQL workspace runtime supports atomic create, detail ACL and guarded profile updates", { skip: !hasPg }, async () => {
  const pool = await getPgPool();
  assert.ok(pool);
  try {
    await initPgSchema(pool);
    await resetFixture(pool);

    const published: Array<{ userId: string; event: Record<string, unknown> }> = [];
    const app = new Hono();
    app.route("/api/workspaces", createWorkspacesRuntimeRouter(new PostgresAdapter(pool), {
      publishToUser(userId, event) {
        published.push({ userId, event });
      },
    }));

    const invalidCreate = await requestJson(app, "/api/workspaces", OUTSIDER, "POST", {
      name: "Invalid icon",
      icon: "not-an-emoji",
    });
    assert.equal(invalidCreate.status, 400);
    assert.equal(((await invalidCreate.json()) as any).code, "INVALID_WORKSPACE_ICON");

    const createdResponse = await requestJson(app, "/api/workspaces", OUTSIDER, "POST", {
      name: "  New Workspace  ",
      description: "created in pg",
      icon: "🚀",
    });
    const createdText = await createdResponse.text();
    assert.equal(createdResponse.status, 201, createdText);
    const created = JSON.parse(createdText) as any;
    assert.ok(created.id);
    assert.equal(created.name, "New Workspace");
    assert.equal(created.description, "created in pg");
    assert.equal(created.icon, "🚀");
    assert.equal(created.ownerId, OUTSIDER);
    assert.equal(created.role, "owner");
    assert.equal(created.memberCount, 1);
    assert.equal(created.notebookCount, 0);

    const createdMembership = await pool.query<{ role: string }>(
      `SELECT role FROM workspace_members WHERE "workspaceId" = $1 AND "userId" = $2`,
      [created.id, OUTSIDER],
    );
    assert.equal(createdMembership.rowCount, 1);
    assert.equal(createdMembership.rows[0].role, "owner");

    const editorDetail = await requestJson(app, `/api/workspaces/${WORKSPACE}`, EDITOR);
    assert.equal(editorDetail.status, 200);
    const editorWorkspace = await editorDetail.json() as any;
    assert.equal(editorWorkspace.role, "editor");
    assert.equal(editorWorkspace.memberCount, 3);
    assert.equal(editorWorkspace.notebookCount, 1);

    const outsiderDetail = await requestJson(app, `/api/workspaces/${WORKSPACE}`, OUTSIDER);
    assert.equal(outsiderDetail.status, 403);

    const sysAdminDetail = await requestJson(app, `/api/workspaces/${WORKSPACE}`, SYS_ADMIN);
    assert.equal(sysAdminDetail.status, 200);
    assert.equal(((await sysAdminDetail.json()) as any).role, "owner");

    const editorUpdate = await requestJson(app, `/api/workspaces/${WORKSPACE}`, EDITOR, "PUT", {
      name: "Editor cannot rename",
    });
    assert.equal(editorUpdate.status, 403);

    const blankUpdate = await requestJson(app, `/api/workspaces/${WORKSPACE}`, WS_ADMIN, "PUT", {
      name: "   ",
    });
    assert.equal(blankUpdate.status, 400);

    const adminUpdate = await requestJson(app, `/api/workspaces/${WORKSPACE}`, WS_ADMIN, "PUT", {
      name: "  Renamed Workspace  ",
      description: "after",
      icon: "🧠",
    });
    const adminText = await adminUpdate.text();
    assert.equal(adminUpdate.status, 200, adminText);
    const updated = JSON.parse(adminText) as any;
    assert.equal(updated.name, "Renamed Workspace");
    assert.equal(updated.description, "after");
    assert.equal(updated.icon, "🧠");
    assert.equal(updated.role, "admin");

    assert.deepEqual(
      new Set(published.map((entry) => entry.userId)),
      new Set([OWNER, WS_ADMIN, EDITOR]),
    );
    assert.ok(published.every((entry) => entry.event.type === "workspace:updated"));
    published.length = 0;

    const sysAdminUpdate = await requestJson(app, `/api/workspaces/${WORKSPACE}`, SYS_ADMIN, "PUT", {
      description: "system admin update",
    });
    assert.equal(sysAdminUpdate.status, 200);
    const sysUpdated = await sysAdminUpdate.json() as any;
    assert.equal(sysUpdated.description, "system admin update");
    assert.equal(sysUpdated.role, "owner");
    assert.equal(published.length, 3);

    const missing = await requestJson(app, "/api/workspaces/does-not-exist", SYS_ADMIN);
    assert.equal(missing.status, 404);
  } finally {
    await pool.query(
      `DELETE FROM users WHERE id = ANY($1::text[])`,
      [[OWNER, WS_ADMIN, EDITOR, OUTSIDER, SYS_ADMIN]],
    ).catch(() => {});
    await closePgPool(pool);
  }
});
