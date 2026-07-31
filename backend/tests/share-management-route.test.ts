import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import type Database from "better-sqlite3";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-share-management-route-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");
process.env.ELECTRON_USER_DATA = tmpDir;
process.env.JWT_SECRET = "test-share-management-route-secret";

let app: Hono;
let getDb: () => Database.Database;
let closeDb: () => void;

function db() {
  return getDb();
}

async function requestJson(
  url: string,
  userId: string,
  method = "GET",
  body?: unknown,
) {
  const response = await app.request(url, {
    method,
    headers: {
      "X-User-Id": userId,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() as any };
}

async function getJson(url: string, userId: string) {
  return requestJson(url, userId);
}

test.before(async () => {
  const [sharesModule, schemaModule] = await Promise.all([
    import("../src/routes/shares"),
    import("../src/db/schema"),
  ]);
  app = new Hono();
  app.route("/shares", sharesModule.sharesRouter);
  getDb = schemaModule.getDb;
  closeDb = schemaModule.closeDb;

  for (const id of ["owner", "manager", "editor", "commenter", "viewer", "outsider"]) {
    db().prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)").run(id, id, "hash");
  }
  db().prepare("INSERT INTO workspaces (id, name, description, icon, ownerId) VALUES (?, ?, '', '🏢', ?)")
    .run("ws", "协作空间", "owner");
  for (const [userId, role] of [
    ["owner", "owner"],
    ["editor", "editor"],
    ["commenter", "commenter"],
    ["viewer", "viewer"],
  ] as const) {
    db().prepare("INSERT INTO workspace_members (workspaceId, userId, role) VALUES (?, ?, ?)")
      .run("ws", userId, role);
  }
  db().prepare("INSERT INTO notebooks (id, userId, workspaceId, name) VALUES (?, ?, ?, ?)")
    .run("nb", "owner", "ws", "共享目录");
  db().prepare("INSERT INTO notes (id, userId, notebookId, workspaceId, title, content, contentText) VALUES (?, ?, ?, ?, ?, '{}', '')")
    .run("note", "owner", "nb", "ws", "公开笔记");
  db().prepare(`INSERT INTO notebook_members
    (id, notebookId, userId, role, status, allowDownload, allowReshare, source)
    VALUES (?, ?, ?, 'owner', 'active', 1, 1, 'manual')`)
    .run("member-manager", "nb", "manager");
  db().prepare(`INSERT INTO shares
    (id, noteId, ownerId, shareToken, permission, password, maxViews, viewCount, isActive)
    VALUES (?, ?, ?, ?, 'view', ?, 3, 3, 1)`)
    .run("share", "note", "owner", "share-token", "password-hash");
});

test.after(() => {
  closeDb?.();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("legacy share list remains an owner-only array", async () => {
  const owner = await getJson("/shares", "owner");
  assert.equal(owner.status, 200);
  assert.ok(Array.isArray(owner.json));
  assert.equal(owner.json.length, 1);
  assert.equal(owner.json[0].hasPassword, true);
  assert.equal("password" in owner.json[0], false);

  const manager = await getJson("/shares", "manager");
  assert.deepEqual(manager.json, []);
});

test("management response exposes manageable links, lifecycle status and no password hash", async () => {
  const manager = await getJson("/shares?management=1&status=exhausted&page=1&pageSize=20", "manager");
  assert.equal(manager.status, 200);
  assert.equal(manager.json.total, 1);
  assert.equal(manager.json.items[0].id, "share");
  assert.equal(manager.json.items[0].noteTitle, "公开笔记");
  assert.equal(manager.json.items[0].effectiveStatus, "exhausted");
  assert.equal(manager.json.items[0].hasPassword, true);
  assert.equal("password" in manager.json.items[0], false);
  assert.deepEqual(manager.json.stats, {
    total: 1,
    active: 0,
    disabled: 0,
    expired: 0,
    exhausted: 1,
  });
});

test("users without manage access cannot discover another user's shares", async () => {
  const outsider = await getJson("/shares?management=1", "outsider");
  assert.equal(outsider.status, 200);
  assert.equal(outsider.json.total, 0);
  assert.deepEqual(outsider.json.items, []);
});

test("note managers can open the existing per-note list and share detail", async () => {
  const list = await getJson("/shares/note/note", "manager");
  assert.equal(list.status, 200);
  assert.equal(list.json.length, 1);
  assert.equal(list.json[0].id, "share");
  assert.equal("password" in list.json[0], false);

  const detail = await getJson("/shares/share", "manager");
  assert.equal(detail.status, 200);
  assert.equal(detail.json.id, "share");
  assert.equal(detail.json.hasPassword, true);
  assert.equal("password" in detail.json, false);
});

test("workspace comment permissions preserve inline anchor data and management boundaries", async () => {
  const anchorData = JSON.stringify({
    version: 1,
    kind: "text",
    editor: "tiptap",
    quote: "需要批注的原文",
    prefix: "前文",
    suffix: "后文",
    start: 4,
    end: 11,
    createdAt: 1,
  });

  const viewerCreate = await requestJson("/shares/note/note/comments", "viewer", "POST", {
    content: "viewer 不应成功",
    anchorData,
  });
  assert.equal(viewerCreate.status, 403);

  const commenterCreate = await requestJson("/shares/note/note/comments", "commenter", "POST", {
    content: "这里需要补充说明",
    anchorData,
  });
  assert.equal(commenterCreate.status, 201);
  assert.equal(commenterCreate.json.userId, "commenter");
  assert.equal(commenterCreate.json.anchorData, anchorData);

  const viewerList = await getJson("/shares/note/note/comments", "viewer");
  assert.equal(viewerList.status, 200);
  assert.equal(viewerList.json.length, 1);
  assert.equal(viewerList.json[0].content, "这里需要补充说明");

  const editorResolve = await requestJson(
    `/shares/note/note/comments/${commenterCreate.json.id}/resolve`,
    "editor",
    "PATCH",
  );
  assert.equal(editorResolve.status, 403);

  const managerResolve = await requestJson(
    `/shares/note/note/comments/${commenterCreate.json.id}/resolve`,
    "manager",
    "PATCH",
  );
  assert.equal(managerResolve.status, 200);
  assert.equal(managerResolve.json.isResolved, 1);

  const commenterDelete = await requestJson(
    `/shares/note/note/comments/${commenterCreate.json.id}`,
    "commenter",
    "DELETE",
  );
  assert.equal(commenterDelete.status, 200);
});
