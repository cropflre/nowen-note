import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Hono } from "hono";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-files-link-state-"));
process.env.DB_PATH = path.join(dir, "test.db");
process.env.ELECTRON_USER_DATA = dir;
const owner = "files-link-owner";
const outsider = "files-link-outsider";
let app: Hono;
let schema: typeof import("../src/db/schema");
let fileId = "";

function request(url: string, method = "GET", body?: unknown, userId = owner) {
  return app.request(url, { method, headers: { "X-User-Id": userId, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

async function listedFile(userId = owner) {
  const response = await request("/api/files", "GET", undefined, userId);
  assert.equal(response.status, 200);
  const body = await response.json() as { items: Array<{ id: string; externalAccessEnabled?: boolean; publicLinkActive?: boolean }> };
  return body.items.find((item) => item.id === fileId);
}

test.before(async () => {
  await import("../src/runtime/knowledge-tree-migration-bootstrap");
  schema = await import("../src/db/schema");
  const attachments = await import("../src/routes/attachments");
  const files = await import("../src/routes/files");
  const { wrapKnowledgeRoute } = await import("../src/runtime/knowledge-tree");
  app = new Hono();
  app.route("/api/attachments", attachments.default);
  app.route("/api/files", wrapKnowledgeRoute("/api/files", files.default));
  const db = schema.getDb();
  for (const id of [owner, outsider]) {
    db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, 'hash')").run(id, id);
  }
  const form = new FormData();
  form.set("file", new File(["link state"], "logo.png", { type: "image/png" }));
  const upload = await app.request("/api/files/upload", { method: "POST", headers: { "X-User-Id": owner }, body: form });
  assert.equal(upload.status, 201);
  fileId = (await upload.json() as { id: string }).id;
});

test.after(() => { schema?.closeDb(); fs.rmSync(dir, { recursive: true, force: true }); });

test("list reports a file as not public until its owner creates a link", async () => {
  const before = await listedFile();
  assert.equal(before?.externalAccessEnabled, true);
  assert.equal(before?.publicLinkActive, false);
  assert.equal((await request("/api/attachments/file-share", "POST", { attachmentId: fileId })).status, 200);
  assert.equal((await listedFile())?.publicLinkActive, true);
});

test("another user's link, revoked or expired links never show as the caller's public link", async () => {
  const db = schema.getDb();
  db.prepare("UPDATE file_shares SET isActive = 0 WHERE attachmentId = ? AND ownerId = ?").run(fileId, owner);
  assert.equal((await listedFile())?.publicLinkActive, false);

  const noteId = (db.prepare("SELECT noteId FROM attachments WHERE id = ?").get(fileId) as { noteId: string }).noteId;
  db.prepare(`INSERT INTO file_shares (id, token, attachmentId, noteId, ownerId, isActive)
    VALUES ('foreign-share', 'foreign-token', ?, ?, ?, 1)`).run(fileId, noteId, outsider);
  assert.equal((await listedFile())?.publicLinkActive, false);

  db.prepare(`INSERT INTO file_shares (id, token, attachmentId, noteId, ownerId, isActive, expiresAt)
    VALUES ('expired-share', 'expired-token', ?, ?, ?, 1, '2000-01-01T00:00:00.000Z')`).run(fileId, noteId, owner);
  assert.equal((await listedFile())?.publicLinkActive, false);

  // The outsider cannot list the owner's personal files at all.
  assert.equal(await listedFile(outsider), undefined);
});

test("turning off external access is reflected in the list and clears the public state", async () => {
  assert.equal((await request("/api/attachments/file-share", "POST", { attachmentId: fileId })).status, 200);
  assert.equal((await listedFile())?.publicLinkActive, true);
  assert.equal((await request(`/api/files/${fileId}/external-access`, "PATCH", { enabled: false })).status, 200);
  const disabled = await listedFile();
  assert.equal(disabled?.externalAccessEnabled, false);
  assert.equal(disabled?.publicLinkActive, false);
  assert.equal((await request(`/api/files/${fileId}/external-access`, "PATCH", { enabled: true })).status, 200);
  const enabled = await listedFile();
  assert.equal(enabled?.externalAccessEnabled, true);
  // Re-enabling never revives the revoked link; a new one is created only on the next copy.
  assert.equal(enabled?.publicLinkActive, false);
});
