import assert from "node:assert/strict";
import test from "node:test";

import { Hono } from "hono";

import { initializeDatabase, resetDatabaseRuntimeForTests } from "../src/db/runtime";
import { PostgresAdapter } from "../src/db/postgresAdapter";
import createMeRuntimeRouter from "../src/routes/me-runtime";
import createWorkspacesRuntimeRouter from "../src/routes/workspaces-runtime";
import userPreferencesSyncRoutes from "../src/routes/user-preferences-sync";
import { closePgPool, getPgPool, hasPg, initPgSchema } from "./helpers/pg-test-db";

const USER_ID = "pg-startup-user";
const OTHER_ID = "pg-startup-other";
const WORKSPACE_ID = "pg-startup-workspace";
const OTHER_WORKSPACE_ID = "pg-startup-other-workspace";
const NOTEBOOK_ID = "pg-startup-notebook";

async function resetFixture(pool: import("pg").Pool) {
  await pool.query(`DELETE FROM user_preferences WHERE "userId" = ANY($1::text[])`, [[USER_ID, OTHER_ID]]);
  await pool.query(`DELETE FROM notebooks WHERE id = $1 OR "workspaceId" = ANY($2::text[])`, [NOTEBOOK_ID, [WORKSPACE_ID, OTHER_WORKSPACE_ID]]);
  await pool.query(`DELETE FROM workspace_members WHERE "workspaceId" = ANY($1::text[]) OR "userId" = ANY($2::text[])`, [[WORKSPACE_ID, OTHER_WORKSPACE_ID], [USER_ID, OTHER_ID]]);
  await pool.query(`DELETE FROM workspaces WHERE id = ANY($1::text[])`, [[WORKSPACE_ID, OTHER_WORKSPACE_ID]]);
  await pool.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [[USER_ID, OTHER_ID]]);

  await pool.query(
    `INSERT INTO users (
       id, username, email, "passwordHash", role, "displayName", "isDemo",
       "personalExportEnabled", "personalImportEnabled", "tokenVersion"
     ) VALUES
       ($1, 'pg_startup_user', 'startup@example.test', 'hash', 'user', 'Startup User', false, false, true, 0),
       ($2, 'pg_startup_other', 'other@example.test', 'hash', 'user', 'Other User', false, true, true, 0)`,
    [USER_ID, OTHER_ID],
  );

  await pool.query(
    `INSERT INTO workspaces (id, name, description, icon, "ownerId", "enabledFeatures") VALUES
       ($1, 'Joined Workspace', 'joined', 'not-an-emoji', $2, ''),
       ($3, 'Other Workspace', 'other', '🚀', $4, '')`,
    [WORKSPACE_ID, USER_ID, OTHER_WORKSPACE_ID, OTHER_ID],
  );

  await pool.query(
    `INSERT INTO workspace_members ("workspaceId", "userId", role) VALUES
       ($1, $2, 'owner'),
       ($1, $3, 'viewer'),
       ($4, $3, 'owner')`,
    [WORKSPACE_ID, USER_ID, OTHER_ID, OTHER_WORKSPACE_ID],
  );

  await pool.query(
    `INSERT INTO notebooks (id, "userId", name, "workspaceId") VALUES ($1, $2, 'Startup Notebook', $3)`,
    [NOTEBOOK_ID, USER_ID, WORKSPACE_ID],
  );
}

test("PostgreSQL authenticated startup surfaces provide me, preferences and workspace list", { skip: !hasPg }, async () => {
  const pool = await getPgPool();
  assert.ok(pool);
  try {
    await initPgSchema(pool);
    await resetFixture(pool);

    await resetDatabaseRuntimeForTests();
    await initializeDatabase({
      env: {
        ...process.env,
        DB_DRIVER: "postgres",
        DATABASE_URL: process.env.TEST_PG_DATABASE_URL,
      },
      dependencies: { logger: { log() {}, warn() {} } },
    });

    const adapter = new PostgresAdapter(pool);
    const app = new Hono();
    app.route("/api/me", createMeRuntimeRouter(adapter));
    app.route("/api/user-preferences", userPreferencesSyncRoutes);
    app.route("/api/workspaces", createWorkspacesRuntimeRouter(adapter));

    const me = await app.request("/api/me", { headers: { "X-User-Id": USER_ID } });
    assert.equal(me.status, 200);
    const meBody = await me.json() as Record<string, any>;
    assert.equal(meBody.id, USER_ID);
    assert.equal(meBody.username, "pg_startup_user");
    assert.equal(meBody.role, "user");
    assert.equal(meBody.isDemo, false);
    assert.equal(meBody.personalExportEnabled, false);
    assert.equal(meBody.personalImportEnabled, true);

    const prefsInitial = await app.request("/api/user-preferences", { headers: { "X-User-Id": USER_ID } });
    assert.equal(prefsInitial.status, 200);
    const initialPrefs = await prefsInitial.json() as Record<string, any>;
    assert.equal(initialPrefs.userId, USER_ID);
    assert.equal(initialPrefs.hasPreferences, false);
    assert.equal(initialPrefs.revision, 0);
    assert.equal(initialPrefs.readingDensity, "cozy");

    const prefsUpdate = await app.request("/api/user-preferences", {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-User-Id": USER_ID },
      body: JSON.stringify({ readingDensity: "compact", enableNoteTabs: true, _baseRevision: 0 }),
    });
    assert.equal(prefsUpdate.status, 200);
    const updatedPrefs = await prefsUpdate.json() as Record<string, any>;
    assert.equal(updatedPrefs.hasPreferences, true);
    assert.equal(updatedPrefs.revision, 1);
    assert.equal(updatedPrefs.readingDensity, "compact");
    assert.equal(updatedPrefs.enableNoteTabs, true);

    const workspaces = await app.request("/api/workspaces", { headers: { "X-User-Id": USER_ID } });
    assert.equal(workspaces.status, 200);
    const workspaceBody = await workspaces.json() as Array<Record<string, any>>;
    assert.equal(workspaceBody.length, 1);
    assert.equal(workspaceBody[0].id, WORKSPACE_ID);
    assert.equal(workspaceBody[0].role, "owner");
    assert.equal(workspaceBody[0].memberCount, 2);
    assert.equal(workspaceBody[0].notebookCount, 1);
    assert.equal(workspaceBody[0].icon, "🏢");
  } finally {
    await resetDatabaseRuntimeForTests().catch(() => {});
    await pool.query(`DELETE FROM user_preferences WHERE "userId" = ANY($1::text[])`, [[USER_ID, OTHER_ID]]).catch(() => {});
    await pool.query(`DELETE FROM notebooks WHERE id = $1 OR "workspaceId" = ANY($2::text[])`, [NOTEBOOK_ID, [WORKSPACE_ID, OTHER_WORKSPACE_ID]]).catch(() => {});
    await pool.query(`DELETE FROM workspace_members WHERE "workspaceId" = ANY($1::text[]) OR "userId" = ANY($2::text[])`, [[WORKSPACE_ID, OTHER_WORKSPACE_ID], [USER_ID, OTHER_ID]]).catch(() => {});
    await pool.query(`DELETE FROM workspaces WHERE id = ANY($1::text[])`, [[WORKSPACE_ID, OTHER_WORKSPACE_ID]]).catch(() => {});
    await pool.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [[USER_ID, OTHER_ID]]).catch(() => {});
    await closePgPool(pool);
  }
});
