import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import type Database from "better-sqlite3";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-note-list-recent-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");
process.env.ELECTRON_USER_DATA = tmpDir;

let app: Hono;
let getDb: () => Database.Database;
let closeDb: () => void;

const OWNER = "recent-owner", OTHER = "recent-other";

test.before(async () => {
  const [notesModule, schemaModule] = await Promise.all([import("../src/routes/notes"), import("../src/db/schema")]);
  app = new Hono();
  app.route("/notes", notesModule.default);
  getDb = schemaModule.getDb;
  closeDb = schemaModule.closeDb;
  const db = getDb();
  for (const id of [OWNER, OTHER]) db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)").run(id, id, "hash");
  db.prepare("INSERT INTO notebooks (id, userId, name) VALUES (?, ?, ?)").run("nb-owner", OWNER, "Owner");
  db.prepare("INSERT INTO notebooks (id, userId, name) VALUES (?, ?, ?)").run("nb-other", OTHER, "Other");
  db.prepare("INSERT INTO workspaces (id, name, ownerId) VALUES (?, ?, ?)").run("ws-private", "Private", OTHER);
  db.prepare("INSERT INTO workspace_members (workspaceId, userId, role) VALUES (?, ?, ?)").run("ws-private", OTHER, "owner");
  const insert = db.prepare(`INSERT INTO notes (id, userId, notebookId, workspaceId, title, content, contentText, isPinned, isTrashed, updatedAt)
    VALUES (?, ?, ?, ?, ?, '{}', ?, ?, ?, ?)`);
  insert.run("old-pinned", OWNER, "nb-owner", null, "Old pinned", "x", 1, 0, "2026-01-01 08:00:00");
  insert.run("newest", OWNER, "nb-owner", null, "Newest", "x", 0, 0, "2026-11-09 08:00:00");
  insert.run("middle", OWNER, "nb-owner", null, "Middle", "x", 0, 0, "2026-06-01 08:00:00");
  insert.run("trashed-newer", OWNER, "nb-owner", null, "Trashed", "x", 0, 1, "2026-11-10 08:00:00");
  insert.run("other-user", OTHER, "nb-other", null, "Other personal", "x", 0, 0, "2026-11-10 09:00:00");
  insert.run("other-workspace", OTHER, "nb-other", "ws-private", "Other workspace", "x", 0, 0, "2026-11-10 10:00:00");
});

test.after(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function list(query: string, user = OWNER): Promise<{ status: number; ids: string[] }> {
  const response = await app.request(`/notes?${query}`, { headers: { "X-User-Id": user } });
  const body = await response.json() as Array<{ id: string }> | { error: string };
  return { status: response.status, ids: Array.isArray(body) ? body.map((note) => note.id) : [] };
}

test("recent ordering ignores pin priority and limit trims the result", async () => {
  assert.deepEqual((await list("workspaceId=personal&sortBy=recent")).ids, ["newest", "middle", "old-pinned"]);
  assert.deepEqual((await list("workspaceId=personal&sortBy=recent&limit=2")).ids, ["newest", "middle"]);
  // Existing sort modes keep pinned notes first.
  assert.deepEqual((await list("workspaceId=personal&sortBy=updatedAt&limit=2")).ids, ["old-pinned", "newest"]);
});

test("invalid limits fall back to the historical full list", async () => {
  for (const limit of ["0", "-3", "abc", ""]) {
    assert.equal((await list(`workspaceId=personal&sortBy=recent&limit=${limit}`)).ids.length, 3, `limit=${limit}`);
  }
  assert.equal((await list("workspaceId=personal&sortBy=recent&limit=100000")).ids.length, 3);
});

test("limits never widen the scope: trash, other users and foreign workspaces stay excluded", async () => {
  const { ids } = await list("workspaceId=personal&sortBy=recent&limit=50");
  assert.equal(ids.includes("trashed-newer") || ids.includes("other-user") || ids.includes("other-workspace"), false);
  assert.equal((await list("workspaceId=ws-private&sortBy=recent&limit=5")).status, 403);
  assert.deepEqual((await list("workspaceId=ws-private&sortBy=recent&limit=5", OTHER)).ids, ["other-workspace"]);
});
