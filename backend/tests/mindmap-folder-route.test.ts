import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-mindmap-folder-route-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");

let closeDatabase: (() => void) | null = null;

async function setup() {
  const [{ getDb, closeDb }, { default: app }] = await Promise.all([
    import("../src/db/schema.js"),
    import("../src/routes/mindmap-folders.js"),
  ]);
  closeDatabase = closeDb;
  const db = getDb();
  db.prepare("INSERT OR IGNORE INTO users (id, username, passwordHash) VALUES (?, ?, 'hash')").run("owner", "owner");
  db.prepare("INSERT OR IGNORE INTO users (id, username, passwordHash) VALUES (?, ?, 'hash')").run("other", "other");
  db.prepare("INSERT OR IGNORE INTO workspaces (id, name, ownerId) VALUES (?, ?, ?)").run("ws-a", "A", "owner");
  db.prepare("INSERT OR IGNORE INTO workspaces (id, name, ownerId) VALUES (?, ?, ?)").run("ws-b", "B", "other");
  db.prepare("INSERT OR IGNORE INTO workspace_members (workspaceId, userId, role) VALUES (?, ?, ?)").run("ws-a", "owner", "owner");
  db.prepare("INSERT OR IGNORE INTO workspace_members (workspaceId, userId, role) VALUES (?, ?, ?)").run("ws-b", "other", "owner");
  return { db, app };
}

async function post(app: any, body: unknown, workspaceId?: string) {
  const query = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : "";
  return app.request(`/${query}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-User-Id": "owner" },
    body: JSON.stringify(body),
  });
}

test("legacy mindmap folder create trims names and rejects empty/duplicate siblings", async () => {
  const { app } = await setup();
  let response = await post(app, { name: "  项目  " });
  assert.equal(response.status, 201);
  assert.equal((await response.json() as any).name, "项目");

  response = await post(app, { name: "   " });
  assert.equal(response.status, 400);
  assert.equal((await response.json() as any).code, "INVALID_FOLDER_NAME");

  response = await post(app, { name: "项目" });
  assert.equal(response.status, 409);
  assert.equal((await response.json() as any).code, "MINDMAP_FOLDER_DUPLICATE");
});

test("legacy mindmap folders cannot cross personal/workspace parent scopes", async () => {
  const { db, app } = await setup();
  db.prepare("INSERT OR REPLACE INTO mindmap_folders (id, userId, workspaceId, parentId, name) VALUES (?, ?, ?, NULL, ?)")
    .run("other-personal", "other", null, "Other");
  db.prepare("INSERT OR REPLACE INTO mindmap_folders (id, userId, workspaceId, parentId, name) VALUES (?, ?, ?, NULL, ?)")
    .run("workspace-b", "other", "ws-b", "B");

  let response = await post(app, { name: "bad", parentId: "other-personal" });
  assert.equal(response.status, 403);

  response = await post(app, { name: "bad", parentId: "workspace-b" }, "ws-a");
  assert.equal(response.status, 403);
});

test("legacy mindmap folder move rejects cycles and subtree depth overflow", async () => {
  const { db, app } = await setup();
  const insert = db.prepare(
    "INSERT OR REPLACE INTO mindmap_folders (id, userId, workspaceId, parentId, name) VALUES (?, 'owner', NULL, ?, ?)",
  );
  insert.run("root-a", null, "A");
  insert.run("child-a", "root-a", "A1");
  insert.run("root-b", null, "B");
  insert.run("child-b", "root-b", "B1");

  let response = await app.request("/root-a", {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "X-User-Id": "owner" },
    body: JSON.stringify({ parentId: "child-a" }),
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json() as any).code, "MINDMAP_FOLDER_CYCLE");

  response = await app.request("/root-a", {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "X-User-Id": "owner" },
    body: JSON.stringify({ parentId: "child-b" }),
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json() as any).code, "MINDMAP_FOLDER_DEPTH_LIMIT");
});

test.after(() => {
  closeDatabase?.();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DB_PATH;
});
