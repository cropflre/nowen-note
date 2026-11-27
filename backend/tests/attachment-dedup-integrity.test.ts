import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type Database from "better-sqlite3";
import { Hono } from "hono";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-dedup-integrity-"));
process.env.DB_PATH = path.join(directory, "test.db");
process.env.ELECTRON_USER_DATA = directory;
process.env.ATTACHMENT_SIGNING_SECRET = "dedup-integrity-test-signing-secret";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jrwoAAAAASUVORK5CYII=",
  "base64",
);
const pngHash = crypto.createHash("sha256").update(png).digest("hex");

let db: Database.Database;
let closeDb: () => void;
let app: Hono;
let storage: typeof import("../src/services/attachment-storage.js");
let createDeduplicatedAttachmentRow: typeof import("../src/routes/attachments-core.js").createDeduplicatedAttachmentRow;
let extractInlineBase64Images: typeof import("../src/routes/attachments-core.js").extractInlineBase64Images;
let server: http.Server;
let endpoint: string;
const s3Objects = new Map<string, Buffer>();

test.before(async () => {
  delete process.env.ATTACHMENT_STORAGE;
  await import("../src/runtime/knowledge-tree-migration-bootstrap.js");
  const schema = await import("../src/db/schema.js");
  db = schema.getDb();
  closeDb = schema.closeDb;
  storage = await import("../src/services/attachment-storage.js");
  const core = await import("../src/routes/attachments-core.js");
  createDeduplicatedAttachmentRow = core.createDeduplicatedAttachmentRow;
  extractInlineBase64Images = core.extractInlineBase64Images;
  const { default: files } = await import("../src/routes/files.js");
  const { wrapKnowledgeRoute } = await import("../src/runtime/knowledge-tree.js");

  app = new Hono();
  app.get("/api/attachments/:id", core.handleDownloadAttachment);
  app.route("/api/attachments", core.default);
  app.route("/api/files", wrapKnowledgeRoute("/api/files", files));

  server = http.createServer(async (request, response) => {
    const key = new URL(request.url || "/", "http://localhost").pathname;
    const method = request.method || "GET";
    if (method === "HEAD") {
      response.writeHead(s3Objects.has(key) ? 200 : 404);
      response.end();
    } else if (method === "PUT") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      s3Objects.set(key, Buffer.concat(chunks));
      response.writeHead(200);
      response.end();
    } else {
      const content = s3Objects.get(key);
      response.writeHead(content ? 200 : 404);
      response.end(content);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

test.beforeEach(() => {
  delete process.env.ATTACHMENT_STORAGE;
  s3Objects.clear();
});

test.after(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  closeDb?.();
  fs.rmSync(directory, { recursive: true, force: true });
});

function useS3() {
  Object.assign(process.env, {
    ATTACHMENT_STORAGE: "s3",
    S3_ENDPOINT: endpoint,
    S3_REGION: "test-region",
    S3_BUCKET: "test-bucket",
    S3_ACCESS_KEY_ID: "test-key",
    S3_SECRET_ACCESS_KEY: "test-secret",
    S3_PREFIX: "test-prefix",
  });
}

function seedNote(options: { workspaceId?: string } = {}) {
  const userId = crypto.randomUUID();
  const workspaceId = options.workspaceId || null;
  const notebookId = crypto.randomUUID();
  const noteId = crypto.randomUUID();
  db.prepare("INSERT OR IGNORE INTO users (id, username, passwordHash) VALUES (?, ?, 'hash')").run(userId, userId);
  if (workspaceId) {
    db.prepare("INSERT OR IGNORE INTO workspaces (id, name, ownerId) VALUES (?, 'Team', ?)").run(workspaceId, userId);
    db.prepare("INSERT OR IGNORE INTO workspace_members (workspaceId, userId, role) VALUES (?, ?, 'owner')").run(workspaceId, userId);
  }
  db.prepare("INSERT INTO notebooks (id, userId, name, workspaceId) VALUES (?, ?, 'NB', ?)").run(notebookId, userId, workspaceId);
  db.prepare("INSERT INTO notes (id, userId, notebookId, title, content, workspaceId) VALUES (?, ?, ?, 'Note', '{}', ?)")
    .run(noteId, userId, notebookId, workspaceId);
  return { userId, workspaceId, notebookId, noteId };
}

function insertBrokenAttachmentRow(
  fixture: ReturnType<typeof seedNote>,
  brokenPath: string,
  id = crypto.randomUUID(),
) {
  db.prepare(`
    INSERT INTO attachments (id, noteId, userId, filename, mimeType, size, path, workspaceId, hash)
    VALUES (?, ?, ?, 'broken.png', 'image/png', ?, ?, ?, ?)
  `).run(id, fixture.noteId, fixture.userId, png.length, brokenPath, fixture.workspaceId, pngHash);
  return id;
}

async function uploadNoteAttachment(fixture: ReturnType<typeof seedNote>, filename = "photo.png") {
  const form = new FormData();
  form.set("file", new File([new Uint8Array(png)], filename, { type: "image/png" }));
  form.set("noteId", fixture.noteId);
  const response = await app.request("/api/attachments", {
    method: "POST",
    headers: { "X-User-Id": fixture.userId },
    body: form,
  });
  return { status: response.status, body: await response.json() as any };
}

test("issue #932: POST /api/attachments falls back to normal write when existing hash row has empty path", async () => {
  const fixture = seedNote();
  const brokenId = insertBrokenAttachmentRow(fixture, "");

  // First upload must ignore the empty-path row, write the file to disk, and be downloadable.
  const first = await uploadNoteAttachment(fixture, "reupload-1.png");
  assert.equal(first.status, 201);
  assert.notEqual(first.body.deduplicated, true);

  const firstRow = db.prepare("SELECT path FROM attachments WHERE id = ?").get(first.body.id) as { path: string };
  assert.ok(firstRow.path.trim().length > 0);
  assert.deepEqual(fs.readFileSync(storage.getLocalAttachmentPath(firstRow.path)), png);

  const download1 = await app.request(first.body.accessUrls[first.body.id], {
    headers: { "X-User-Id": fixture.userId },
  });
  assert.equal(download1.status, 200);
  assert.deepEqual(Buffer.from(await download1.arrayBuffer()), png);

  // Subsequent upload deduplicates against the valid persisted row rather than the broken empty-path row.
  const second = await uploadNoteAttachment(fixture, "reupload-2.png");
  assert.equal(second.status, 201);
  assert.equal(second.body.deduplicated, true);

  const secondRow = db.prepare("SELECT path FROM attachments WHERE id = ?").get(second.body.id) as { path: string };
  assert.equal(secondRow.path, firstRow.path);
  assert.notEqual(second.body.id, brokenId);

  const download2 = await app.request(second.body.accessUrls[second.body.id], {
    headers: { "X-User-Id": fixture.userId },
  });
  assert.equal(download2.status, 200);
  assert.deepEqual(Buffer.from(await download2.arrayBuffer()), png);
});

test("POST /api/attachments falls back to normal write when existing hash row points to missing local file (workspace & personal)", async () => {
  for (const workspaceId of [undefined, crypto.randomUUID()]) {
    const fixture = seedNote({ workspaceId });
    const missingPath = `2020/01/${crypto.randomUUID()}.png`;
    insertBrokenAttachmentRow(fixture, missingPath);

    const uploaded = await uploadNoteAttachment(fixture, "recovered.png");
    assert.equal(uploaded.status, 201);
    assert.notEqual(uploaded.body.deduplicated, true);

    const row = db.prepare("SELECT path FROM attachments WHERE id = ?").get(uploaded.body.id) as { path: string };
    assert.ok(row.path.trim().length > 0);
    assert.notEqual(row.path, missingPath);
    assert.deepEqual(fs.readFileSync(storage.getLocalAttachmentPath(row.path)), png);

    const download = await app.request(uploaded.body.accessUrls[uploaded.body.id], {
      headers: { "X-User-Id": fixture.userId },
    });
    assert.equal(download.status, 200);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), png);
  }
});

test("POST /api/attachments falls back to S3 write when existing hash row is missing in S3", async () => {
  useS3();
  const fixture = seedNote();
  const missingKey = `2020/02/${crypto.randomUUID()}.png`;
  insertBrokenAttachmentRow(fixture, missingKey);

  const uploaded = await uploadNoteAttachment(fixture, "s3-recovered.png");
  assert.equal(uploaded.status, 201);
  assert.notEqual(uploaded.body.deduplicated, true);

  const row = db.prepare("SELECT path FROM attachments WHERE id = ?").get(uploaded.body.id) as { path: string };
  assert.ok(row.path.trim().length > 0);
  assert.deepEqual(s3Objects.get(`/test-bucket/test-prefix/${row.path}`), png);

  const download = await app.request(uploaded.body.accessUrls[uploaded.body.id], {
    headers: { "X-User-Id": fixture.userId },
  });
  assert.equal(download.status, 200);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), png);
});

test("extractInlineBase64Images ignores empty-path and missing-file dedup rows and writes a valid file", () => {
  const fixture = seedNote();
  insertBrokenAttachmentRow(fixture, "");
  insertBrokenAttachmentRow(fixture, `2020/03/${crypto.randomUUID()}.png`);

  const html = `<p><img src="data:image/png;base64,${png.toString("base64")}" /></p>`;
  const result = extractInlineBase64Images(html, fixture.userId, fixture.noteId, fixture.workspaceId);
  assert.equal(result.replacedCount, 1);
  assert.equal(result.attachmentIds.length, 1);

  const row = db.prepare("SELECT path FROM attachments WHERE id = ?").get(result.attachmentIds[0]) as { path: string };
  assert.ok(row.path.trim().length > 0);
  assert.deepEqual(fs.readFileSync(storage.getLocalAttachmentPath(row.path)), png);
});

test("createDeduplicatedAttachmentRow rejects empty storage paths without inserting a row", () => {
  const fixture = seedNote();
  const before = (db.prepare("SELECT COUNT(*) AS count FROM attachments WHERE noteId = ?").get(fixture.noteId) as { count: number }).count;

  assert.throws(
    () =>
      createDeduplicatedAttachmentRow({
        source: { path: "", mimeType: "image/png", size: png.length, filename: "empty.png", hash: pngHash },
        noteId: fixture.noteId,
        userId: fixture.userId,
        workspaceId: fixture.workspaceId,
      }),
    /empty storage path/i,
  );

  assert.throws(
    () =>
      createDeduplicatedAttachmentRow({
        source: { path: "   ", mimeType: "image/png", size: png.length, filename: "blank.png", hash: pngHash },
        noteId: fixture.noteId,
        userId: fixture.userId,
        workspaceId: fixture.workspaceId,
      }),
    /empty storage path/i,
  );

  const after = (db.prepare("SELECT COUNT(*) AS count FROM attachments WHERE noteId = ?").get(fixture.noteId) as { count: number }).count;
  assert.equal(after, before);
});

test("POST /api/files/upload ignores empty-path hash row and persists a readable file", async () => {
  const fixture = seedNote();
  insertBrokenAttachmentRow(fixture, "");

  const form = new FormData();
  form.set("file", new File([new Uint8Array(png)], "managed.png", { type: "image/png" }));
  const response = await app.request("/api/files/upload", {
    method: "POST",
    headers: { "X-User-Id": fixture.userId },
    body: form,
  });
  const body = await response.json() as any;
  assert.equal(response.status, 201);
  assert.notEqual(body.deduplicated, true);

  const row = db.prepare("SELECT path FROM attachments WHERE id = ?").get(body.id) as { path: string };
  assert.ok(row.path.trim().length > 0);
  assert.deepEqual(fs.readFileSync(storage.getLocalAttachmentPath(row.path)), png);
});
