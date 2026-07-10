import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { Hono } from "hono";
import type Database from "better-sqlite3";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-habits-regressions-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");

const OWNER_ID = "habit-regression-owner";
const OTHER_ID = "habit-regression-other";

let app: Hono;
let getDb: () => Database.Database;
let closeDb: () => void;

function db() {
  return getDb();
}

async function requestJson(userId: string, method: string, url: string, body?: unknown) {
  const res = await app.request(url, {
    method,
    headers: {
      "X-User-Id": userId,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

function todayKey(): string {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

test.before(async () => {
  const [habitsModule, schemaModule] = await Promise.all([
    import("../src/routes/habits"),
    import("../src/db/schema"),
  ]);

  app = new Hono();
  app.route("/habits", habitsModule.default);
  getDb = schemaModule.getDb;
  closeDb = schemaModule.closeDb;

  db().prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
    .run(OWNER_ID, OWNER_ID, "hash");
  db().prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
    .run(OTHER_ID, OTHER_ID, "hash");
});

test.beforeEach(() => {
  db().prepare("DELETE FROM habit_checkins").run();
  db().prepare("DELETE FROM habits").run();
  db().prepare("DELETE FROM workspace_members").run();
  db().prepare("DELETE FROM workspaces").run();
});

test.after(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("archived habit check-ins remain in default historical statistics", async () => {
  const created = await requestJson(OWNER_ID, "POST", "/habits", { title: "Read" });
  assert.equal(created.status, 201);

  const date = todayKey();
  const checked = await requestJson(OWNER_ID, "POST", `/habits/${created.json.id}/checkins`, {
    checkinDate: date,
    status: "success",
  });
  assert.equal(checked.status, 201);

  const archived = await requestJson(OWNER_ID, "PATCH", `/habits/${created.json.id}/archive`, {
    archived: true,
  });
  assert.equal(archived.status, 200);

  const active = await requestJson(OWNER_ID, "GET", `/habits?checkinDate=${date}`);
  assert.equal(active.status, 200);
  assert.equal(active.json.length, 0);

  const historicalStats = await requestJson(OWNER_ID, "GET", `/habits/stats?checkinDate=${date}`);
  assert.equal(historicalStats.status, 200);
  assert.equal(historicalStats.json.totalCheckins, 1);
  assert.equal(historicalStats.json.checkinDays, 1);
  assert.equal(historicalStats.json.currentStreak, 1);

  const activeOnlyStats = await requestJson(
    OWNER_ID,
    "GET",
    `/habits/stats?checkinDate=${date}&includeArchived=0`,
  );
  assert.equal(activeOnlyStats.status, 200);
  assert.equal(activeOnlyStats.json.totalCheckins, 0);
});

test("invalid or impossible check-in dates are rejected without writing data", async () => {
  const created = await requestJson(OWNER_ID, "POST", "/habits", { title: "Exercise" });
  assert.equal(created.status, 201);

  for (const checkinDate of ["not-a-date", "2026-02-31", "2026-13-01"]) {
    const response = await requestJson(OWNER_ID, "POST", `/habits/${created.json.id}/checkins`, {
      checkinDate,
      status: "success",
    });
    assert.equal(response.status, 400);
    assert.equal(response.json.code, "INVALID_DATE");
  }

  const count = db().prepare(
    "SELECT COUNT(*) AS count FROM habit_checkins WHERE habitId = ?",
  ).get(created.json.id) as { count: number };
  assert.equal(count.count, 0);

  const invalidList = await requestJson(OWNER_ID, "GET", "/habits?checkinDate=2026-02-31");
  assert.equal(invalidList.status, 400);
  assert.equal(invalidList.json.code, "INVALID_DATE");
});

test("workspace list exposes actor-specific manage permission", async () => {
  const workspaceId = "habit-regression-workspace";
  db().prepare(
    "INSERT INTO workspaces (id, name, ownerId, enabledFeatures) VALUES (?, ?, ?, ?)",
  ).run(workspaceId, "Habits", OWNER_ID, "{}");
  db().prepare(
    "INSERT INTO workspace_members (workspaceId, userId, role) VALUES (?, ?, ?)",
  ).run(workspaceId, OWNER_ID, "owner");
  db().prepare(
    "INSERT INTO workspace_members (workspaceId, userId, role) VALUES (?, ?, ?)",
  ).run(workspaceId, OTHER_ID, "editor");

  const created = await requestJson(
    OWNER_ID,
    "POST",
    `/habits?workspaceId=${workspaceId}`,
    { title: "Shared habit" },
  );
  assert.equal(created.status, 201);
  assert.equal(created.json.canManage, true);

  const ownerList = await requestJson(
    OWNER_ID,
    "GET",
    `/habits?workspaceId=${workspaceId}&checkinDate=${todayKey()}`,
  );
  assert.equal(ownerList.status, 200);
  assert.equal(ownerList.json[0].canManage, true);

  const editorList = await requestJson(
    OTHER_ID,
    "GET",
    `/habits?workspaceId=${workspaceId}&checkinDate=${todayKey()}`,
  );
  assert.equal(editorList.status, 200);
  assert.equal(editorList.json[0].canManage, false);
});

test("workspace admin check-in records the actual actor", async () => {
  const workspaceId = "habit-regression-admin-workspace";
  db().prepare(
    "INSERT INTO workspaces (id, name, ownerId, enabledFeatures) VALUES (?, ?, ?, ?)",
  ).run(workspaceId, "Habits Admin", OWNER_ID, "{}");
  db().prepare(
    "INSERT INTO workspace_members (workspaceId, userId, role) VALUES (?, ?, ?)",
  ).run(workspaceId, OWNER_ID, "owner");
  db().prepare(
    "INSERT INTO workspace_members (workspaceId, userId, role) VALUES (?, ?, ?)",
  ).run(workspaceId, OTHER_ID, "admin");

  const created = await requestJson(
    OWNER_ID,
    "POST",
    `/habits?workspaceId=${workspaceId}`,
    { title: "Admin-managed habit" },
  );

  const checked = await requestJson(
    OTHER_ID,
    "POST",
    `/habits/${created.json.id}/checkins`,
    { checkinDate: todayKey(), status: "partial" },
  );
  assert.equal(checked.status, 201);
  assert.equal(checked.json.userId, OTHER_ID);
});
