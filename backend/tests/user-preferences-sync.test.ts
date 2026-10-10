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

function db() { return getDb(); }

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
  db().prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)").run(USER_ID, USER_ID, "hash");
  db().prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)").run(OTHER_ID, OTHER_ID, "hash");
});

test.beforeEach(() => { db().prepare("DELETE FROM user_preferences").run(); });

test.after(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("reads legacy flat preference rows and upgrades them on the next partial write", async () => {
  db().prepare(`
    INSERT INTO user_preferences (userId, preferencesJson, updatedAt)
    VALUES (?, ?, ?)
  `).run(USER_ID, JSON.stringify({ noteTitleAsAppTitle: true, readingDensity: "compact" }), "2026-07-01T00:00:00.000Z");

  const before = await requestJson("GET");
  assert.equal(before.status, 200);
  assert.equal(before.json.noteTitleAsAppTitle, true);
  assert.equal(before.json.readingDensity, "compact");
  assert.equal(before.json.revision, 1);
  assert.equal(before.json.userId, USER_ID);

  const updated = await requestJson("PUT", { showNotesInNotebookTree: true, _baseRevision: 1 });
  assert.equal(updated.status, 200);
  assert.equal(updated.json.noteTitleAsAppTitle, true);
  assert.equal(updated.json.showNotesInNotebookTree, true);
  assert.equal(updated.json.revision, 2);
  assert.equal(updated.json.conflict, false);

  const stored = db().prepare("SELECT preferencesJson FROM user_preferences WHERE userId = ?").get(USER_ID) as { preferencesJson: string };
  const parsed = JSON.parse(stored.preferencesJson);
  assert.equal(parsed.noteTitleAsAppTitle, true);
  assert.equal(parsed.showNotesInNotebookTree, true);
  assert.equal(parsed.__meta.version, 2);
  assert.equal(parsed.__meta.revision, 2);
});

test("merges stale field-level updates instead of replacing the whole document", async () => {
  const first = await requestJson("PUT", { noteTitleAsAppTitle: true, _baseRevision: 0 });
  assert.equal(first.json.revision, 1);

  const second = await requestJson("PUT", {
    readingDensity: "compact",
    editorFontSize: 22,
    noteTheme: "paper",
    _baseRevision: 0,
  });
  assert.equal(second.status, 200);
  assert.equal(second.json.conflict, true);
  assert.equal(second.json.revision, 2);
  assert.equal(second.json.noteTitleAsAppTitle, true);
  assert.equal(second.json.readingDensity, "compact");
  assert.equal(second.json.editorFontSize, 22);
  assert.equal(second.json.noteTheme, "paper");
  assert.ok(second.json.fieldUpdatedAt.noteTitleAsAppTitle);
  assert.ok(second.json.fieldUpdatedAt.readingDensity);
  assert.ok(second.json.fieldUpdatedAt.editorFontSize);
  assert.ok(second.json.fieldUpdatedAt.noteTheme);
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

  const raw = db().prepare("SELECT preferencesJson FROM user_preferences WHERE userId = ?").get(USER_ID) as { preferencesJson: string };
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

  const invalidFontSize = await requestJson("PUT", { editorFontSize: 48 });
  assert.equal(invalidFontSize.status, 400);
  assert.equal(invalidFontSize.json.code, "INVALID_USER_PREFERENCE");

  const invalidNoteTheme = await requestJson("PUT", { noteTheme: "developer" });
  assert.equal(invalidNoteTheme.status, 400);
  assert.equal(invalidNoteTheme.json.code, "INVALID_USER_PREFERENCE");

  const invalidImagePasteMode = await requestJson("PUT", { remoteImagePasteMode: "unsafe" });
  assert.equal(invalidImagePasteMode.status, 400);
  assert.equal(invalidImagePasteMode.json.code, "INVALID_USER_PREFERENCE");
});

test("persists remote image paste policy per account with a safe default", async () => {
  const before = await requestJson("GET");
  assert.equal(before.json.remoteImagePasteMode, "localize");
  const saved = await requestJson("PUT", { remoteImagePasteMode: "ask" });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.remoteImagePasteMode, "ask");
  assert.equal((await requestJson("GET")).json.remoteImagePasteMode, "ask");
  assert.equal((await requestJson("GET", undefined, OTHER_ID)).json.remoteImagePasteMode, "localize");
});


test("syncs code block collapse policy per account and rejects invalid values", async () => {
  const before = await requestJson("GET");
  assert.equal(before.json.codeBlockCollapseMode, "long");
  const saved = await requestJson("PUT", { codeBlockCollapseMode: "collapsed" });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.codeBlockCollapseMode, "collapsed");
  assert.equal((await requestJson("GET")).json.codeBlockCollapseMode, "collapsed");
  assert.equal((await requestJson("GET", undefined, OTHER_ID)).json.codeBlockCollapseMode, "long");
  const invalid = await requestJson("PUT", { codeBlockCollapseMode: "sometimes" });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.json.code, "INVALID_USER_PREFERENCE");
});


test("syncs navigation visibility preferences and rejects unknown module ids", async () => {
  const before = await requestJson("GET");
  assert.deepEqual(before.json.hiddenNavigationModules, []);
  assert.deepEqual(before.json.hiddenTaskCenterModules, []);

  const saved = await requestJson("PUT", {
    hiddenNavigationModules: ["tasks", "diary", "tasks"],
    hiddenTaskCenterModules: ["habits", "stats"],
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.json.hiddenNavigationModules, ["tasks", "diary"]);
  assert.deepEqual(saved.json.hiddenTaskCenterModules, ["habits", "stats"]);

  const invalidNav = await requestJson("PUT", { hiddenNavigationModules: ["tasks", "unknown-module"] });
  assert.equal(invalidNav.status, 400);
  assert.equal(invalidNav.json.code, "INVALID_USER_PREFERENCE");

  const invalidTask = await requestJson("PUT", { hiddenTaskCenterModules: ["habits", "tasks"] });
  assert.equal(invalidTask.status, 400);
  assert.equal(invalidTask.json.code, "INVALID_USER_PREFERENCE");
});


test("syncs navigation module order, appends future/default modules, and rejects unknown ids", async () => {
  const before = await requestJson("GET");
  assert.deepEqual(before.json.navigationModuleOrder, [
    "notifications", "favorites", "files", "diary", "tasks", "mindmaps", "ai-chat", "shares",
  ]);

  const saved = await requestJson("PUT", { navigationModuleOrder: ["tasks", "favorites", "notifications"] });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.json.navigationModuleOrder, [
    "tasks", "favorites", "notifications", "files", "diary", "mindmaps", "ai-chat", "shares",
  ]);
  assert.deepEqual((await requestJson("GET", undefined, OTHER_ID)).json.navigationModuleOrder, [
    "notifications", "favorites", "files", "diary", "tasks", "mindmaps", "ai-chat", "shares",
  ]);

  const invalid = await requestJson("PUT", { navigationModuleOrder: ["tasks", "unknown-module"] });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.json.code, "INVALID_USER_PREFERENCE");
});


test("persists notification entry visibility per account and supports restoring it", async () => {
  assert.deepEqual((await requestJson("GET")).json.hiddenNavigationModules, []);

  const hidden = await requestJson("PUT", { hiddenNavigationModules: ["tasks", "notifications"] });
  assert.equal(hidden.status, 200);
  assert.deepEqual((await requestJson("GET")).json.hiddenNavigationModules, ["tasks", "notifications"]);
  assert.deepEqual((await requestJson("GET", undefined, OTHER_ID)).json.hiddenNavigationModules, []);

  const shown = await requestJson("PUT", { hiddenNavigationModules: ["tasks"] });
  assert.equal(shown.status, 200);
  assert.deepEqual((await requestJson("GET")).json.hiddenNavigationModules, ["tasks"]);
});

test("syncs journal lock-on-entry preference per account", async () => {
  const before = await requestJson("GET");
  assert.equal(before.json.journalLockOnEntry, false);

  const saved = await requestJson("PUT", { journalLockOnEntry: true });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.journalLockOnEntry, true);
  assert.equal((await requestJson("GET")).json.journalLockOnEntry, true);
  assert.equal((await requestJson("GET", undefined, OTHER_ID)).json.journalLockOnEntry, false);

  const invalid = await requestJson("PUT", { journalLockOnEntry: "yes" });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.json.code, "INVALID_USER_PREFERENCE");
});


test("syncs note-list divider preference per account", async () => {
  const before = await requestJson("GET");
  assert.equal(before.json.showNoteListDividers, false);

  const saved = await requestJson("PUT", { showNoteListDividers: true });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.showNoteListDividers, true);
  assert.equal((await requestJson("GET")).json.showNoteListDividers, true);
  assert.equal((await requestJson("GET", undefined, OTHER_ID)).json.showNoteListDividers, false);

  const invalid = await requestJson("PUT", { showNoteListDividers: "yes" });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.json.code, "INVALID_USER_PREFERENCE");
});
