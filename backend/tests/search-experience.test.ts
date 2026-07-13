import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import type Database from "better-sqlite3";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-search-experience-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");

const OWNER_ID = "search-owner";
const OTHER_ID = "search-other";
const NOTEBOOK_ID = "search-notebook";
const ENGLISH_NOTE_ID = "search-english";
const CHINESE_NOTE_ID = "search-chinese";

let app: Hono;
let getDb: () => Database.Database;
let closeDb: () => void;

function db() {
  return getDb();
}

async function search(userId: string, query: string) {
  const response = await app.request(`/search?q=${encodeURIComponent(query)}`, {
    headers: { "X-User-Id": userId },
  });
  return { status: response.status, json: await response.json() as any[] };
}

test.before(async () => {
  const [routeModule, schemaModule] = await Promise.all([
    import("../src/routes/search"),
    import("../src/db/schema"),
  ]);

  app = new Hono();
  app.route("/search", routeModule.default);
  getDb = schemaModule.getDb;
  closeDb = schemaModule.closeDb;

  db().prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
    .run(OWNER_ID, OWNER_ID, "hash");
  db().prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
    .run(OTHER_ID, OTHER_ID, "hash");
  db().prepare("INSERT INTO notebooks (id, userId, name, icon) VALUES (?, ?, ?, ?)")
    .run(NOTEBOOK_ID, OWNER_ID, "Search notes", "🔎");

  db().prepare(`
    INSERT INTO notes (id, userId, notebookId, title, contentText, contentFormat)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    ENGLISH_NOTE_ID,
    OWNER_ID,
    NOTEBOOK_ID,
    "Alpha alpha guide",
    "An alpha example with another ALPHA occurrence.",
    "markdown",
  );

  db().prepare(`
    INSERT INTO notes (id, userId, notebookId, title, contentText, contentFormat)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    CHINESE_NOTE_ID,
    OWNER_ID,
    NOTEBOOK_ID,
    "中文全文检索",
    "搜索体验需要突出搜索关键词，并展示搜索结果。",
    "tiptap-json",
  );
});

test.after(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("search results include accurate match counts and notebook metadata", async () => {
  const response = await search(OWNER_ID, "alpha");
  assert.equal(response.status, 200);
  assert.equal(response.json.length, 1);

  const result = response.json[0];
  assert.equal(result.id, ENGLISH_NOTE_ID);
  assert.equal(result.matchCount, 4);
  assert.equal(result.matchedField, "title+content");
  assert.equal(result.notebookName, "Search notes");
  assert.equal(result.contentFormat, "markdown");
  assert.equal("contentText" in result, false, "full contentText must not leak into search payloads");
  assert.match(result.titleHtml, /<mark>/i);
  assert.match(result.snippetHtml, /<mark>/i);
});

test("Chinese fallback returns highlighted context and content-only metadata", async () => {
  const response = await search(OWNER_ID, "搜索");
  assert.equal(response.status, 200);
  const result = response.json.find((item) => item.id === CHINESE_NOTE_ID);
  assert.ok(result);
  assert.equal(result.matchCount, 3);
  assert.equal(result.matchedField, "content");
  assert.match(result.snippetHtml, /<mark>[^<]*搜索[^<]*<\/mark>/i);
});

test("personal-space search does not expose another user's notes", async () => {
  const response = await search(OTHER_ID, "alpha");
  assert.equal(response.status, 200);
  assert.deepEqual(response.json, []);
});
