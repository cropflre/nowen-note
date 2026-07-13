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
const FULLWIDTH_NOTE_ID = "search-fullwidth";
const CPP_NOTE_ID = "search-cpp";
const C_NOTE_ID = "search-c";
const META_NOTE_ID = "search-meta";
const MUTABLE_NOTE_ID = "search-mutable";

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
  return { status: response.status, headers: response.headers, json: await response.json() as any[] };
}

function insertNote(id: string, title: string, contentText: string, contentFormat = "markdown") {
  db().prepare(`
    INSERT INTO notes (id, userId, notebookId, title, contentText, contentFormat)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, OWNER_ID, NOTEBOOK_ID, title, contentText, contentFormat);
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
  db().prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(OWNER_ID);
  db().prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
    .run(OTHER_ID, OTHER_ID, "hash");
  db().prepare("INSERT INTO notebooks (id, userId, name, icon) VALUES (?, ?, ?, ?)")
    .run(NOTEBOOK_ID, OWNER_ID, "Search notes", "🔎");

  insertNote(
    ENGLISH_NOTE_ID,
    "Alpha alpha guide",
    "An alpha example with another ALPHA occurrence.",
  );
  insertNote(
    CHINESE_NOTE_ID,
    "中文全文检索",
    "搜索体验需要突出搜索关键词，并展示搜索结果。",
    "tiptap-json",
  );
  insertNote(FULLWIDTH_NOTE_ID, "兼容字符", "发布编号是ＡＢＣ１２３。", "tiptap-json");
  insertNote(CPP_NOTE_ID, "Modern C++ handbook", "RAII and templates");
  insertNote(C_NOTE_ID, "C language handbook", "Pointers and memory");
  insertNote(META_NOTE_ID, "Release planning", "This note deliberately has no metadata keywords.");
  insertNote(MUTABLE_NOTE_ID, "Mutable note", "before unique-old-keyword");

  db().prepare("INSERT INTO tags (id, userId, name, color) VALUES (?, ?, ?, ?)")
    .run("search-tag", OWNER_ID, "项目代号X9", "#58a6ff");
  db().prepare("INSERT INTO note_tags (noteId, tagId) VALUES (?, ?)")
    .run(META_NOTE_ID, "search-tag");

  db().prepare(`
    INSERT INTO attachments (id, noteId, userId, filename, mimeType, size, path)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    "search-attachment",
    META_NOTE_ID,
    OWNER_ID,
    "roadmap-2026.pdf",
    "application/pdf",
    128,
    "search/roadmap-2026.pdf",
  );
  db().prepare(`
    INSERT INTO attachment_chunks (attachmentId, chunkIndex, chunkText)
    VALUES (?, ?, ?)
  `).run("search-attachment", 1, "附件正文包含唯一召回词火星计划。 ");
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
  assert.deepEqual(result.matchedFields, ["title", "content"]);
  assert.equal(result.notebookName, "Search notes");
  assert.equal(result.contentFormat, "markdown");
  assert.equal("contentText" in result, false, "full contentText must not leak into search payloads");
  assert.match(result.titleHtml, /<mark>/i);
  assert.match(result.snippetHtml, /<mark>/i);
});

test("Chinese search returns highlighted context and content-only metadata", async () => {
  const response = await search(OWNER_ID, "搜索");
  assert.equal(response.status, 200);
  const result = response.json.find((item) => item.id === CHINESE_NOTE_ID);
  assert.ok(result);
  assert.equal(result.matchCount, 3);
  assert.equal(result.matchedField, "content");
  assert.equal(result.matchReason, "content");
  assert.match(result.snippetHtml, /<mark>搜索<\/mark>/i);
});

test("full-width text is searchable with half-width input", async () => {
  const response = await search(OWNER_ID, "abc123");
  assert.equal(response.status, 200);
  assert.deepEqual(response.json.map((item) => item.id), [FULLWIDTH_NOTE_ID]);
  assert.match(response.json[0].snippetHtml, /<mark>ＡＢＣ１２３<\/mark>/i);
});

test("punctuation stays literal and does not admit tokenizer-only false positives", async () => {
  const response = await search(OWNER_ID, "C++");
  assert.equal(response.status, 200);
  assert.deepEqual(response.json.map((item) => item.id), [CPP_NOTE_ID]);
  assert.equal(response.json.some((item) => item.id === C_NOTE_ID), false);
});

test("tag, attachment filename and extracted attachment text expose their hit reason", async () => {
  const tagResult = (await search(OWNER_ID, "项目代号X9")).json[0];
  assert.equal(tagResult.id, META_NOTE_ID);
  assert.deepEqual(tagResult.matchedFields, ["tag"]);
  assert.equal(tagResult.matchReason, "tag");
  assert.match(tagResult.snippetHtml, /标签：/);
  assert.match(tagResult.snippetHtml, /<mark>项目代号X9<\/mark>/);

  const filenameResult = (await search(OWNER_ID, "roadmap-2026.pdf")).json[0];
  assert.equal(filenameResult.id, META_NOTE_ID);
  assert.deepEqual(filenameResult.matchedFields, ["attachment"]);
  assert.equal(filenameResult.matchReason, "attachment");
  assert.match(filenameResult.snippetHtml, /附件：/);

  const contentResult = (await search(OWNER_ID, "火星计划")).json[0];
  assert.equal(contentResult.id, META_NOTE_ID);
  assert.equal(contentResult.matchReason, "attachment");
  assert.match(contentResult.snippetHtml, /<mark>火星计划<\/mark>/);
});

test("editing, trashing, restoring and deleting a note never leaves ghost results", async () => {
  assert.equal((await search(OWNER_ID, "unique-old-keyword")).json[0]?.id, MUTABLE_NOTE_ID);

  db().prepare("UPDATE notes SET contentText = ?, updatedAt = datetime('now') WHERE id = ?")
    .run("after unique-new-keyword", MUTABLE_NOTE_ID);
  assert.deepEqual((await search(OWNER_ID, "unique-old-keyword")).json, []);
  assert.equal((await search(OWNER_ID, "unique-new-keyword")).json[0]?.id, MUTABLE_NOTE_ID);

  db().prepare("UPDATE notes SET isTrashed = 1 WHERE id = ?").run(MUTABLE_NOTE_ID);
  assert.deepEqual((await search(OWNER_ID, "unique-new-keyword")).json, []);

  db().prepare("UPDATE notes SET isTrashed = 0 WHERE id = ?").run(MUTABLE_NOTE_ID);
  assert.equal((await search(OWNER_ID, "unique-new-keyword")).json[0]?.id, MUTABLE_NOTE_ID);

  db().prepare("DELETE FROM notes WHERE id = ?").run(MUTABLE_NOTE_ID);
  assert.deepEqual((await search(OWNER_ID, "unique-new-keyword")).json, []);
});

test("search index health is observable and admins can rebuild it safely", async () => {
  const healthResponse = await app.request("/search/health", {
    headers: { "X-User-Id": OWNER_ID },
  });
  const health = await healthResponse.json() as any;
  assert.equal(healthResponse.status, 200);
  assert.equal(health.healthy, true);
  assert.equal(health.canRebuild, true);

  const rebuildResponse = await app.request("/search/rebuild", {
    method: "POST",
    headers: { "X-User-Id": OWNER_ID },
  });
  const rebuilt = await rebuildResponse.json() as any;
  assert.equal(rebuildResponse.status, 200);
  assert.equal(rebuilt.success, true);
  assert.equal(rebuilt.healthy, true);
  assert.equal((await search(OWNER_ID, "alpha")).json[0]?.id, ENGLISH_NOTE_ID);

  const forbiddenResponse = await app.request("/search/rebuild", {
    method: "POST",
    headers: { "X-User-Id": OTHER_ID },
  });
  assert.equal(forbiddenResponse.status, 403);
});

test("personal-space search does not expose another user's notes", async () => {
  const response = await search(OTHER_ID, "alpha");
  assert.equal(response.status, 200);
  assert.deepEqual(response.json, []);
});
