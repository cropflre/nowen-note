import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-file-manager-manual-upload-"));
process.env.DB_PATH = path.join(tempDir, "manual-upload.db");
let closeDatabase: (() => void) | null = null;

test.after(() => {
  closeDatabase?.();
  fs.rmSync(tempDir, { recursive: true, force: true });
  delete process.env.DB_PATH;
});

test("manual file-manager uploads stay visible when the hidden holder note projection is missing", async () => {
  await import("../src/runtime/knowledge-tree-migration-bootstrap.js");
  const { Hono } = await import("hono");
  const { getDb, closeDb } = await import("../src/db/schema.js");
  const { wrapKnowledgeRoute } = await import("../src/runtime/knowledge-tree.js");
  const {
    verifyAttachmentSignature,
  } = await import("../src/lib/attachment-signed-url.js");

  closeDatabase = closeDb;
  const db = getDb();
  const userId = "manual-upload-owner";
  const notebookId = "manual-upload-holder-notebook";
  const noteId = "manual-upload-holder-note";

  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
    .run(userId, userId, "hash");
  db.prepare(
    `INSERT INTO notebooks (
      id, userId, parentId, name, description, icon, sortOrder, isExpanded, workspaceId
    ) VALUES (?, ?, NULL, ?, '', '📁', 9999, 0, NULL)`,
  ).run(notebookId, userId, "文件管理（自动）");
  db.prepare(
    `INSERT INTO notes (
      id, userId, notebookId, title, content, contentText, isArchived, workspaceId
    ) VALUES (?, ?, ?, ?, '{}', '', 1, NULL)`,
  ).run(noteId, userId, notebookId, "未归档文件");

  // Simulate an upgraded/legacy database where the hidden holder note exists but its
  // knowledge-tree projection is absent. The attachment rows and physical files are valid.
  db.prepare(
    "DELETE FROM knowledge_tree_nodes WHERE resourceType = 'note' AND resourceId = ?",
  ).run(noteId);

  for (let index = 0; index < 8; index += 1) {
    db.prepare(
      `INSERT INTO attachments (
        id, noteId, userId, filename, mimeType, size, path, workspaceId,
        hash, uploadSource, createdAt
      ) VALUES (?, ?, ?, ?, 'image/png', ?, ?, NULL, ?, 'file_manager', ?)`,
    ).run(
      `manual-upload-${index}`,
      noteId,
      userId,
      `original-${index}.png`,
      128 + index,
      `2026/09/manual-upload-${index}.png`,
      `hash-${index}`,
      `2026-09-24 00:0${index}:00`,
    );
  }

  const fileRoutes = new Hono();
  fileRoutes.get("/", (c) => c.json({ items: [], accessUrls: {}, total: 0, page: 1, pageSize: 50 }));
  fileRoutes.get("/stats", (c) => c.json({
    total: 8,
    totalBytes: 0,
    images: { count: 8, bytes: 0 },
    files: { count: 0, bytes: 0 },
    unreferenced: { count: 0, bytes: 0 },
    myUploads: { total: 8, referenced: 0, unreferenced: 8 },
    byMime: [],
  }));

  const app = new Hono();
  app.route("/api/files", wrapKnowledgeRoute("/api/files", fileRoutes));

  const response = await app.request(
    "http://localhost/api/files?filter=myUploads&myUploadsRef=unreferenced&page=1&pageSize=50",
    { headers: { "X-User-Id": userId } },
  );
  assert.equal(response.status, 200);
  const payload = await response.json() as any;

  assert.equal(payload.total, 8);
  assert.equal(payload.items.length, 8);
  assert.deepEqual(
    payload.items.map((item: any) => item.filename).sort(),
    Array.from({ length: 8 }, (_, index) => `original-${index}.png`).sort(),
  );
  assert.equal(payload.items.every((item: any) => item.downloadAllowed === true), true);
  assert.equal(Object.keys(payload.accessUrls).length, 8);

  for (const item of payload.items) {
    const signed = new URL(payload.accessUrls[item.id], "http://localhost");
    const verification = verifyAttachmentSignature(
      item.id,
      signed.searchParams.get("exp") || "",
      signed.searchParams.get("sig") || "",
      signed.searchParams.get("scope") || "",
    );
    assert.equal(verification.valid, true);
    assert.equal(verification.accessKind, "file");
    assert.equal(verification.allowDownload, true);
  }

  const statsResponse = await app.request(
    "http://localhost/api/files/stats",
    { headers: { "X-User-Id": userId } },
  );
  assert.equal(statsResponse.status, 200);
  const stats = await statsResponse.json() as any;
  assert.equal(stats.total, 8);
  assert.equal(stats.images.count, 8);
  assert.equal(stats.myUploads.total, 8);
  assert.equal(stats.myUploads.unreferenced, 8);
});

test("manual workspace uploads are visible only to current workspace members", async () => {
  const { Hono } = await import("hono");
  const { getDb } = await import("../src/db/schema.js");
  const { wrapKnowledgeRoute } = await import("../src/runtime/knowledge-tree.js");

  const db = getDb();
  const ownerId = "manual-workspace-owner";
  const viewerId = "manual-workspace-viewer";
  const outsiderId = "manual-workspace-outsider";
  const workspaceId = "manual-upload-workspace";
  const notebookId = "manual-workspace-holder-notebook";
  const noteId = "manual-workspace-holder-note";

  for (const userId of [ownerId, viewerId, outsiderId]) {
    db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
      .run(userId, userId, "hash");
  }
  db.prepare("INSERT INTO workspaces (id, name, ownerId) VALUES (?, ?, ?)")
    .run(workspaceId, "Manual upload workspace", ownerId);
  db.prepare("INSERT INTO workspace_members (workspaceId, userId, role) VALUES (?, ?, ?)")
    .run(workspaceId, ownerId, "owner");
  db.prepare("INSERT INTO workspace_members (workspaceId, userId, role) VALUES (?, ?, ?)")
    .run(workspaceId, viewerId, "viewer");

  db.prepare(
    `INSERT INTO notebooks (
      id, userId, parentId, name, description, icon, sortOrder, isExpanded, workspaceId
    ) VALUES (?, ?, NULL, ?, '', '📁', 9999, 0, ?)`,
  ).run(notebookId, ownerId, "文件管理（自动）", workspaceId);
  db.prepare(
    `INSERT INTO notes (
      id, userId, notebookId, title, content, contentText, isArchived, workspaceId
    ) VALUES (?, ?, ?, ?, '{}', '', 1, ?)`,
  ).run(noteId, ownerId, notebookId, "未归档文件", workspaceId);
  db.prepare(
    "DELETE FROM knowledge_tree_nodes WHERE resourceType = 'note' AND resourceId = ?",
  ).run(noteId);

  db.prepare(
    `INSERT INTO attachments (
      id, noteId, userId, filename, mimeType, size, path, workspaceId, hash, uploadSource
    ) VALUES (?, ?, ?, ?, 'image/png', 256, ?, ?, ?, 'file_manager')`,
  ).run(
    "manual-workspace-file",
    noteId,
    ownerId,
    "workspace-original.png",
    "2026/09/manual-workspace-file.png",
    workspaceId,
    "workspace-hash",
  );

  const fileRoutes = new Hono();
  fileRoutes.get("/", (c) => c.json({ items: [], accessUrls: {}, total: 0, page: 1, pageSize: 50 }));
  const app = new Hono();
  app.route("/api/files", wrapKnowledgeRoute("/api/files", fileRoutes));

  const viewerResponse = await app.request(
    `http://localhost/api/files?workspaceId=${workspaceId}&filter=myUploads`,
    { headers: { "X-User-Id": viewerId } },
  );
  assert.equal(viewerResponse.status, 200);
  const viewerPayload = await viewerResponse.json() as any;
  assert.equal(viewerPayload.total, 1);
  assert.equal(viewerPayload.items[0]?.filename, "workspace-original.png");
  assert.equal(Object.keys(viewerPayload.accessUrls).length, 1);

  const outsiderResponse = await app.request(
    `http://localhost/api/files?workspaceId=${workspaceId}&filter=myUploads`,
    { headers: { "X-User-Id": outsiderId } },
  );
  assert.equal(outsiderResponse.status, 200);
  const outsiderPayload = await outsiderResponse.json() as any;
  assert.equal(outsiderPayload.total, 0);
  assert.equal(outsiderPayload.items.length, 0);
  assert.deepEqual(outsiderPayload.accessUrls, {});
});
