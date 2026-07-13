import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import type Database from "better-sqlite3";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-user-prefs-sync-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");

const USER_ID = "prefs-sync-user";
const OTHER_ID = "prefs-sync-other";

let app: Hono;
let getDb: () => Database.Database;
let closeDb: () => void;

function db() {
  return getDb();
}

async function requestJson(method: string, body?: unknown, userId = USER_ID) {
  const response = await app.request("/user-preferences", {
    method,
    headers: {
      "X-User-Id": userId,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() as any };
}

test.before(async () => {
  const [routeModule, schemaModule] = await Promise.all([
    import("../src/routes/user-preferences"),
    import("../src/db/schema"),
  ]);
  app = new Hono();
  app.route("/user-preferences", routeModule.default);
  getDb = schemaModule.getDb;
  closeDb = schemaModule.closeDb;

  db().prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
    .run(USER_ID, USER_ID, "hash");
  db().prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
    .run(OTHER_ID, OTHER_ID, "hash");
});

test.beforeEach(() => {
  db().prepare("DELETE FROM user_preferences").run();
});

test.after(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("reads legacy flat preference rows and upgrades them on the next partial write", async () => {
  db().prepare(`
    INSERT INTO user_preferences (userId, preferencesJson, updatedAt)
    VALUES (?, ?, ?)
  `).run(USER_ID, JSON.stringify({
    noteTitleAsAppTitle: true,
    readingDensity: "compact",
  }), "2026-07-01T00:00:00.000Z");

  const before = await requestJson("GET");
  assert.equal(before.status, 200);
  assert.equal(before.json.noteTitleAsAppTitle, true);
  assert.equal(before.json.readingDensity, "compact");
  assert.equal(before.json.revision, 1);
  assert.equal(before.json.userId, USER_ID);

  const updated = await requestJson("PUT", {
    showNotesInNotebookTree: true,
    _baseRevision: 1,
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.json.noteTitleAsAppTitle, true);
  assert.equal(updated.json.showNotesInNotebookTree, true);
  assert.equal(updated.json.revision, 2);
  assert.equal(updated.json.conflict, false);

  const stored = db().prepare("SELECT preferencesJson FROM user_preferences WHERE userId = ?")
    .get(USER_ID) as { preferencesJson: string };
  const parsed = JSON.parse(stored.preferencesJson);
  assert.equal(parsed.noteTitleAsAppTitle, true);
  assert.equal(parsed.showNotesInNotebookTree, true);
  assert.equal(parsed.__meta.version, 2);
  assert.equal(parsed.__meta.revision, 2);
});

test("merges stale field-level updates instead of replacing the whole document", async () => {
  const first = await requestJson("PUT", {
    noteTitleAsAppTitle: true,
    _baseRevision: 0,
  });
  assert.equal(first.json.revision, 1);

  const second = await requestJson("PUT", {
    readingDensity: "compact",
    _baseRevision: 0,
  });
  assert.equal(second.status, 200);
  assert.equal(second.json.conflict, true);
  assert.equal(second.json.revision, 2);
  assert.equal(second.json.noteTitleAsAppTitle, true);
  assert.equal(second.json.readingDensity, "compact");
  assert.ok(second.json.fieldUpdatedAt.noteTitleAsAppTitle);
  assert.ok(second.json.fieldUpdatedAt.readingDensity);
});

test("prevents a second first-run migration from overwriting established remote preferences", async () => {
  const first = await requestJson("PUT", {
    noteTitleAsAppTitle: true,
    markdownDefaultViewMode: "preview",
    _baseRevision: 0,
    _migration: true,
  });
  assert.equal(first.json.revision, 1);

  const second = await requestJson("PUT", {
    noteTitleAsAppTitle: false,
    markdownDefaultViewMode: "split",
    _baseRevision: 0,
    _migration: true,
  });
  assert.equal(second.status, 200);
  assert.equal(second.json.conflict, true);
  assert.equal(second.json.noteTitleAsAppTitle, true);
  assert.equal(second.json.markdownDefaultViewMode, "preview");
  assert.equal(second.json.revision, 1);
});

test("keeps caches isolated per user and never persists sensitive unknown fields", async () => {
  const saved = await requestJson("PUT", {
    enableNoteTabs: true,
    apiKey: "should-never-be-stored",
    token: "also-secret",
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.enableNoteTabs, true);
  assert.equal("apiKey" in saved.json, false);
  assert.equal("token" in saved.json, false);

  const raw = db().prepare("SELECT preferencesJson FROM user_preferences WHERE userId = ?")
    .get(USER_ID) as { preferencesJson: string };
  assert.doesNotMatch(raw.preferencesJson, /should-never-be-stored|also-secret|apiKey|token/);

  const other = await requestJson("GET", undefined, OTHER_ID);
  assert.equal(other.status, 200);
  assert.equal(other.json.enableNoteTabs, false);
  assert.equal(other.json.hasPreferences, false);
  assert.equal(other.json.userId, OTHER_ID);
});

test("rejects invalid values for known preference fields", async () => {
  const result = await requestJson("PUT", { readingDensity: "ultra-compact" });
  assert.equal(result.status, 400);
  assert.equal(result.json.code, "INVALID_USER_PREFERENCE");
});
