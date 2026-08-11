import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-knowledge-restricted-"));
process.env.DB_PATH = path.join(tempDir, "knowledge-restricted.db");
let closeDatabase: (() => void) | null = null;

test.after(() => {
  closeDatabase?.();
  fs.rmSync(tempDir, { recursive: true, force: true });
  delete process.env.DB_PATH;
});

test("node member permissions become an allowlist and persist in the database", async () => {
  await import("../src/runtime/knowledge-tree-migration-bootstrap.js");
  const { Hono } = await import("hono");
  const { getDb, closeDb } = await import("../src/db/schema.js");
  const { resolveNotePermission, resolveNotebookPermission } = await import("../src/middleware/acl.js");
  const { createKnowledgeChild, listKnowledgeTree } = await import("../src/services/knowledgeTree.js");
  const {
    clearKnowledgeNodeRole,
    listKnowledgeNodeRoles,
    resolveKnowledgeNodeAccess,
    setKnowledgeNodeRole,
  } = await import("../src/services/knowledgeCapabilities.js");

  closeDatabase = closeDb;
  const db = getDb();

  for (const userId of ["owner", "admin", "allowed", "denied"]) {
    db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
      .run(userId, userId, "hash");
  }
  db.prepare("INSERT INTO workspaces (id, name, ownerId) VALUES (?, ?, ?)")
    .run("ws", "Team", "owner");
  db.prepare("INSERT INTO workspace_members (workspaceId, userId, role) VALUES (?, ?, ?)")
    .run("ws", "owner", "owner");
  db.prepare("INSERT INTO workspace_members (workspaceId, userId, role) VALUES (?, ?, ?)")
    .run("ws", "admin", "admin");
  db.prepare("INSERT INTO workspace_members (workspaceId, userId, role) VALUES (?, ?, ?)")
    .run("ws", "allowed", "viewer");
  db.prepare("INSERT INTO workspace_members (workspaceId, userId, role) VALUES (?, ?, ?)")
    .run("ws", "denied", "viewer");

  const root = createKnowledgeChild({
    actorUserId: "owner",
    workspaceId: "ws",
    parentId: null,
    nodeType: "folder",
    title: "私有项目",
    db,
  });
  const child = createKnowledgeChild({
    actorUserId: "owner",
    workspaceId: "ws",
    parentId: root.id,
    nodeType: "note",
    title: "项目密码",
    db,
  });
  const publicRoot = createKnowledgeChild({
    actorUserId: "owner",
    workspaceId: "ws",
    parentId: null,
    nodeType: "folder",
    title: "公开项目",
    db,
  });
  const publicChild = createKnowledgeChild({
    actorUserId: "owner",
    workspaceId: "ws",
    parentId: publicRoot.id,
    nodeType: "note",
    title: "公开说明",
    db,
  });

  db.prepare(`
    INSERT INTO attachments (id, noteId, userId, filename, mimeType, size, path, workspaceId)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run("restricted-attachment", child.resourceId, "owner", "secret.txt", "text/plain", 10, "secret.txt", "ws");
  db.prepare(`
    INSERT INTO attachments (id, noteId, userId, filename, mimeType, size, path, workspaceId)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run("public-attachment", publicChild.resourceId, "owner", "public.txt", "text/plain", 20, "public.txt", "ws");
  db.prepare("INSERT INTO tags (id, userId, workspaceId, name) VALUES (?, ?, ?, ?)")
    .run("restricted-tag", "owner", "ws", "机密");
  db.prepare("INSERT INTO tags (id, userId, workspaceId, name) VALUES (?, ?, ?, ?)")
    .run("public-tag", "owner", "ws", "公开");
  db.prepare("INSERT INTO note_tags (noteId, tagId) VALUES (?, ?)")
    .run(child.resourceId, "restricted-tag");
  db.prepare("INSERT INTO note_tags (noteId, tagId) VALUES (?, ?)")
    .run(publicChild.resourceId, "public-tag");

  assert.equal(resolveKnowledgeNodeAccess(child.id, "denied", db).source, "legacy");
  assert.equal(resolveKnowledgeNodeAccess(child.id, "denied", db).capabilities.canView, true);
  assert.equal(resolveNotebookPermission(root.resourceId, "denied").permission, "read");
  assert.equal(resolveNotePermission(child.resourceId, "denied").permission, "read");

  setKnowledgeNodeRole({
    nodeId: root.id,
    targetUserId: "allowed",
    rolePreset: "readonly",
    actorUserId: "owner",
    db,
  });

  const policy = db.prepare(`
    SELECT accessMode
    FROM knowledge_tree_access_policies
    WHERE nodeId = ?
  `).get(root.id) as { accessMode: string } | undefined;
  assert.equal(policy?.accessMode, "restricted");
  assert.equal(listKnowledgeNodeRoles(root.id, db).accessMode, "restricted");

  const allowedAccess = resolveKnowledgeNodeAccess(child.id, "allowed", db);
  assert.equal(allowedAccess.source, "inherited");
  assert.equal(allowedAccess.capabilities.canView, true);
  assert.equal(resolveNotebookPermission(root.resourceId, "allowed").permission, "read");
  assert.equal(resolveNotePermission(child.resourceId, "allowed").permission, "read");

  const deniedAccess = resolveKnowledgeNodeAccess(child.id, "denied", db);
  assert.equal(deniedAccess.source, "none");
  assert.equal(deniedAccess.capabilities.canView, false);
  assert.equal(resolveNotebookPermission(root.resourceId, "denied").permission, null);
  assert.equal(resolveNotePermission(child.resourceId, "denied").permission, null);

  const deniedTree = listKnowledgeTree({ userId: "denied", workspaceId: "ws", db });
  assert.equal(deniedTree.some((node) => node.id === root.id), false);
  assert.equal(deniedTree.some((node) => node.id === child.id), false);
  assert.equal(deniedTree.some((node) => node.id === publicRoot.id), true);
  assert.equal(deniedTree.some((node) => node.id === publicChild.id), true);

  const allowedTree = listKnowledgeTree({ userId: "allowed", workspaceId: "ws", db });
  assert.equal(allowedTree.some((node) => node.id === root.id), true);
  assert.equal(allowedTree.some((node) => node.id === child.id), true);

  const adminTree = listKnowledgeTree({ userId: "admin", workspaceId: "ws", db });
  assert.equal(adminTree.some((node) => node.id === root.id), true);
  assert.equal(adminTree.some((node) => node.id === child.id), true);

  const { wrapKnowledgeRoute } = await import("../src/runtime/knowledge-tree.js");
  const { getKnowledgeNodeAccessPolicy, setKnowledgeNodeAccessMode } = await import("../src/services/knowledgeAccessPolicy.js");
  const noteRoutes = new Hono();
  noteRoutes.get("/", (c) => c.json([
    { id: child.resourceId, title: "项目密码" },
    { id: publicChild.resourceId, title: "公开说明" },
  ]));
  noteRoutes.get("/:id", (c) => c.json({ id: c.req.param("id") }));

  const notebookRoutes = new Hono();
  notebookRoutes.get("/", (c) => c.json([
    { id: root.resourceId, name: "私有项目" },
    { id: publicRoot.resourceId, name: "公开项目" },
  ]));

  const searchRoutes = new Hono();
  searchRoutes.get("/", (c) => {
    c.header("X-Search-Candidate-Count", "2");
    return c.json([
      { id: child.resourceId, title: "项目密码", snippet: "restricted" },
      { id: publicChild.resourceId, title: "公开说明", snippet: "public" },
    ]);
  });

  const offlineRoutes = new Hono();
  offlineRoutes.get("/plan", (c) => c.json({
    workspaceId: "ws",
    noteCount: 2,
    attachmentCount: 2,
    attachmentBytes: 30,
    attachmentForbiddenNotes: 0,
    accessFingerprint: "legacy",
    notebooks: [
      { id: root.resourceId, parentId: null },
      { id: publicRoot.resourceId, parentId: null },
    ],
    tags: [
      { id: "restricted-tag", name: "机密" },
      { id: "public-tag", name: "公开" },
    ],
  }));
  offlineRoutes.get("/snapshot", (c) => c.json({
    items: [
      {
        note: { id: child.resourceId, notebookId: root.resourceId },
        attachments: [{ id: "restricted-attachment", noteId: child.resourceId, size: 10 }],
        attachmentDownloadAllowed: true,
        attachmentBytes: 10,
      },
      {
        note: { id: publicChild.resourceId, notebookId: publicRoot.resourceId },
        attachments: [{ id: "public-attachment", noteId: publicChild.resourceId, size: 20 }],
        attachmentDownloadAllowed: true,
        attachmentBytes: 20,
      },
    ],
    hasMore: false,
  }));

  const fileRoutes = new Hono();
  fileRoutes.get("/", (c) => c.json({
    items: [
      { id: "restricted-attachment", primaryNote: { id: child.resourceId }, url: "/api/attachments/restricted-attachment" },
      { id: "public-attachment", primaryNote: { id: publicChild.resourceId }, url: "/api/attachments/public-attachment" },
    ],
    accessUrls: {
      "restricted-attachment": "/api/attachments/restricted-attachment?sig=x",
      "public-attachment": "/api/attachments/public-attachment?sig=x",
    },
    total: 2,
    page: 1,
    pageSize: 50,
  }));

  const exportRoutes = new Hono();
  exportRoutes.get("/notes", (c) => c.json([]));
  exportRoutes.post("/markdown-package/jobs", (c) => c.json({ shouldNotReach: true }, 500));

  const tagRoutes = new Hono();
  tagRoutes.get("/", (c) => c.json([
    { id: "restricted-tag", userId: "owner", noteCount: 1 },
    { id: "public-tag", userId: "owner", noteCount: 1 },
  ]));
  tagRoutes.post("/note/:noteId/tag/:tagId", (c) => c.json({ success: true }));

  const api = new Hono();
  api.route("/api/notes", wrapKnowledgeRoute("/api/notes", noteRoutes));
  api.route("/api/notebooks", wrapKnowledgeRoute("/api/notebooks", notebookRoutes));
  api.route("/api/search", wrapKnowledgeRoute("/api/search", searchRoutes));
  api.route("/api/offline-sync", wrapKnowledgeRoute("/api/offline-sync", offlineRoutes));
  api.route("/api/files", wrapKnowledgeRoute("/api/files", fileRoutes));
  api.route("/api/export", wrapKnowledgeRoute("/api/export", exportRoutes));
  api.route("/api/tags", wrapKnowledgeRoute("/api/tags", tagRoutes));

  const deniedHeaders = { "X-User-Id": "denied" };
  const deniedNotesResponse = await api.request("http://localhost/api/notes?workspaceId=ws", { headers: deniedHeaders });
  assert.equal(deniedNotesResponse.status, 200);
  assert.deepEqual(await deniedNotesResponse.json(), [
    { id: publicChild.resourceId, title: "公开说明" },
  ]);

  const allowedNotesResponse = await api.request("http://localhost/api/notes?workspaceId=ws", {
    headers: { "X-User-Id": "allowed" },
  });
  assert.equal(allowedNotesResponse.status, 200);
  assert.deepEqual(await allowedNotesResponse.json(), [
    { id: child.resourceId, title: "项目密码" },
    { id: publicChild.resourceId, title: "公开说明" },
  ]);

  const deniedNotebooksResponse = await api.request("http://localhost/api/notebooks?workspaceId=ws", { headers: deniedHeaders });
  assert.equal(deniedNotebooksResponse.status, 200);
  assert.deepEqual(await deniedNotebooksResponse.json(), [
    { id: publicRoot.resourceId, name: "公开项目" },
  ]);

  const deniedPlanResponse = await api.request("http://localhost/api/offline-sync/plan?workspaceId=ws", { headers: deniedHeaders });
  assert.equal(deniedPlanResponse.status, 200);
  const deniedPlan = await deniedPlanResponse.json() as any;
  assert.equal(deniedPlan.noteCount, 1);
  assert.equal(deniedPlan.attachmentCount, 1);
  assert.equal(deniedPlan.attachmentBytes, 20);
  assert.deepEqual(deniedPlan.notebooks.map((row: any) => row.id), [publicRoot.resourceId]);
  assert.deepEqual(deniedPlan.tags.map((row: any) => row.id), ["public-tag"]);
  assert.notEqual(deniedPlan.accessFingerprint, "legacy");

  const deniedSnapshotResponse = await api.request("http://localhost/api/offline-sync/snapshot?workspaceId=ws", { headers: deniedHeaders });
  assert.equal(deniedSnapshotResponse.status, 200);
  const deniedSnapshot = await deniedSnapshotResponse.json() as any;
  assert.deepEqual(deniedSnapshot.items.map((item: any) => item.note.id), [publicChild.resourceId]);

  const deniedFilesResponse = await api.request("http://localhost/api/files?workspaceId=ws", { headers: deniedHeaders });
  assert.equal(deniedFilesResponse.status, 200);
  const deniedFiles = await deniedFilesResponse.json() as any;
  assert.deepEqual(deniedFiles.items.map((item: any) => item.id), ["public-attachment"]);
  assert.deepEqual(Object.keys(deniedFiles.accessUrls), ["public-attachment"]);
  assert.equal(deniedFiles.total, 1);

  const deniedExportResponse = await api.request("http://localhost/api/export/notes?workspaceId=ws", { headers: deniedHeaders });
  assert.equal(deniedExportResponse.status, 200);
  assert.deepEqual((await deniedExportResponse.json() as any[]).map((note) => note.id), [publicChild.resourceId]);

  const deniedExportJobResponse = await api.request("http://localhost/api/export/markdown-package/jobs?workspaceId=ws", {
    method: "POST",
    headers: { ...deniedHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ notes: [{ id: child.resourceId }] }),
  });
  assert.equal(deniedExportJobResponse.status, 404);

  const deniedTagsResponse = await api.request("http://localhost/api/tags?workspaceId=ws", { headers: deniedHeaders });
  assert.equal(deniedTagsResponse.status, 200);
  assert.deepEqual((await deniedTagsResponse.json() as any[]).map((tag) => tag.id), ["public-tag"]);

  const deniedTagMutation = await api.request(
    `http://localhost/api/tags/note/${child.resourceId}/tag/restricted-tag`,
    { method: "POST", headers: deniedHeaders },
  );
  assert.equal(deniedTagMutation.status, 404);

  const deniedDirectResponse = await api.request(
    `http://localhost/api/notes/${child.resourceId}`,
    { headers: deniedHeaders },
  );
  assert.equal(deniedDirectResponse.status, 404);
  assert.deepEqual(await deniedDirectResponse.json(), {
    error: "资源不存在",
    code: "NOT_FOUND",
  });

  const deniedHeadResponse = await api.request(
    `http://localhost/api/notes/${child.resourceId}`,
    { method: "HEAD", headers: deniedHeaders },
  );
  assert.equal(deniedHeadResponse.status, 404);

  const adminDirectResponse = await api.request(
    `http://localhost/api/notes/${child.resourceId}`,
    { headers: { "X-User-Id": "admin" } },
  );
  assert.equal(adminDirectResponse.status, 200);

  const { handleDownloadAttachment } = await import("../src/routes/attachments.js");
  const attachmentApi = new Hono();
  attachmentApi.get("/api/attachments/:id", handleDownloadAttachment);
  const unsignedAttachmentResponse = await attachmentApi.request(
    "http://localhost/api/attachments/public-attachment",
  );
  assert.equal(unsignedAttachmentResponse.status, 404);

  assert.equal(clearKnowledgeNodeRole({
    nodeId: root.id,
    targetUserId: "allowed",
    actorUserId: "owner",
    db,
  }), true);
  assert.equal(listKnowledgeNodeRoles(root.id, db).accessMode, "inherit");
  assert.equal(resolveKnowledgeNodeAccess(child.id, "denied", db).source, "legacy");
  assert.equal(resolveKnowledgeNodeAccess(child.id, "denied", db).capabilities.canView, true);
  assert.equal(resolveNotebookPermission(root.resourceId, "denied").permission, "read");
  assert.equal(resolveNotePermission(child.resourceId, "denied").permission, "read");

  setKnowledgeNodeRole({
    nodeId: root.id,
    targetUserId: "allowed",
    rolePreset: "readonly",
    actorUserId: "owner",
    db,
  });
  setKnowledgeNodeAccessMode({
    nodeId: root.id,
    accessMode: "inherit",
    actorUserId: "owner",
    db,
  });
  assert.equal(getKnowledgeNodeAccessPolicy(root.id, db).accessMode, "inherit");
  assert.equal(resolveKnowledgeNodeAccess(child.id, "denied", db).capabilities.canView, true);

  closeDb();
  const reopenedDb = getDb();
  assert.equal(getKnowledgeNodeAccessPolicy(root.id, reopenedDb).accessMode, "inherit");
  assert.equal(
    (reopenedDb.prepare("SELECT COUNT(*) AS count FROM knowledge_tree_acl WHERE nodeId = ?")
      .get(root.id) as { count: number }).count,
    1,
  );
  assert.equal(resolveKnowledgeNodeAccess(child.id, "denied", reopenedDb).capabilities.canView, true);
});
