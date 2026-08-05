import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-knowledge-query-limits-"));
process.env.DB_PATH = path.join(tempDir, "knowledge-query-limits.db");
let closeDatabase: (() => void) | null = null;

test.after(() => {
  closeDatabase?.();
  fs.rmSync(tempDir, { recursive: true, force: true });
  delete process.env.DB_PATH;
});

test("knowledge access filtering runs before file pagination and search result limits", async () => {
  await import("../src/runtime/knowledge-tree-migration-bootstrap.js");
  const { Hono } = await import("hono");
  const { getDb, closeDb } = await import("../src/db/schema.js");
  const { createKnowledgeChild } = await import("../src/services/knowledgeTree.js");
  const { setKnowledgeNodeRole } = await import("../src/services/knowledgeCapabilities.js");
  const searchRouter = (await import("../src/routes/search.js")).default;
  const { wrapKnowledgeRoute } = await import("../src/runtime/knowledge-tree.js");

  closeDatabase = closeDb;
  const db = getDb();
  const ownerId = "query-owner";
  const viewerId = "query-viewer";
  const allowedId = "query-allowed";
  const workspaceId = "query-workspace";

  for (const userId of [ownerId, viewerId, allowedId]) {
    db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
      .run(userId, userId, "hash");
  }
  db.prepare("INSERT INTO workspaces (id, name, ownerId) VALUES (?, ?, ?)")
    .run(workspaceId, "Query limits", ownerId);
  for (const [userId, role] of [
    [ownerId, "owner"],
    [viewerId, "viewer"],
    [allowedId, "viewer"],
  ]) {
    db.prepare("INSERT INTO workspace_members (workspaceId, userId, role) VALUES (?, ?, ?)")
      .run(workspaceId, userId, role);
  }

  const restrictedRoot = createKnowledgeChild({
    actorUserId: ownerId,
    workspaceId,
    parentId: null,
    nodeType: "folder",
    title: "Restricted search root",
    db,
  });
  setKnowledgeNodeRole({
    nodeId: restrictedRoot.id,
    targetUserId: allowedId,
    rolePreset: "readonly",
    actorUserId: ownerId,
    db,
  });

  const visibleNote = createKnowledgeChild({
    actorUserId: ownerId,
    workspaceId,
    parentId: restrictedRoot.id,
    nodeType: "note",
    title: "Visible result",
    db,
  });
  setKnowledgeNodeRole({
    nodeId: visibleNote.id,
    targetUserId: viewerId,
    rolePreset: "readonly",
    actorUserId: ownerId,
    db,
  });
  db.prepare("UPDATE notes SET contentText = ?, updatedAt = ? WHERE id = ?")
    .run("limitneedle", "2020-01-01 00:00:00", visibleNote.resourceId);

  const hiddenNotes: Array<{ id: string; resourceId: string }> = [];
  for (let index = 0; index < 1001; index += 1) {
    const note = createKnowledgeChild({
      actorUserId: ownerId,
      workspaceId,
      parentId: restrictedRoot.id,
      nodeType: "note",
      title: "limitneedle limitneedle limitneedle",
      db,
    });
    db.prepare("UPDATE notes SET contentText = ?, updatedAt = ? WHERE id = ?")
      .run(
        `${"limitneedle ".repeat(12)}hidden ${index}`,
        `2026-08-04 12:${String(index % 60).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}`,
        note.resourceId,
      );
    hiddenNotes.push(note);
  }

  for (let index = 0; index < 15; index += 1) {
    db.prepare(`
      INSERT INTO attachments (
        id, noteId, userId, filename, mimeType, size, path, workspaceId, createdAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `hidden-file-${index}`,
      hiddenNotes[index].resourceId,
      ownerId,
      `hidden-${index}.txt`,
      "text/plain",
      10,
      `hidden/${index}.txt`,
      workspaceId,
      `2026-08-04 13:${String(index).padStart(2, "0")}:00`,
    );
  }
  for (let index = 0; index < 12; index += 1) {
    db.prepare(`
      INSERT INTO attachments (
        id, noteId, userId, filename, mimeType, size, path, workspaceId, createdAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `visible-file-${index}`,
      visibleNote.resourceId,
      ownerId,
      `visible-${index}.txt`,
      "text/plain",
      10,
      `visible/${index}.txt`,
      workspaceId,
      `2020-01-01 00:${String(index).padStart(2, "0")}:00`,
    );
  }

  const app = new Hono();
  app.route("/api/search", wrapKnowledgeRoute("/api/search", searchRouter));

  // Model the legacy file route: it paginates the workspace-wide attachment set
  // before the knowledge-tree middleware gets a chance to filter hidden notes.
  const fileRoutes = new Hono();
  fileRoutes.get("/", (c) => {
    const page = Math.max(1, Number(c.req.query("page") || 1));
    const pageSize = Math.max(1, Number(c.req.query("pageSize") || 10));
    const rows = db.prepare(`
      SELECT a.id, a.noteId
      FROM attachments a
      WHERE a.workspaceId = ?
      ORDER BY a.createdAt DESC
      LIMIT ? OFFSET ?
    `).all(workspaceId, pageSize, (page - 1) * pageSize) as Array<{ id: string; noteId: string }>;
    return c.json({
      items: rows.map((row) => ({
        id: row.id,
        primaryNote: { id: row.noteId },
        url: `/api/attachments/${row.id}`,
      })),
      accessUrls: Object.fromEntries(rows.map((row) => [row.id, `/api/attachments/${row.id}?sig=test`])),
      total: 27,
      page,
      pageSize,
    });
  });
  app.route("/api/files", wrapKnowledgeRoute("/api/files", fileRoutes));

  const headers = { "X-User-Id": viewerId };
  const searchResponse = await app.request(
    `http://localhost/api/search?q=limitneedle&workspaceId=${workspaceId}`,
    { headers },
  );
  assert.equal(searchResponse.status, 200);
  assert.equal(searchResponse.headers.get("X-Search-Candidate-Count"), "1");
  assert.deepEqual(
    (await searchResponse.json() as Array<{ id: string }>).map((row) => row.id),
    [visibleNote.resourceId],
  );

  const firstPageResponse = await app.request(
    `http://localhost/api/files?workspaceId=${workspaceId}&page=1&pageSize=10&sort=created_desc`,
    { headers },
  );
  assert.equal(firstPageResponse.status, 200);
  const firstPage = await firstPageResponse.json() as any;
  assert.equal(firstPage.total, 12);
  assert.equal(firstPage.items.length, 10);
  assert.equal(firstPage.items.every((row: any) => row.id.startsWith("visible-file-")), true);
  assert.equal(Object.keys(firstPage.accessUrls).length, 10);

  const secondPageResponse = await app.request(
    `http://localhost/api/files?workspaceId=${workspaceId}&page=2&pageSize=10&sort=created_desc`,
    { headers },
  );
  assert.equal(secondPageResponse.status, 200);
  const secondPage = await secondPageResponse.json() as any;
  assert.equal(secondPage.total, 12);
  assert.equal(secondPage.items.length, 2);
  assert.equal(secondPage.items.every((row: any) => row.id.startsWith("visible-file-")), true);
  assert.equal(Object.keys(secondPage.accessUrls).length, 2);
});
