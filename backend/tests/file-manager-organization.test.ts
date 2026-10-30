import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Hono } from "hono";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-files-837-"));
process.env.DB_PATH = path.join(dir, "test.db");
process.env.ELECTRON_USER_DATA = dir;
const owner = "files-837-owner";
const outsider = "files-837-outsider";
let app: Hono;
let schema: typeof import("../src/db/schema");
let signed: typeof import("../src/lib/attachment-signed-url");
let file: { id: string; url: string; filename: string; accessUrls: Record<string, string> };
let attachmentModule: typeof import("../src/routes/attachments");

function request(url: string, method = "GET", body?: unknown, userId = owner) {
  return app.request(url, { method, headers: { "X-User-Id": userId, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
function publicPath(url: string, extras: Record<string, string> = {}) {
  const parsed = new URL(url, "http://localhost");
  for (const [key, value] of Object.entries(extras)) parsed.searchParams.set(key, value);
  return parsed.pathname + parsed.search;
}

test.before(async () => {
  await import("../src/runtime/knowledge-tree-migration-bootstrap");
  schema = await import("../src/db/schema");
  signed = await import("../src/lib/attachment-signed-url");
  attachmentModule = await import("../src/routes/attachments");
  const files = await import("../src/routes/files");
  const folders = await import("../src/routes/attachment-folders");
  const { wrapKnowledgeRoute } = await import("../src/runtime/knowledge-tree");
  app = new Hono();
  app.get("/api/attachments/:id", attachmentModule.handleDownloadAttachment);
  app.route("/api/attachments", attachmentModule.default);
  app.route("/api/files", wrapKnowledgeRoute("/api/files", files.default));
  app.route("/api/attachment-folders", folders.default);
  const db = schema.getDb();
  for (const id of [owner, outsider]) {
    db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, 'hash')").run(id, id);
  }
  for (const [id, userId] of [["folder-a", owner], ["folder-b", owner], ["foreign-folder", outsider]]) {
    db.prepare("INSERT INTO attachment_folders (id, userId, name) VALUES (?, ?, ?)").run(id, userId, id);
  }
  const form = new FormData();
  form.set("file", new File(["Chinese filename content"], "____.pdf", { type: "application/pdf" }));
  form.set("originalFilename", "中文报告 空格😀.pdf");
  form.set("folderId", "folder-a");
  const upload = await app.request("/api/files/upload", { method: "POST", headers: { "X-User-Id": owner }, body: form });
  assert.equal(upload.status, 201);
  file = await upload.json() as typeof file;
});

test.after(() => { schema?.closeDb(); fs.rmSync(dir, { recursive: true, force: true }); });

test("UTF-8 original filename survives a rewritten multipart header and download", async () => {
  assert.equal(file.filename, "中文报告 空格😀.pdf");
  const detail = await (await request(`/api/files/${file.id}`)).json() as any;
  assert.equal(detail.filename, file.filename);
  assert.equal(detail.folderId, "folder-a");
  assert.equal(detail.folderName, "folder-a");
  assert.equal(detail.canManage, true);
  const response = await app.request(publicPath(file.accessUrls[file.id], { download: "1" }));
  assert.equal(response.status, 200);
  assert.equal(decodeURIComponent(response.headers.get("content-disposition")!.split("UTF-8''")[1]), file.filename);
});

test("standard Chinese multipart names remain compatible without the metadata field", async () => {
  const form = new FormData();
  form.set("file", new File(["Different bytes"], "旧客户端中文.txt", { type: "text/plain" }));
  const response = await app.request("/api/files/upload", { method: "POST", headers: { "X-User-Id": owner }, body: form });
  assert.equal(response.status, 201);
  assert.equal((await response.json() as any).filename, "旧客户端中文.txt");
});

test("invalid filename metadata is rejected without creating a file", async () => {
  for (const name of ["../secret.pdf", "bad\r\nheader.pdf", "x".repeat(256), ""]) {
    const form = new FormData();
    form.set("file", new File(["invalid"], "safe.pdf"));
    form.set("originalFilename", name);
    const response = await app.request("/api/files/upload", { method: "POST", headers: { "X-User-Id": owner }, body: form });
    assert.equal(response.status, 400);
  }
});

test("move preserves identity, bytes and note references; unarchive and counts update", async () => {
  const db = schema.getDb();
  const before = db.prepare("SELECT noteId, path, hash FROM attachments WHERE id = ?").get(file.id) as any;
  db.prepare("INSERT INTO attachment_references (attachmentId, noteId) VALUES (?, ?)").run(file.id, before.noteId);
  assert.equal((await request("/api/files/batch-move", "POST", { ids: [file.id, file.id], folderId: "folder-b" })).status, 200);
  assert.deepEqual(db.prepare("SELECT noteId, path, hash FROM attachments WHERE id = ?").get(file.id), before);
  assert.ok(db.prepare("SELECT 1 FROM attachment_references WHERE attachmentId = ?").get(file.id));
  const detail = await (await request(`/api/files/${file.id}`)).json() as any;
  assert.equal(detail.folderName, "folder-b");
  const folders = await (await request("/api/attachment-folders")).json() as any;
  assert.equal(folders.folders.find((f: any) => f.id === "folder-b").fileCount, 1);
  const filtered = await (await request("/api/files?folderId=folder-b")).json() as any;
  assert.equal(filtered.items[0].id, file.id);
  assert.equal((await app.request(publicPath(file.accessUrls[file.id]))).status, 200);
  assert.equal((await request("/api/files/batch-move", "POST", { ids: [file.id], folderId: null })).status, 200);
  assert.equal((await (await request(`/api/files/${file.id}`)).json() as any).folderId, null);
});

test("missing, foreign and unauthorized move targets leave the entire selection unchanged", async () => {
  const db = schema.getDb();
  assert.equal((await request("/api/files/batch-move", "POST", { ids: [file.id], folderId: "foreign-folder" })).status, 404);
  assert.equal((await request("/api/files/batch-move", "POST", { ids: [file.id, "missing"], folderId: "folder-a" })).status, 404);
  assert.equal((await request("/api/files/batch-move", "POST", { ids: [file.id], folderId: null }, outsider)).status, 403);
  assert.equal((db.prepare("SELECT folderId FROM attachments WHERE id = ?").get(file.id) as any).folderId, null);
  for (const body of [{ ids: [], folderId: null }, { ids: [file.id] }, { ids: [3], folderId: null }, { ids: Array(201).fill(file.id), folderId: null }]) {
    assert.equal((await request("/api/files/batch-move", "POST", body)).status, 400);
  }
});

test("private files deny old public links, cached requests and new share creation while retaining owner access", async () => {
  const shareResponse = await request("/api/attachments/file-share", "POST", { attachmentId: file.id });
  assert.equal(shareResponse.status, 200);
  const share = await shareResponse.json() as any;
  const before = await app.request(publicPath(share.url));
  assert.equal(before.status, 200);
  assert.equal((await request(`/api/files/${file.id}/external-access`, "PATCH", { enabled: false }, outsider)).status, 403);
  assert.equal((await request(`/api/files/${file.id}/external-access`, "PATCH", { enabled: "false" })).status, 400);
  assert.equal((await request(`/api/files/${file.id}/external-access`, "PATCH", { enabled: false })).status, 200);
  const revoked = await app.request(publicPath(share.url), { headers: { "If-None-Match": before.headers.get("etag")! } });
  assert.equal(revoked.status, 410);
  const create = await request("/api/attachments/file-share", "POST", { attachmentId: file.id });
  assert.equal(create.status, 403);
  assert.equal((await create.json() as any).code, "FILE_EXTERNAL_ACCESS_DISABLED");
  assert.equal((await app.request(publicPath(file.accessUrls[file.id]))).status, 200);
  const db = schema.getDb();
  const noteId = (db.prepare("SELECT noteId FROM attachments WHERE id = ?").get(file.id) as any).noteId;
  for (const scope of [signed.createShareAttachmentScope("share-837", noteId), signed.createPublicationAttachmentScope("publication-837", noteId)]) {
    const url = signed.createAttachmentSignedUrl(file.url, file.id, scope);
    const response = await app.request(publicPath(url), { headers: { Range: "bytes=0-4", "If-None-Match": before.headers.get("etag")! } });
    assert.equal(response.status, 403);
    assert.equal((await response.json() as any).reason, "file_external_access_disabled");
  }
  // Policy survives reopening the instance database. Enabling cannot revive revoked tokens.
  schema.closeDb();
  assert.equal((await (await request(`/api/files/${file.id}`)).json() as any).externalAccessEnabled, false);
  assert.equal((await request(`/api/files/${file.id}/external-access`, "PATCH", { enabled: true })).status, 200);
  assert.equal((await app.request(publicPath(share.url))).status, 410);
  assert.equal((await request("/api/attachments/file-share", "POST", { attachmentId: file.id })).status, 200);
});

test("manual file share and management do not depend on a hidden holder note projection", async () => {
  const db = schema.getDb();
  const row = db.prepare("SELECT noteId FROM attachments WHERE id = ?").get(file.id) as any;
  db.prepare("DELETE FROM knowledge_tree_nodes WHERE resourceType = 'note' AND resourceId = ?").run(row.noteId);
  assert.equal((await request("/api/files/batch-move", "POST", { ids: [file.id], folderId: "folder-a" })).status, 200);
  const response = await request("/api/attachments/file-share", "POST", { attachmentId: file.id });
  assert.equal(response.status, 200);
  const share = await response.json() as any;
  assert.equal((await app.request(publicPath(share.url))).status, 200);
});

test("workspace upload ownership does not bypass a read-only member role", async () => {
  const db = schema.getDb();
  db.prepare("INSERT INTO workspaces (id, name, ownerId) VALUES ('files-837-workspace', 'Files', ?)").run(outsider);
  db.prepare("INSERT INTO workspace_members (workspaceId, userId, role) VALUES ('files-837-workspace', ?, 'viewer')").run(owner);
  db.prepare("UPDATE attachments SET workspaceId = 'files-837-workspace' WHERE id = ?").run(file.id);
  assert.equal((await request("/api/files/batch-move", "POST", { ids: [file.id], folderId: "folder-b" })).status, 403);
  assert.equal((await request(`/api/files/${file.id}/external-access`, "PATCH", { enabled: false })).status, 403);
  assert.equal((await request("/api/attachments/file-share", "POST", { attachmentId: file.id })).status, 403);
  const detail = await (await request(`/api/files/${file.id}`)).json() as any;
  assert.equal(detail.canManage, false);
  assert.equal(detail.folderId, "folder-a");
  db.prepare("UPDATE attachments SET workspaceId = NULL WHERE id = ?").run(file.id);
});

test("batch move rolls back earlier updates when SQLite rejects a later file", async () => {
  const db = schema.getDb();
  const second = db.prepare("SELECT id, folderId FROM attachments WHERE id != ? LIMIT 1").get(file.id) as any;
  db.exec(`CREATE TRIGGER reject_second_move BEFORE UPDATE OF folderId ON attachments
    WHEN OLD.id = '${second.id}' BEGIN SELECT RAISE(ABORT, 'test move rollback'); END`);
  const response = await request("/api/files/batch-move", "POST", { ids: [file.id, second.id], folderId: "folder-b" });
  assert.equal(response.status, 500);
  assert.equal((db.prepare("SELECT folderId FROM attachments WHERE id = ?").get(file.id) as any).folderId, "folder-a");
  assert.equal((db.prepare("SELECT folderId FROM attachments WHERE id = ?").get(second.id) as any).folderId, second.folderId);
  db.exec("DROP TRIGGER reject_second_move");
});

test("turning off public access also revokes seekable audio range responses", async () => {
  const form = new FormData();
  form.set("file", new File(["0123456789audio"], "录音.wav", { type: "audio/wav" }));
  const upload = await app.request("/api/files/upload", { method: "POST", headers: { "X-User-Id": owner }, body: form });
  assert.equal(upload.status, 201);
  const audio = await upload.json() as any;
  const shared = await request("/api/attachments/file-share", "POST", { attachmentId: audio.id });
  assert.equal(shared.status, 200);
  const share = await shared.json() as any;
  const range = await app.request(publicPath(share.url), { headers: { Range: "bytes=0-4" } });
  assert.equal(range.status, 206);
  assert.equal(await range.text(), "01234");
  assert.equal((await request(`/api/files/${audio.id}/external-access`, "PATCH", { enabled: false })).status, 200);
  assert.equal((await app.request(publicPath(share.url), { headers: { Range: "bytes=0-4" } })).status, 410);
  assert.equal((await app.request(publicPath(audio.accessUrls[audio.id]), { headers: { Range: "bytes=0-4" } })).status, 206);
});
