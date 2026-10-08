import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import test from "node:test";
import type Database from "better-sqlite3";
import { Hono } from "hono";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-upload-repair-"));
process.env.DB_PATH = path.join(directory, "test.db");
process.env.ELECTRON_USER_DATA = directory;
process.env.ATTACHMENT_SIGNING_SECRET = "upload-repair-test-signing-secret";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jrwoAAAAASUVORK5CYII=", "base64");
const hash = crypto.createHash("sha256").update(png).digest("hex");
let db: Database.Database;
let closeDb: () => void;
let app: Hono;
let storage: typeof import("../src/services/attachment-storage.js");
let server: http.Server;
let endpoint: string;
let headStatus: number | null = null;
let putStatus: number | null = null;
let disconnectHead = false;
const objects = new Map<string, Buffer>();
const requests: Array<{ method: string; key: string }> = [];

test.before(async () => {
  delete process.env.ATTACHMENT_STORAGE;
  await import("../src/runtime/knowledge-tree-migration-bootstrap.js");
  const schema = await import("../src/db/schema.js");
  db = schema.getDb();
  closeDb = schema.closeDb;
  storage = await import("../src/services/attachment-storage.js");
  const { default: files } = await import("../src/routes/files.js");
  const { handleDownloadAttachment } = await import("../src/routes/attachments.js");
  const { wrapKnowledgeRoute } = await import("../src/runtime/knowledge-tree.js");
  app = new Hono();
  app.route("/api/files", wrapKnowledgeRoute("/api/files", files));
  app.get("/api/attachments/:id", handleDownloadAttachment);

  server = http.createServer(async (request, response) => {
    const key = new URL(request.url || "/", "http://localhost").pathname;
    const method = request.method || "GET";
    requests.push({ method, key });
    if (method === "HEAD") {
      if (disconnectHead) {
        request.socket.destroy();
        return;
      }
      response.writeHead(headStatus ?? (objects.has(key) ? 200 : 404));
      response.end();
    } else if (method === "PUT") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      if (putStatus === null) objects.set(key, Buffer.concat(chunks));
      response.writeHead(putStatus ?? 200);
      response.end();
    } else {
      const content = objects.get(key);
      response.writeHead(content ? 200 : 404);
      response.end(content);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

test.beforeEach(() => {
  delete process.env.ATTACHMENT_STORAGE;
  headStatus = null;
  putStatus = null;
  disconnectHead = false;
  requests.length = 0;
  objects.clear();
});

test.after(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  closeDb?.();
  fs.rmSync(directory, { recursive: true, force: true });
});

function useS3() {
  Object.assign(process.env, {
    ATTACHMENT_STORAGE: "s3", S3_ENDPOINT: endpoint, S3_REGION: "test-region",
    S3_BUCKET: "test-bucket", S3_ACCESS_KEY_ID: "test-key", S3_SECRET_ACCESS_KEY: "test-secret",
    S3_PREFIX: "test-prefix",
  });
}

function seed(options: { userId?: string; workspaceId?: string; legacyMime?: boolean; referenced?: boolean } = {}) {
  const id = crypto.randomUUID();
  const userId = options.userId || crypto.randomUUID();
  const workspaceId = options.workspaceId || null;
  const notebookId = crypto.randomUUID();
  const noteId = crypto.randomUUID();
  const originalPath = `2020/03/${id}.png`;
  db.prepare("INSERT OR IGNORE INTO users (id, username, passwordHash) VALUES (?, ?, 'hash')").run(userId, userId);
  if (workspaceId) {
    db.prepare("INSERT OR IGNORE INTO workspaces (id, name, ownerId) VALUES (?, 'Team', ?)").run(workspaceId, userId);
    db.prepare("INSERT OR IGNORE INTO workspace_members (workspaceId, userId, role) VALUES (?, ?, 'owner')").run(workspaceId, userId);
  }
  db.prepare("INSERT INTO notebooks (id, userId, name, workspaceId) VALUES (?, ?, 'Files', ?)")
    .run(notebookId, userId, workspaceId);
  db.prepare("INSERT INTO notes (id, userId, notebookId, title, content, workspaceId) VALUES (?, ?, ?, 'Original', ?, ?)")
    .run(noteId, userId, notebookId, options.referenced ? `/api/attachments/${id}` : "{}", workspaceId);
  db.prepare(`INSERT INTO attachments (id, noteId, userId, filename, mimeType, size, path, workspaceId, hash)
    VALUES (?, ?, ?, 'original.png', ?, ?, ?, ?, ?)`)
    .run(id, noteId, userId, options.legacyMime ? "application/octet-stream" : "image/png", options.legacyMime ? 0 : png.length, originalPath, workspaceId, hash);
  if (options.referenced) db.prepare("INSERT INTO attachment_references (attachmentId, noteId) VALUES (?, ?)").run(id, noteId);
  return { id, userId, noteId, workspaceId, originalPath };
}

async function upload(fixture: ReturnType<typeof seed>, workspaceId = fixture.workspaceId) {
  const form = new FormData();
  form.set("file", new File([new Uint8Array(png)], "reuploaded.png", { type: "image/png" }));
  const response = await app.request(`/api/files/upload${workspaceId ? `?workspaceId=${workspaceId}` : ""}`, {
    method: "POST", headers: { "X-User-Id": fixture.userId }, body: form,
  });
  return { status: response.status, body: await response.json() as any };
}

test("repairs missing local bytes at the original path and preserves ID, filename and note references", async () => {
  const fixture = seed({ legacyMime: true, referenced: true });
  const result = await upload(fixture);
  assert.equal(result.status, 200);
  assert.equal(result.body.repaired, true);
  assert.equal(result.body.deduplicated, true);
  assert.equal(result.body.id, fixture.id);
  assert.equal(result.body.filename, "original.png");
  assert.equal(result.body.mimeType, "image/png");
  assert.equal(result.body.size, png.length);
  assert.deepEqual(fs.readFileSync(storage.getLocalAttachmentPath(fixture.originalPath)), png);
  const row = db.prepare("SELECT path, noteId, uploadSource, mimeType, size FROM attachments WHERE id = ?").get(fixture.id);
  assert.deepEqual(row, { path: fixture.originalPath, noteId: fixture.noteId, uploadSource: "file_manager", mimeType: "image/png", size: png.length });
  assert.ok(db.prepare("SELECT 1 FROM attachment_references WHERE attachmentId = ? AND noteId = ?").get(fixture.id, fixture.noteId));
  const download = await app.request(result.body.accessUrls[fixture.id], { headers: { "X-User-Id": fixture.userId } });
  assert.equal(download.status, 200);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), png);
});

test("keeps intact local objects on the normal dedup path", async () => {
  const fixture = seed();
  await storage.writeAttachmentObject(fixture.originalPath, png, "image/png");
  const originalTime = fs.statSync(storage.getLocalAttachmentPath(fixture.originalPath)).mtimeMs;
  const result = await upload(fixture);
  assert.equal(result.status, 200);
  assert.equal(result.body.id, fixture.id);
  assert.notEqual(result.body.repaired, true);
  assert.equal(fs.statSync(storage.getLocalAttachmentPath(fixture.originalPath)).mtimeMs, originalTime);
});

test("does not report success or change metadata when local repair cannot be written", async (context) => {
  const fixture = seed({ legacyMime: true });
  const originalWrite = fs.writeFileSync;
  context.mock.method(fs, "writeFileSync", (filename: fs.PathOrFileDescriptor, ...args: any[]) => {
    if (filename === storage.getLocalAttachmentPath(fixture.originalPath)) throw Object.assign(new Error("test disk full"), { code: "ENOSPC" });
    return (originalWrite as any)(filename, ...args);
  });
  const result = await upload(fixture);
  assert.equal(result.status, 500);
  assert.equal(result.body.code, "ATTACHMENT_STORAGE_NO_SPACE");
  assert.deepEqual(db.prepare("SELECT mimeType, size, uploadSource FROM attachments WHERE id = ?").get(fixture.id), {
    mimeType: "application/octet-stream", size: 0, uploadSource: null,
  });
  assert.equal(fs.existsSync(storage.getLocalAttachmentPath(fixture.originalPath)), false);
});

test("does not treat local access errors as missing files", async (context) => {
  const fixture = seed();
  const originalStat = fs.statSync;
  context.mock.method(fs, "statSync", (filename: fs.PathLike, ...args: any[]) => {
    if (filename === storage.getLocalAttachmentPath(fixture.originalPath)) throw Object.assign(new Error("EACCES: test permission denied"), { code: "EACCES" });
    return (originalStat as any)(filename, ...args);
  });
  const result = await upload(fixture);
  assert.equal(result.status, 500);
  assert.equal(fs.existsSync(storage.getLocalAttachmentPath(fixture.originalPath)), false);
  assert.equal((db.prepare("SELECT uploadSource FROM attachments WHERE id = ?").get(fixture.id) as any).uploadSource, null);
});

test("does not accept a directory as an existing attachment file", async () => {
  const fixture = seed();
  fs.mkdirSync(storage.getLocalAttachmentPath(fixture.originalPath), { recursive: true });
  const result = await upload(fixture);
  assert.equal(result.status, 500);
  assert.equal((db.prepare("SELECT uploadSource FROM attachments WHERE id = ?").get(fixture.id) as any).uploadSource, null);
});

test("repairs S3 404 with a PUT to the original key and deduplicates the next upload without another PUT", async () => {
  useS3();
  const fixture = seed();
  const key = `/test-bucket/test-prefix/${fixture.originalPath}`;
  const first = await upload(fixture);
  assert.equal(first.status, 200);
  assert.equal(first.body.id, fixture.id);
  assert.equal(first.body.repaired, true);
  assert.deepEqual(objects.get(key), png);
  assert.deepEqual(requests.map((request) => request.method), ["HEAD", "PUT"]);
  const second = await upload(fixture);
  assert.equal(second.status, 200);
  assert.notEqual(second.body.repaired, true);
  assert.deepEqual(requests.map((request) => request.method), ["HEAD", "PUT", "HEAD"]);
  const download = await app.request(first.body.accessUrls[fixture.id], { headers: { "X-User-Id": fixture.userId } });
  assert.equal(download.status, 200);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), png);
});

test("does not treat S3 403 or 503 as a missing object or overwrite it", async () => {
  useS3();
  for (const status of [403, 503]) {
    headStatus = status;
    const fixture = seed();
    const result = await upload(fixture);
    assert.equal(result.status, 500);
    assert.equal(result.body.repaired, undefined);
    assert.equal(requests.some((request) => request.method === "PUT"), false);
    assert.equal((db.prepare("SELECT uploadSource FROM attachments WHERE id = ?").get(fixture.id) as any).uploadSource, null);
  }
});

test("returns failure when S3 cannot write a missing object", async () => {
  useS3();
  putStatus = 403;
  const fixture = seed({ legacyMime: true });
  const result = await upload(fixture);
  assert.equal(result.status, 500);
  assert.equal(result.body.code, "ATTACHMENT_STORAGE_CONFIG_INVALID");
  assert.equal(objects.size, 0);
  assert.equal((db.prepare("SELECT uploadSource FROM attachments WHERE id = ?").get(fixture.id) as any).uploadSource, null);
});

test("does not repair after an S3 HEAD network failure", async () => {
  useS3();
  disconnectHead = true;
  const fixture = seed();
  const result = await upload(fixture);
  assert.equal(result.status, 500);
  assert.equal(requests.some((request) => request.method === "PUT"), false);
  assert.equal((db.prepare("SELECT uploadSource FROM attachments WHERE id = ?").get(fixture.id) as any).uploadSource, null);
});

test("does not fall back to local deduplication with incomplete S3 configuration", async () => {
  const fixture = seed();
  await storage.writeAttachmentObject(fixture.originalPath, png, "image/png");
  useS3();
  delete process.env.S3_BUCKET;
  const result = await upload(fixture);
  assert.equal(result.status, 500);
  assert.equal(result.body.code, "ATTACHMENT_STORAGE_CONFIG_INVALID");
  assert.equal(requests.length, 0);
});

test("deduplication stays within the uploading user and workspace", async () => {
  const source = seed();
  const stranger = seed();
  const repaired = await upload(stranger);
  assert.equal(repaired.body.id, stranger.id);
  assert.equal(fs.existsSync(storage.getLocalAttachmentPath(source.originalPath)), false);
  const team = seed({ userId: source.userId, workspaceId: crypto.randomUUID() });
  assert.equal((await upload(team)).body.id, team.id);
  assert.equal(fs.existsSync(storage.getLocalAttachmentPath(source.originalPath)), false);
  assert.equal((await upload(source)).body.id, source.id);
});

test("new uploads still return 201 and create a separate stored object", async () => {
  const source = seed();
  const result = await upload(source, crypto.randomUUID());
  assert.equal(result.status, 403);
  db.prepare("UPDATE attachments SET hash = NULL WHERE id = ?").run(source.id);
  const created = await upload(source);
  assert.equal(created.status, 201);
  assert.notEqual(created.body.id, source.id);
  const row = db.prepare("SELECT path FROM attachments WHERE id = ?").get(created.body.id) as { path: string };
  assert.deepEqual(fs.readFileSync(storage.getLocalAttachmentPath(row.path)), png);
});

test("all/list/category and myUploads statistics use the same visible manual-upload set even without a holder note", async () => {
  const fixture = seed();
  db.prepare("UPDATE attachments SET uploadSource = 'file_manager' WHERE id = ?").run(fixture.id);
  db.pragma("foreign_keys = OFF");
  try {
    db.prepare("UPDATE attachments SET noteId = 'missing-legacy-holder' WHERE id = ?").run(fixture.id);
  } finally {
    db.pragma("foreign_keys = ON");
  }
  const headers = { "X-User-Id": fixture.userId };
  const list = await (await app.request("/api/files", { headers })).json() as any;
  const mine = await (await app.request("/api/files?filter=myUploads", { headers })).json() as any;
  const stats = await (await app.request("/api/files/stats", { headers })).json() as any;
  assert.equal(list.total, 1);
  assert.equal(mine.total, list.total);
  assert.equal(stats.total, list.total);
  assert.equal(stats.images.count, 1);
  assert.equal(stats.images.count + stats.files.count, stats.total);
  assert.deepEqual(stats.myUploads, { total: 1, referenced: 0, unreferenced: 1 });
  assert.ok(stats.myUploads.total <= stats.total);
  db.prepare("INSERT INTO attachment_references (attachmentId, noteId) VALUES (?, ?)").run(fixture.id, fixture.noteId);
  const referencedStats = await (await app.request("/api/files/stats", { headers })).json() as any;
  const referencedList = await (await app.request("/api/files?filter=myUploads&myUploadsRef=referenced", { headers })).json() as any;
  assert.deepEqual(referencedStats.myUploads, { total: 1, referenced: 1, unreferenced: 0 });
  assert.equal(referencedStats.myUploads.referenced, referencedList.total);
});

test("workspace statistics count visible manual files and exclude inaccessible note attachments", async () => {
  const fixture = seed({ workspaceId: crypto.randomUUID(), referenced: true });
  db.prepare("UPDATE attachments SET uploadSource = 'file_manager' WHERE id = ?").run(fixture.id);
  const hidden = seed({ userId: fixture.userId, workspaceId: fixture.workspaceId! });
  db.prepare("DELETE FROM knowledge_tree_nodes WHERE resourceType = 'note' AND resourceId = ?").run(hidden.noteId);
  const viewer = crypto.randomUUID();
  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, 'hash')").run(viewer, viewer);
  db.prepare("INSERT INTO workspace_members (workspaceId, userId, role) VALUES (?, ?, 'viewer')").run(fixture.workspaceId, viewer);
  const headers = { "X-User-Id": viewer };
  const stats = await (await app.request(`/api/files/stats?workspaceId=${fixture.workspaceId}`, { headers })).json() as any;
  const list = await (await app.request(`/api/files?workspaceId=${fixture.workspaceId}`, { headers })).json() as any;
  assert.equal(stats.total, 1);
  assert.equal(stats.total, list.total);
  assert.deepEqual(stats.myUploads, { total: 1, referenced: 1, unreferenced: 0 });
  const outsider = seed();
  const response = await app.request(`/api/files/stats?workspaceId=${fixture.workspaceId}`, { headers: { "X-User-Id": outsider.userId } });
  assert.equal(response.status, 403);
});
