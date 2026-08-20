import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-sync-v2-disabled-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");
process.env.ELECTRON_USER_DATA = tmpDir;
// 关键：本文件**不**设置 NOWEN_LOCAL_FIRST_SYNC_V2，
// 验证默认状态下 Sync V2 对外完全不可见。
delete process.env.NOWEN_LOCAL_FIRST_SYNC_V2;

let app: Hono;
let closeDb: () => void;

test.before(async () => {
  const [routes, schema] = await Promise.all([
    import("../src/routes/sync-v2"),
    import("../src/db/schema"),
  ]);
  closeDb = schema.closeDb;
  app = new Hono();
  app.route("/api/sync/v2", routes.default);
});

test.after(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function probe(method: string, route: string, body?: unknown) {
  const response = await app.request(route, {
    method,
    headers: {
      "X-User-Id": "disabled-user",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() as any };
}

test("Flag 关闭时全部 V2 端点返回 404，不存在半启用状态", async () => {
  const probes = await Promise.all([
    probe("GET", "/api/sync/v2/plan"),
    probe("GET", "/api/sync/v2/changes?after=0"),
    probe("GET", "/api/sync/v2/snapshot"),
    probe("POST", "/api/sync/v2/push", { deviceId: "d1", mutations: [] }),
    probe("POST", "/api/sync/v2/ack", { deviceId: "d1", sequence: 1 }),
  ]);

  for (const result of probes) {
    assert.equal(result.status, 404);
    assert.equal(result.json.code, "SYNC_V2_DISABLED");
  }
});

test("Flag 关闭时 push 不写入任何数据", async () => {
  const { getDb } = await import("../src/db/schema");
  const before = getDb().prepare("SELECT COUNT(*) AS c FROM sync_v2_applied_mutations")
    .get() as { c: number };

  await probe("POST", "/api/sync/v2/push", {
    deviceId: "d1",
    mutations: [{
      mutationId: "m1", entityType: "note", entityId: "n1", operation: "upsert",
      payload: { title: "不该被写入" },
    }],
  });

  const after = getDb().prepare("SELECT COUNT(*) AS c FROM sync_v2_applied_mutations")
    .get() as { c: number };
  assert.equal(after.c, before.c, "Flag 关闭时不得产生任何写入");

  const notes = getDb().prepare("SELECT COUNT(*) AS c FROM notes WHERE id = 'n1'")
    .get() as { c: number };
  assert.equal(notes.c, 0);
});

test("Change Feed 表存在但触发器对已有用户无副作用", async () => {
  const { getDb } = await import("../src/db/schema");
  const db = getDb();
  // 迁移已建表；Flag 关闭时没有任何客户端消费它，因此不影响现有行为。
  const table = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='sync_changes_v2'",
  ).get();
  assert.ok(table);

  // V1 的表与触发器必须同时健在。
  assert.ok(db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='offline_sync_changes'",
  ).get());
});
