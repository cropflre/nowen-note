import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Hono } from "hono";
import type Database from "better-sqlite3";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-ai-connection-test-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");

let app: Hono;
let getDb: () => Database.Database;
let closeDb: () => void;
const USER_ID = "ai-connection-user";

function setSetting(key: string, value: string): void {
  getDb().prepare(`
    INSERT INTO user_ai_settings (userId, key, value, updatedAt)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(userId, key) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt
  `).run(USER_ID, key, value);
}

test.before(async () => {
  const [routes, schema] = await Promise.all([
    import("../src/routes/ai"),
    import("../src/db/schema"),
  ]);
  app = new Hono();
  app.route("/ai", routes.default);
  getDb = schema.getDb;
  closeDb = schema.closeDb;

  getDb().prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
    .run(USER_ID, USER_ID, "hash");

  setSetting("ai_provider", "deepseek");
  setSetting("ai_api_url", "https://api.example.test/v1");
  setSetting("ai_api_key", "test-key");
  setSetting("ai_model", "reasoning-model");
});

test.after(async () => {
  closeDb();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      return;
    } catch (error: any) {
      if (error?.code !== "EBUSY" || attempt === 4) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
});

test("connection test succeeds when a reasoning-only response has no display text", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    choices: [{ message: { reasoning_content: "internal reasoning", content: "" } }],
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })) as typeof fetch;

  try {
    const response = await app.request("/ai/test", {
      method: "POST",
      headers: { "X-User-Id": USER_ID },
    });
    const body = await response.json() as { success: boolean; message?: string; preview?: string };

    assert.equal(response.status, 200);
    assert.equal(body.success, true);
    assert.equal(body.message, "连接成功（模型未在本次测试中返回可展示文本）");
    assert.equal(body.preview, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
