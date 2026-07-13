import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import type Database from "better-sqlite3";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-tags-route-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");
process.env.DB_DRIVER = "sqlite";

const USER_ID = "tags-route-user";
const NOTEBOOK_ID = "tags-route-notebook";
const NOTE_ID = "tags-route-note";

let app: Hono;
let getDb: () => Database.Database;
let closeDb: () => void;

function db() {
  return getDb();
}

async function requestJson(
  method: string,
  url: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const response = await app.request(url, {
    method,
    headers: {
      "X-User-Id": USER_ID,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() };
}

test.before(async () => {
  const [routeModule, schemaModule] = await Promise.all([
    import("../src/routes/tags"),
    import("../src/db/schema"),
  ]);

  app = new Hono();
  app.route("/tags", routeModule.default);
  getDb = schemaModule.getDb;
  closeDb = schemaModule.closeDb;

  db()
    .prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
    .run(USER_ID, USER_ID, "hash");
  db()
    .prepare("INSERT INTO notebooks (id, userId, name) VALUES (?, ?, ?)")
    .run(NOTEBOOK_ID, USER_ID, "标签路由测试");
  db()
    .prepare("INSERT INTO notes (id, userId, notebookId, title) VALUES (?, ?, ?, ?)")
    .run(NOTE_ID, USER_ID, NOTEBOOK_ID, "标签路由笔记");
});

test.beforeEach(() => {
  db().prepare("DELETE FROM note_tags").run();
  db().prepare("DELETE FROM tags").run();
});

test.after(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("tags route performs create, list, update, attach and transactional delete through async repositories", async () => {
  const created = await requestJson("POST", "/tags", {
    name: "Async Route",
    color: "#123456",
  });
  assert.equal(created.status, 201);
  assert.equal(created.json.name, "Async Route");
  const tagId = created.json.id as string;
  assert.ok(tagId);

  const duplicate = await requestJson("POST", "/tags", {
    name: "Async Route",
    color: "#654321",
  });
  assert.equal(duplicate.status, 409);

  const listed = await requestJson("GET", "/tags?includeEmpty=true");
  assert.equal(listed.status, 200);
  assert.ok(listed.json.some((tag: any) => tag.id === tagId));

  const updated = await requestJson("PUT", `/tags/${tagId}`, {
    name: "Async Route Updated",
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.json.name, "Async Route Updated");

  const attached = await requestJson("POST", `/tags/note/${NOTE_ID}/tag/${tagId}`);
  assert.equal(attached.status, 200);
  const link = db()
    .prepare("SELECT noteId, tagId FROM note_tags WHERE noteId = ? AND tagId = ?")
    .get(NOTE_ID, tagId);
  assert.ok(link);

  const removed = await requestJson("DELETE", `/tags/${tagId}`);
  assert.equal(removed.status, 200);
  assert.equal(
    db().prepare("SELECT id FROM tags WHERE id = ?").get(tagId),
    undefined,
  );
  assert.equal(
    db().prepare("SELECT noteId FROM note_tags WHERE tagId = ?").get(tagId),
    undefined,
  );
});

test("tags route preserves note and tag workspace consistency validation", async () => {
  const created = await requestJson("POST", "/tags", { name: "Personal Tag" });
  assert.equal(created.status, 201);

  db().prepare(
    "INSERT INTO workspaces (id, name, ownerId) VALUES (?, ?, ?)",
  ).run("tags-route-workspace", "工作区", USER_ID);
  db().prepare(
    "INSERT INTO notebooks (id, userId, name, workspaceId) VALUES (?, ?, ?, ?)",
  ).run("tags-route-workspace-notebook", USER_ID, "工作区笔记本", "tags-route-workspace");
  db().prepare(
    "INSERT INTO notes (id, userId, notebookId, title, workspaceId) VALUES (?, ?, ?, ?, ?)",
  ).run(
    "tags-route-workspace-note",
    USER_ID,
    "tags-route-workspace-notebook",
    "工作区笔记",
    "tags-route-workspace",
  );

  const response = await requestJson(
    "POST",
    `/tags/note/tags-route-workspace-note/tag/${created.json.id}`,
  );
  assert.equal(response.status, 400);
  assert.equal(response.json.error, "tag and note must belong to the same workspace");
});
