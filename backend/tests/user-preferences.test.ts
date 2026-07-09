import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { Hono } from "hono";
import type Database from "better-sqlite3";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-user-prefs-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");

let app: Hono;
let getDb: () => Database.Database;
let closeDb: () => void;

const USER_ID = "user-prefs";
const OTHER_ID = "other-prefs";

function db() {
  return getDb();
}

function seedUsers() {
  db().prepare("INSERT OR IGNORE INTO users (id, username, passwordHash) VALUES (?, ?, ?)").run(USER_ID, USER_ID, "hash");
  db().prepare("INSERT OR IGNORE INTO users (id, username, passwordHash) VALUES (?, ?, ?)").run(OTHER_ID, OTHER_ID, "hash");
}

async function requestJson(method: string, url: string, body?: unknown, userId = USER_ID) {
  const res = await app.request(url, {
    method,
    headers: {
      "X-User-Id": userId,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() as any };
}

test.before(async () => {
  const [prefsModule, schemaModule] = await Promise.all([
    import("../src/routes/user-preferences"),
    import("../src/db/schema"),
  ]);
  app = new Hono();
  app.route("/user-preferences", prefsModule.default);
  getDb = schemaModule.getDb;
  closeDb = schemaModule.closeDb;
  seedUsers();
});

test.beforeEach(() => {
  db().prepare("DELETE FROM user_preferences").run();
});

test.after(async () => {
  closeDb();
  for (let i = 0; i < 5; i++) {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      return;
    } catch (err: any) {
      if (err?.code !== "EBUSY") throw err;
      if (i === 4) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
});

test("stores user preferences per user", async () => {
  const put = await requestJson("PUT", "/user-preferences", {
    noteTitleAsAppTitle: true,
    showNotesInNotebookTree: true,
    markdownDefaultViewMode: "split",
  });
  assert.equal(put.status, 200);
  assert.equal(put.json.noteTitleAsAppTitle, true);
  assert.equal(put.json.showNotesInNotebookTree, true);
  assert.equal(put.json.markdownDefaultViewMode, "split");

  const get = await requestJson("GET", "/user-preferences");
  assert.equal(get.status, 200);
  assert.equal(get.json.noteTitleAsAppTitle, true);
  assert.equal(get.json.showNotesInNotebookTree, true);
  assert.equal(get.json.markdownDefaultViewMode, "split");
});

test("does not leak preferences across users", async () => {
  await requestJson("PUT", "/user-preferences", {
    noteTitleAsAppTitle: true,
    enableNoteTabs: true,
  }, USER_ID);

  const other = await requestJson("GET", "/user-preferences", undefined, OTHER_ID);
  assert.equal(other.status, 200);
  assert.equal(other.json.noteTitleAsAppTitle, false);
  assert.equal(other.json.enableNoteTabs, false);
});

