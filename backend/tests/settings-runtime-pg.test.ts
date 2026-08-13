import assert from "node:assert/strict";
import test from "node:test";

import { Hono } from "hono";

import { signLoginToken } from "../src/lib/auth-security";
import { PostgresAdapter } from "../src/db/postgresAdapter";
import createSettingsRuntimeRouter from "../src/routes/settings-runtime";
import { closePgPool, getPgPool, hasPg, initPgSchema } from "./helpers/pg-test-db";

const ADMIN_ID = "pg-settings-admin";
const USER_ID = "pg-settings-user";
const ADMIN_SESSION = "pg-settings-admin-session";
const USER_SESSION = "pg-settings-user-session";

async function resetFixture(pool: import("pg").Pool) {
  await pool.query(`DELETE FROM user_sessions WHERE "userId" = ANY($1::text[])`, [[ADMIN_ID, USER_ID]]);
  await pool.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [[ADMIN_ID, USER_ID]]);
  await pool.query(`DELETE FROM system_settings WHERE key LIKE 'site_%' OR key LIKE 'editor_%' OR key LIKE 'feature_%' OR key LIKE 'debug_%' OR key = 'web_ui_enabled'`);

  await pool.query(
    `INSERT INTO users (id, username, "passwordHash", role, "tokenVersion") VALUES
       ($1, 'pg_settings_admin', 'hash', 'admin', 0),
       ($2, 'pg_settings_user', 'hash', 'user', 0)`,
    [ADMIN_ID, USER_ID],
  );
  await pool.query(
    `INSERT INTO user_sessions (id, "userId", "expiresAt", ip, "userAgent") VALUES
       ($1, $2, NOW() + INTERVAL '1 day', '', 'test'),
       ($3, $4, NOW() + INTERVAL '1 day', '', 'test')`,
    [ADMIN_SESSION, ADMIN_ID, USER_SESSION, USER_ID],
  );
}

function bearer(userId: string, username: string, sessionId: string) {
  return `Bearer ${signLoginToken({ userId, username, tokenVersion: 0, jti: sessionId })}`;
}

test("PostgreSQL settings runtime supports public boot settings and authenticated updates", { skip: !hasPg }, async () => {
  const pool = await getPgPool();
  assert.ok(pool);
  try {
    await initPgSchema(pool);
    await resetFixture(pool);

    const adapter = new PostgresAdapter(pool);
    const app = new Hono();
    app.route("/api/settings", createSettingsRuntimeRouter(adapter, {
      ...process.env,
      NOWEN_ICP_BEIAN: "粤ICP备12345678号",
      PUBLIC_WEB_ORIGIN: "https://notes.example.test",
    }));

    const initial = await app.request("/api/settings");
    assert.equal(initial.status, 200);
    assert.equal(initial.headers.get("cache-control"), "no-store");
    const initialBody = await initial.json() as Record<string, string>;
    assert.equal(initialBody.site_title, "nowen-note");
    assert.equal(initialBody.site_icp_beian, "粤ICP备12345678号");
    assert.equal(initialBody.site_public_web_origin, "https://notes.example.test");
    assert.equal(initialBody.site_public_web_origin_source, "environment");
    assert.equal(initialBody.editor_font_family, "");

    const unauthenticated = await app.request("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ site_title: "Blocked" }),
    });
    assert.equal(unauthenticated.status, 401);

    const regularUser = await app.request("/api/settings", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: bearer(USER_ID, "pg_settings_user", USER_SESSION),
      },
      body: JSON.stringify({ site_title: "Blocked" }),
    });
    assert.equal(regularUser.status, 403);

    const fontUpdate = await app.request("/api/settings", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: bearer(USER_ID, "pg_settings_user", USER_SESSION),
      },
      body: JSON.stringify({ editor_font_family: "__mono" }),
    });
    assert.equal(fontUpdate.status, 200);
    assert.equal(((await fontUpdate.json()) as Record<string, string>).editor_font_family, "__mono");

    const adminUpdate = await app.request("/api/settings", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: bearer(ADMIN_ID, "pg_settings_admin", ADMIN_SESSION),
      },
      body: JSON.stringify({
        site_title: "Nowen PG",
        site_public_web_origin: "https://public.example.test/app/",
        debug_files_query: true,
        web_ui_enabled: false,
        site_icp_beian: "不能由 API 修改",
      }),
    });
    assert.equal(adminUpdate.status, 200);
    const updated = await adminUpdate.json() as Record<string, string>;
    assert.equal(updated.site_title, "Nowen PG");
    assert.equal(updated.site_public_web_origin, "https://public.example.test/app");
    assert.equal(updated.site_public_web_origin_source, "settings");
    assert.equal(updated.debug_files_query, "true");
    assert.equal(updated.web_ui_enabled, "false");
    assert.equal(updated.site_icp_beian, "粤ICP备12345678号");

    const persisted = await pool.query(
      `SELECT key, value FROM system_settings WHERE key = ANY($1::text[]) ORDER BY key`,
      [["site_title", "site_public_web_origin", "site_public_web_origin_source", "site_icp_beian"]],
    );
    const persistedMap = new Map(persisted.rows.map((row) => [row.key, row.value]));
    assert.equal(persistedMap.get("site_title"), "Nowen PG");
    assert.equal(persistedMap.get("site_public_web_origin"), "https://public.example.test/app");
    assert.equal(persistedMap.get("site_public_web_origin_source"), "settings");
    assert.equal(persistedMap.get("site_icp_beian"), "粤ICP备12345678号");
  } finally {
    await pool.query(`DELETE FROM user_sessions WHERE "userId" = ANY($1::text[])`, [[ADMIN_ID, USER_ID]]).catch(() => {});
    await pool.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [[ADMIN_ID, USER_ID]]).catch(() => {});
    await closePgPool(pool);
  }
});
