import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import type Database from "better-sqlite3";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-version-route-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");
process.env.DB_DRIVER = "sqlite";
process.env.NOWEN_APP_VERSION_OVERRIDE = "9.9.9-test";

let app: Hono;
let getDb: () => Database.Database;
let closeDb: () => void;

test.before(async () => {
  const [routeModule, schemaModule] = await Promise.all([
    import("../src/routes/version"),
    import("../src/db/schema"),
  ]);
  app = new Hono();
  app.route("/version", routeModule.default);
  getDb = schemaModule.getDb;
  closeDb = schemaModule.closeDb;
});

test.after(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("version route creates one stable server instance id through the async repository", async () => {
  const responses = await Promise.all(
    Array.from({ length: 10 }, () => app.request("/version")),
  );
  assert.ok(responses.every((response) => response.status === 200));

  const payloads = await Promise.all(responses.map((response) => response.json() as Promise<any>));
  const ids = new Set(payloads.map((payload) => payload.serverInstanceId));
  assert.equal(ids.size, 1);

  const [serverInstanceId] = ids;
  assert.equal(typeof serverInstanceId, "string");
  assert.match(String(serverInstanceId), /^[0-9a-f-]{36}$/i);
  assert.ok(payloads.every((payload) => payload.appVersion === "9.9.9-test"));

  const row = getDb()
    .prepare("SELECT value FROM system_settings WHERE key = ?")
    .get("server_instance_id") as { value: string };
  assert.equal(row.value, serverInstanceId);
});
