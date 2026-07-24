import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import type Database from "better-sqlite3";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-note-content-view-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");
process.env.ELECTRON_USER_DATA = tmpDir;

const owner = "content-view-owner";
const notebookId = "content-view-notebook";
const generatedMarker = /\^blk_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
let db: Database.Database;
let closeDb: () => void;
let app: Hono;


test.before(async () => {
  const schema = await import("../src/db/schema");
  const notesRoute = await import("../src/routes/notes");
  db = schema.getDb();
  closeDb = schema.closeDb;
  app = new Hono();
  app.route("/api/notes", notesRoute.default);
  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
    .run(owner, owner, "hash");
  db.prepare("INSERT INTO notebooks (id, userId, name) VALUES (?, ?, ?)")
    .run(notebookId, owner, "Content View");
});


test.after(() => {
  closeDb?.();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});


test("ordinary Note REST responses are clean while the trusted media type retains internal IDs", async () => {
  const source = [
    "# API 标题",
    "",
    "```text",
    "^blk_user_example",
    "```",
  ].join("\n");
  const create = await app.request("/api/notes", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-User-Id": owner },
    body: JSON.stringify({ notebookId, title: "Content View", content: source, contentFormat: "markdown" }),
  });
  assert.equal(create.status, 201);
  const publicCreated = await create.json() as any;
  assert.doesNotMatch(publicCreated.content, generatedMarker);
  assert.match(publicCreated.content, /\^blk_user_example/);

  const stored = db.prepare("SELECT content FROM notes WHERE id = ?").get(publicCreated.id) as { content: string };
  assert.match(stored.content, generatedMarker);

  const publicGet = await app.request(`/api/notes/${publicCreated.id}`, {
    headers: { "X-User-Id": owner },
  });
  assert.equal(publicGet.status, 200);
  const publicPayload = await publicGet.json() as any;
  assert.doesNotMatch(publicPayload.content, generatedMarker);
  assert.match(publicPayload.content, /\^blk_user_example/);

  const internalGet = await app.request(`/api/notes/${publicCreated.id}`, {
    headers: {
      "X-User-Id": owner,
      "Accept": "application/vnd.nowen.internal-note+json",
    },
  });
  assert.equal(internalGet.status, 200);
  const internalPayload = await internalGet.json() as any;
  assert.match(internalPayload.content, generatedMarker);
  assert.match(internalPayload.content, /\^blk_user_example/);
});
