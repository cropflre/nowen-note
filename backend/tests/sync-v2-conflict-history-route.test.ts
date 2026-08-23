import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Hono } from "hono";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-sync-v2-conflict-history-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");
process.env.ELECTRON_USER_DATA = tmpDir;
process.env.NOWEN_LOCAL_FIRST_SYNC_V2 = "1";

let app: Hono;
let closeDb: () => void;
let getDb: typeof import("../src/db/schema").getDb;
let createProfile: typeof import("../src/sync/profile").createProfile;
let switchActiveProfile: typeof import("../src/sync/profile").switchActiveProfile;
let recordConflict: typeof import("../src/sync/conflict").recordConflict;
let resolveConflict: typeof import("../src/sync/conflict").resolveConflict;

test.before(async () => {
  const [routes, schema, profiles, conflicts] = await Promise.all([
    import("../src/routes/sync-local"),
    import("../src/db/schema"),
    import("../src/sync/profile"),
    import("../src/sync/conflict"),
  ]);
  closeDb = schema.closeDb;
  getDb = schema.getDb;
  createProfile = profiles.createProfile;
  switchActiveProfile = profiles.switchActiveProfile;
  recordConflict = conflicts.recordConflict;
  resolveConflict = conflicts.resolveConflict;
  app = new Hono();
  app.route("/api/sync/local", routes.default);
});

test.after(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("已解决冲突可查询并安全重新放回待处理列表", async () => {
  const db = getDb();
  const profile = createProfile(db, {
    name: "测试服务器",
    serverUrl: "http://127.0.0.1:3001",
  });
  switchActiveProfile(db, profile.id);

  recordConflict(db, {
    profileId: profile.id,
    entityType: "note",
    entityId: "note-open",
    localPayload: { title: "仍待处理" },
    remotePayload: { title: "服务器待处理" },
  });
  const resolvedId = recordConflict(db, {
    profileId: profile.id,
    entityType: "note",
    entityId: "note-resolved",
    localPayload: { title: "本机历史" },
    remotePayload: { title: "服务器历史" },
  });
  resolveConflict(db, resolvedId);
  const resolvedTaskId = recordConflict(db, {
    profileId: profile.id,
    entityType: "task",
    entityId: "task-resolved",
    localPayload: { title: "本机任务历史" },
    remotePayload: { title: "服务器任务历史" },
  });
  resolveConflict(db, resolvedTaskId);
  db.prepare("UPDATE sync_conflicts SET resolvedAt = ? WHERE id = ?").run(
    "2026-08-23 05:00:00",
    resolvedId,
  );
  db.prepare("UPDATE sync_conflicts SET resolvedAt = ? WHERE id = ?").run(
    "2026-08-23 04:00:00",
    resolvedTaskId,
  );

  const headers = { "X-User-Id": "local-user" };
  const historyResponse = await app.request(
    "/api/sync/local/conflicts/history?limit=1&offset=0",
    { headers },
  );
  assert.equal(historyResponse.status, 200);
  const history = await historyResponse.json() as any;
  assert.equal(history.total, 2);
  assert.equal(history.limit, 1);
  assert.equal(history.offset, 0);
  assert.equal(history.hasMore, true);
  assert.equal(history.items.length, 1);
  assert.equal(history.items[0].id, resolvedId);
  assert.equal(history.items[0].localTitle, "本机历史");
  assert.ok(history.items[0].resolvedAt);

  const secondPageResponse = await app.request(
    "/api/sync/local/conflicts/history?limit=1&offset=1",
    { headers },
  );
  const secondPage = await secondPageResponse.json() as any;
  assert.equal(secondPage.total, 2);
  assert.equal(secondPage.hasMore, false);
  assert.equal(secondPage.items[0].id, resolvedTaskId);

  const taskHistoryResponse = await app.request(
    "/api/sync/local/conflicts/history?entityType=task",
    { headers },
  );
  const taskHistory = await taskHistoryResponse.json() as any;
  assert.equal(taskHistory.total, 1);
  assert.equal(taskHistory.items[0].id, resolvedTaskId);

  const invalidFilterResponse = await app.request(
    "/api/sync/local/conflicts/history?entityType=unknown",
    { headers },
  );
  assert.equal(invalidFilterResponse.status, 400);

  const reopenResponse = await app.request(
    `/api/sync/local/conflicts/${resolvedId}/reopen`,
    { method: "POST", headers },
  );
  assert.equal(reopenResponse.status, 200);
  const reopened = await reopenResponse.json() as any;
  assert.equal(reopened.reopened, true);
  assert.equal(reopened.remainingConflicts, 2);

  const conflictsResponse = await app.request("/api/sync/local/conflicts", { headers });
  const current = await conflictsResponse.json() as any;
  assert.equal(current.total, 2);
  assert.ok(current.items.some((item: any) => item.id === resolvedId));

  const remainingHistory = await app.request("/api/sync/local/conflicts/history", { headers });
  const remaining = await remainingHistory.json() as any;
  assert.equal(remaining.total, 1);
  assert.equal(remaining.items[0].id, resolvedTaskId);
});
