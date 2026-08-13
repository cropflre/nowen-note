import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import type Database from "better-sqlite3";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-task-attachments-route-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");
process.env.DB_DRIVER = "sqlite";
process.env.ELECTRON_USER_DATA = tmpDir;

const USER_ID = "task-attachments-route-user";
const TASK_ID = "task-attachments-route-task";

let app: Hono;
let getDb: () => Database.Database;
let closeDb: () => void;
let readAttachmentObject: (objectPath: string) => Promise<Buffer | null>;

function db() {
  return getDb();
}

test.before(async () => {
  const [routeModule, schemaModule, storageModule] = await Promise.all([
    import("../src/routes/task-attachments"),
    import("../src/db/schema"),
    import("../src/services/attachment-storage"),
  ]);

  app = new Hono();
  app.get("/task-attachments/:id", routeModule.handleDownloadTaskAttachment);
  app.route("/task-attachments", routeModule.default);
  getDb = schemaModule.getDb;
  closeDb = schemaModule.closeDb;
  readAttachmentObject = storageModule.readAttachmentObject;

  db()
    .prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
    .run(USER_ID, USER_ID, "hash");
  db()
    .prepare("INSERT INTO tasks (id, userId, title) VALUES (?, ?, ?)")
    .run(TASK_ID, USER_ID, "Task attachment route");
});

test.after(async () => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("task attachment route supports orphan upload, async bind, download and delete", async () => {
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);
  const form = new FormData();
  form.set("file", new File([bytes], "diagram.png", { type: "image/png" }));

  const uploadResponse = await app.request("/task-attachments", {
    method: "POST",
    headers: { "X-User-Id": USER_ID },
    body: form,
  });
  assert.equal(uploadResponse.status, 201);
  const uploaded = await uploadResponse.json() as {
    id: string;
    url: string;
    mimeType: string;
    filename: string;
  };
  assert.match(uploaded.url, /^\/api\/task-attachments\//);
  assert.equal(uploaded.mimeType, "image/png");

  const orphan = db()
    .prepare("SELECT taskId, userId, path FROM task_attachments WHERE id = ?")
    .get(uploaded.id) as { taskId: string | null; userId: string; path: string };
  assert.ok(orphan);
  assert.equal(orphan.taskId, null);
  assert.equal(orphan.userId, USER_ID);
  assert.deepEqual(Array.from(await readAttachmentObject(orphan.path) || []), Array.from(bytes));

  const bindResponse = await app.request(`/task-attachments/${uploaded.id}/bind`, {
    method: "PATCH",
    headers: {
      "X-User-Id": USER_ID,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ taskId: TASK_ID }),
  });
  assert.equal(bindResponse.status, 200);
  assert.equal(
    (db().prepare("SELECT taskId FROM task_attachments WHERE id = ?").get(uploaded.id) as any).taskId,
    TASK_ID,
  );

  const downloadResponse = await app.request(`/task-attachments/${uploaded.id}`);
  assert.equal(downloadResponse.status, 200);
  assert.equal(downloadResponse.headers.get("content-type"), "image/png");
  assert.deepEqual(
    Array.from(new Uint8Array(await downloadResponse.arrayBuffer())),
    Array.from(bytes),
  );

  const deleteResponse = await app.request(`/task-attachments/${uploaded.id}`, {
    method: "DELETE",
    headers: { "X-User-Id": USER_ID },
  });
  assert.equal(deleteResponse.status, 200);
  assert.equal(
    db().prepare("SELECT id FROM task_attachments WHERE id = ?").get(uploaded.id),
    undefined,
  );
  assert.equal(await readAttachmentObject(orphan.path), null);
});
