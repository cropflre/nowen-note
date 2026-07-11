import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-migration-v2-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");
process.env.ELECTRON_USER_DATA = tmpDir;
process.env.NODE_ENV = "test";

let app: Hono;
let getDb: typeof import("../src/db/schema").getDb;
let closeDb: typeof import("../src/db/schema").closeDb;
let writeAttachmentObject: typeof import("../src/services/attachment-storage").writeAttachmentObject;

const SOURCE_USER = "source-user";
const TARGET_USER = "target-user";
const SOURCE_NOTEBOOK = "source-notebook";
const SOURCE_NOTE = "source-note";
const SOURCE_TASK = "source-task";
const NOTE_ATTACHMENT = "source-note-attachment";
const TASK_ATTACHMENT = "source-task-attachment";

test.before(async () => {
  const [routeModule, schemaModule, storageModule] = await Promise.all([
    import("../src/routes/user-migration-v2"),
    import("../src/db/schema"),
    import("../src/services/attachment-storage"),
  ]);
  getDb = schemaModule.getDb;
  closeDb = schemaModule.closeDb;
  writeAttachmentObject = storageModule.writeAttachmentObject;
  app = new Hono();
  app.route("/v2", routeModule.default);

  const db = getDb();
  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)").run(SOURCE_USER, "source", "hash");
  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)").run(TARGET_USER, "target", "hash");
  db.prepare(
    "INSERT INTO notebooks (id, userId, name, workspaceId) VALUES (?, ?, ?, NULL)",
  ).run(SOURCE_NOTEBOOK, SOURCE_USER, "Source notebook");
  db.prepare(
    `INSERT INTO notes (id, userId, notebookId, title, content, contentText, contentFormat, workspaceId)
     VALUES (?, ?, ?, ?, ?, ?, 'markdown', NULL)`,
  ).run(
    SOURCE_NOTE,
    SOURCE_USER,
    SOURCE_NOTEBOOK,
    "Source note",
    `# Source\n\n![image](/api/attachments/${NOTE_ATTACHMENT})`,
    "Source",
  );
  db.prepare(
    `INSERT INTO tasks (id, userId, title, description, workspaceId, status)
     VALUES (?, ?, ?, ?, NULL, 'todo')`,
  ).run(
    SOURCE_TASK,
    SOURCE_USER,
    "Source task",
    `![task](/api/task-attachments/${TASK_ATTACHMENT})`,
  );

  const noteBytes = Buffer.from("note-attachment-v2");
  const taskBytes = Buffer.from("task-attachment-v2");
  await writeAttachmentObject("2026/07/source-note.bin", noteBytes, "application/octet-stream");
  await writeAttachmentObject("2026/07/source-task.png", taskBytes, "image/png");
  db.prepare(
    `INSERT INTO attachments
     (id, noteId, userId, filename, mimeType, size, path, workspaceId, hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
  ).run(
    NOTE_ATTACHMENT,
    SOURCE_NOTE,
    SOURCE_USER,
    "source.bin",
    "application/octet-stream",
    noteBytes.length,
    "2026/07/source-note.bin",
    "",
  );
  db.prepare(
    `INSERT INTO task_attachments
     (id, taskId, userId, workspaceId, filename, mimeType, size, path)
     VALUES (?, ?, ?, NULL, ?, ?, ?, ?)`,
  ).run(
    TASK_ATTACHMENT,
    SOURCE_TASK,
    SOURCE_USER,
    "source.png",
    "image/png",
    taskBytes.length,
    "2026/07/source-task.png",
  );
});

test.after(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function headers(userId: string, json = false): Record<string, string> {
  return {
    "X-User-Id": userId,
    ...(json ? { "Content-Type": "application/json" } : {}),
  };
}

test("preflight scans notes, tasks and verifies both attachment kinds", async () => {
  const response = await app.request("/v2/preflight", { headers: headers(SOURCE_USER) });
  assert.equal(response.status, 200);
  const body = await response.json() as any;
  assert.equal(body.counts.notebooks, 1);
  assert.equal(body.counts.notes, 1);
  assert.equal(body.counts.tasks, 1);
  assert.equal(body.counts.attachments, 2);
  assert.equal(body.counts.missingAttachments, 0);
  assert.equal(body.attachments.manifest.length, 2);
  assert.ok(body.attachments.manifest.every((item: any) => /^[0-9a-f]{64}$/.test(item.hash)));
});

test("source backup is created before migration", async () => {
  const response = await app.request("/v2/source-backup", {
    method: "POST",
    headers: headers(SOURCE_USER, true),
    body: "{}",
  });
  assert.equal(response.status, 200);
  const body = await response.json() as any;
  assert.equal(body.success, true);
  assert.match(body.sha256, /^[0-9a-f]{64}$/);
  assert.ok(fs.existsSync(path.join(tmpDir, "migration-backups", body.filename)));
});

test("metadata import is idempotent and preserves task mappings", async () => {
  const exportedResponse = await app.request("/v2/export", { headers: headers(SOURCE_USER) });
  const payload = await exportedResponse.json();
  const migrationId = "migration-idempotent";

  const first = await app.request("/v2/import", {
    method: "POST",
    headers: headers(TARGET_USER, true),
    body: JSON.stringify({ migrationId, strategy: "skip", payload }),
  });
  assert.equal(first.status, 200);
  const firstBody = await first.json() as any;
  assert.equal(Object.keys(firstBody.idMap.notes).length, 1);
  assert.equal(Object.keys(firstBody.idMap.tasks).length, 1);

  const second = await app.request("/v2/import", {
    method: "POST",
    headers: headers(TARGET_USER, true),
    body: JSON.stringify({ migrationId: "migration-repeat", strategy: "skip", payload }),
  });
  assert.equal(second.status, 200);
  const secondBody = await second.json() as any;
  assert.equal(secondBody.idMap.notes[SOURCE_NOTE], firstBody.idMap.notes[SOURCE_NOTE]);
  assert.equal(secondBody.idMap.tasks[SOURCE_TASK], firstBody.idMap.tasks[SOURCE_TASK]);

  const db = getDb();
  const noteCount = (db.prepare(
    "SELECT COUNT(*) AS count FROM notes WHERE userId = ? AND workspaceId IS NULL",
  ).get(TARGET_USER) as { count: number }).count;
  const taskCount = (db.prepare(
    "SELECT COUNT(*) AS count FROM tasks WHERE userId = ? AND workspaceId IS NULL",
  ).get(TARGET_USER) as { count: number }).count;
  assert.equal(noteCount, 1);
  assert.equal(taskCount, 1);
});

test("attachment import rejects hash mismatch, resumes idempotently and completes verification", async () => {
  const preflight = await (await app.request("/v2/preflight", { headers: headers(SOURCE_USER) })).json() as any;
  const payload = await (await app.request("/v2/export", { headers: headers(SOURCE_USER) })).json() as any;
  const migrationId = "migration-attachments";
  const imported = await (await app.request("/v2/import", {
    method: "POST",
    headers: headers(TARGET_USER, true),
    body: JSON.stringify({ migrationId, strategy: "skip", payload }),
  })).json() as any;

  const noteItem = preflight.attachments.manifest.find((item: any) => item.kind === "note");
  const sourceDownload = await app.request(`/v2/attachment/note/${NOTE_ATTACHMENT}`, {
    headers: headers(SOURCE_USER),
  });
  assert.equal(sourceDownload.status, 200);
  const blob = await sourceDownload.blob();

  const badForm = new FormData();
  badForm.set("file", new File([blob], noteItem.filename, { type: noteItem.mimeType }));
  badForm.set("migrationId", migrationId);
  badForm.set("sourceInstanceId", preflight.source.instanceId);
  badForm.set("sourceUserId", preflight.source.userId);
  badForm.set("sourceAttachmentId", noteItem.id);
  badForm.set("sourceHash", "0".repeat(64));
  badForm.set("kind", "note");
  badForm.set("targetParentId", imported.idMap.notes[SOURCE_NOTE]);
  const bad = await app.request("/v2/attachment/import", {
    method: "POST",
    headers: headers(TARGET_USER),
    body: badForm,
  });
  assert.equal(bad.status, 409);

  async function upload(item: any) {
    const downloaded = await app.request(`/v2/attachment/${item.kind}/${item.id}`, {
      headers: headers(SOURCE_USER),
    });
    const fileBlob = await downloaded.blob();
    const form = new FormData();
    form.set("file", new File([fileBlob], item.filename, { type: item.mimeType }));
    form.set("migrationId", migrationId);
    form.set("sourceInstanceId", preflight.source.instanceId);
    form.set("sourceUserId", preflight.source.userId);
    form.set("sourceAttachmentId", item.id);
    form.set("sourceHash", item.hash);
    form.set("kind", item.kind);
    form.set(
      "targetParentId",
      item.kind === "note" ? imported.idMap.notes[item.parentId] : imported.idMap.tasks[item.parentId],
    );
    return app.request("/v2/attachment/import", {
      method: "POST",
      headers: headers(TARGET_USER),
      body: form,
    });
  }

  const firstUpload = await upload(noteItem);
  assert.equal(firstUpload.status, 201);
  const firstBody = await firstUpload.json() as any;
  const repeatedUpload = await upload(noteItem);
  assert.equal(repeatedUpload.status, 200);
  const repeatedBody = await repeatedUpload.json() as any;
  assert.equal(repeatedBody.reused, true);
  assert.equal(repeatedBody.id, firstBody.id);

  const taskItem = preflight.attachments.manifest.find((item: any) => item.kind === "task");
  const taskUpload = await upload(taskItem);
  assert.equal(taskUpload.status, 201);

  const complete = await app.request("/v2/complete", {
    method: "POST",
    headers: headers(TARGET_USER, true),
    body: JSON.stringify({ migrationId, attachments: preflight.attachments.manifest }),
  });
  assert.equal(complete.status, 200);
  const completed = await complete.json() as any;
  assert.equal(completed.verifiedAttachments, 2);
});
