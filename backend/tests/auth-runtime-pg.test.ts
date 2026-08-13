import assert from "node:assert/strict";
import test from "node:test";
import bcrypt from "bcryptjs";
import { Hono } from "hono";

import { PostgresAdapter } from "../src/db/postgresAdapter";
import createAuthRuntimeRouter from "../src/routes/auth-runtime";
import { closePgPool, getPgPool, hasPg, initPgSchema } from "./helpers/pg-test-db";

const ADMIN_ID = "pg-auth-admin";
const ADMIN_USERNAME = "pg_auth_admin";
const USERNAME = "pg_auth_user";
const PASSWORD = "correct-horse-123";

async function resetAuthFixture(pool: import("pg").Pool) {
  await pool.query(`DELETE FROM user_sessions WHERE "userId" IN (SELECT id FROM users WHERE username IN ($1, $2))`, [ADMIN_USERNAME, USERNAME]);
  await pool.query(`DELETE FROM users WHERE username IN ($1, $2)`, [ADMIN_USERNAME, USERNAME]);
  await pool.query(`DELETE FROM system_settings WHERE key = 'auth_allow_registration'`);

  const adminHash = await bcrypt.hash("admin-password-123", 4);
  await pool.query(
    `INSERT INTO users (id, username, "passwordHash", role, "tokenVersion") VALUES ($1, $2, $3, 'admin', 0)`,
    [ADMIN_ID, ADMIN_USERNAME, adminHash],
  );
  await pool.query(
    `INSERT INTO system_settings (key, value) VALUES ('auth_allow_registration', '1')
     ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value`,
  );
}

function createApp(adapter: PostgresAdapter) {
  const app = new Hono();
  app.route("/api/auth", createAuthRuntimeRouter(adapter));
  return app;
}

test("PostgreSQL auth runtime supports register, login, verify, refresh, sessions and logout", { skip: !hasPg }, async () => {
  const pool = await getPgPool();
  assert.ok(pool);
  try {
    await initPgSchema(pool);
    await resetAuthFixture(pool);
    const app = createApp(new PostgresAdapter(pool));

    const config = await app.request("/api/auth/register/config");
    const configText = await config.text();
    assert.equal(config.status, 200, configText);
    const configBody = JSON.parse(configText) as { allowRegistration: boolean; hasUsers: boolean };
    assert.equal(configBody.allowRegistration, true);
    assert.equal(configBody.hasUsers, true);

    const register = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "pg-auth-test" },
      body: JSON.stringify({
        username: USERNAME,
        password: PASSWORD,
        email: "pg-auth@example.test",
        displayName: "PG Auth User",
      }),
    });
    const registerText = await register.text();
    assert.equal(register.status, 201, registerText);
    const registered = JSON.parse(registerText) as { token: string; refreshToken: string; user: { username: string; role: string } };
    assert.equal(registered.user.username, USERNAME);
    assert.equal(registered.user.role, "user");
    assert.ok(registered.token);
    assert.ok(registered.refreshToken);

    const wrong = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: USERNAME, password: "wrong-password" }),
    });
    assert.equal(wrong.status, 401);

    const login = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "pg-auth-test" },
      body: JSON.stringify({ username: USERNAME, password: PASSWORD, deviceId: "test-device" }),
    });
    const loginText = await login.text();
    assert.equal(login.status, 200, loginText);
    const loggedIn = JSON.parse(loginText) as { token: string; refreshToken: string; user: { username: string } };
    assert.equal(loggedIn.user.username, USERNAME);

    const verify = await app.request("/api/auth/verify", {
      headers: { Authorization: `Bearer ${loggedIn.token}` },
    });
    const verifyText = await verify.text();
    assert.equal(verify.status, 200, verifyText);
    assert.equal((JSON.parse(verifyText) as any).user.username, USERNAME);

    const sessions = await app.request("/api/auth/sessions", {
      headers: { Authorization: `Bearer ${loggedIn.token}` },
    });
    const sessionsText = await sessions.text();
    assert.equal(sessions.status, 200, sessionsText);
    const sessionBody = JSON.parse(sessionsText) as { sessions: Array<{ id: string; current: boolean }>; currentSessionId: string };
    assert.ok(sessionBody.sessions.some((session) => session.current));
    assert.ok(sessionBody.currentSessionId);

    const refresh = await app.request("/api/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: loggedIn.refreshToken }),
    });
    const refreshText = await refresh.text();
    assert.equal(refresh.status, 200, refreshText);
    assert.ok((JSON.parse(refreshText) as any).token);

    const logout = await app.request("/api/auth/logout", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${loggedIn.token}` },
      body: JSON.stringify({ refreshToken: loggedIn.refreshToken }),
    });
    assert.equal(logout.status, 200);

    const verifyAfterLogout = await app.request("/api/auth/verify", {
      headers: { Authorization: `Bearer ${loggedIn.token}` },
    });
    assert.equal(verifyAfterLogout.status, 401);
  } finally {
    await pool.query(`DELETE FROM users WHERE username IN ($1, $2)`, [ADMIN_USERNAME, USERNAME]);
    await pool.query(`DELETE FROM system_settings WHERE key = 'auth_allow_registration'`);
    await closePgPool(pool);
  }
});
