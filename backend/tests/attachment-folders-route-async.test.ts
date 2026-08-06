import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import type Database from "better-sqlite3";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-attachment-folders-route-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");
process.env.DB_DRIVER = "sqlite";

const USER_ID = "attachment-folders-route-user";
const NOTEBOOK_ID = "attachment-folders-route-notebook";
const NOTE_ID = "attachment-folders-route-note";

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
    import("../src/routes/attachment-folders"),
    import("../src/db/schema"),
  ]);

  app = new Hono();
  app.route("/attachment-folders", routeModule.default);
  getDb = schemaModule.getDb;
  closeDb = schemaModule.closeDb;

  db()
    .prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
    .run(USER_ID, USER_ID, "hash");
  db()
    .prepare("INSERT INTO notebooks (id, userId, name) VALUES (?, ?, ?)")
    .run(NOTEBOOK_ID, USER_ID, "附件目录测试");
  db()
    .prepare("INSERT INTO notes (id, userId, notebookId, title) VALUES (?, ?, ?, ?)")
    .run(NOTE_ID, USER_ID, NOTEBOOK_ID, "附件目录笔记");
});

test.after(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("attachment folder routes use async boundaries for count, rename and transactional delete", async () => {
  const missingParent = await requestJson("POST", "/attachment-folders", {
    name: "Child",
    parentId: "missing-parent",
  });
  assert.equal(missingParent.status, 404);

  const created = await requestJson("POST", "/attachment-folders", {
    name: "Documents",
  });
  assert.equal(created.status, 201);
  assert.equal(created.json.fileCount, 0);
  const folderId = created.json.id as string;

  const duplicate = await requestJson("POST", "/attachment-folders", {
    name: "Documents",
  });
  assert.equal(duplicate.status, 409);

  const renamed = await requestJson("PATCH", `/attachment-folders/${folderId}`, {
    name: "Documents Renamed",
  });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.json.name, "Documents Renamed");

  db().prepare(
    `INSERT INTO attachments
       (id, noteId, userId, filename, mimeType, size, path, workspaceId, folderId)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "attachment-folders-route-file",
    NOTE_ID,
    USER_ID,
    "document.txt",
    "text/plain",
    12,
    "document.txt",
    null,
    folderId,
  );

  const listed = await requestJson("GET", "/attachment-folders");
  assert.equal(listed.status, 200);
  const listedFolder = listed.json.folders.find((folder: any) => folder.id === folderId);
  assert.ok(listedFolder);
  assert.equal(listedFolder.fileCount, 1);

  const deleted = await requestJson("DELETE", `/attachment-folders/${folderId}`);
  assert.equal(deleted.status, 200);
  assert.equal(deleted.json.success, true);
  assert.equal(
    db().prepare("SELECT id FROM attachment_folders WHERE id = ?").get(folderId),
    undefined,
  );
  const attachment = db()
    .prepare("SELECT folderId FROM attachments WHERE id = ?")
    .get("attachment-folders-route-file") as { folderId: string | null };
  assert.equal(attachment.folderId, null);
});
