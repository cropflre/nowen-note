import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Hono } from "hono";
import type Database from "better-sqlite3";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-recycle-bin-capability-"));
process.env.DB_PATH = path.join(tempDir, "recycle-bin.db");

let db: Database.Database;
let closeDb: () => void;
let app: Hono;

const ownerId = "recycle-owner";
const memberId = "recycle-member";

function requestHeaders(userId: string, json = false): Record<string, string> {
  return {
    "X-User-Id": userId,
    ...(json ? { "Content-Type": "application/json" } : {}),
  };
}

test.before(async () => {
  await import("../src/runtime/knowledge-tree-migration-bootstrap.js");
  const schema = await import("../src/db/schema.js");
  const notesRoute = await import("../src/routes/notes.js");
  const { enforceKnowledgeNoteCapabilities } = await import("../src/middleware/knowledgeCapabilityGuard.js");

  db = schema.getDb();
  closeDb = schema.closeDb;

  app = new Hono();
  app.use("/api/notes", enforceKnowledgeNoteCapabilities);
  app.use("/api/notes/*", enforceKnowledgeNoteCapabilities);
  app.route("/api/notes", notesRoute.default);

  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
    .run(ownerId, ownerId, "hash");
  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
    .run(memberId, memberId, "hash");
});

test.after(() => {
  closeDb?.();
  fs.rmSync(tempDir, { recursive: true, force: true });
  delete process.env.DB_PATH;
});

test("personal recycle-bin lifecycle keeps tombstones manageable without exposing ordinary reads", async () => {
  const { createKnowledgeChild, listKnowledgeTree } = await import("../src/services/knowledgeTree.js");

  const folder = createKnowledgeChild({
    actorUserId: ownerId,
    workspaceId: null,
    parentId: null,
    nodeType: "folder",
    title: "Recycle Folder",
    db,
  });
  const noteNode = createKnowledgeChild({
    actorUserId: ownerId,
    workspaceId: null,
    parentId: folder.id,
    nodeType: "note",
    title: "Recycle Note",
    db,
  });
  const noteId = noteNode.resourceId;

  const trash = await app.request(`/api/notes/${noteId}`, {
    method: "PUT",
    headers: requestHeaders(ownerId, true),
    body: JSON.stringify({ isTrashed: 1 }),
  });
  assert.equal(trash.status, 200);

  const storedTrash = db.prepare("SELECT isTrashed FROM notes WHERE id = ?").get(noteId) as { isTrashed: number };
  const treeTrash = db.prepare("SELECT isDeleted FROM knowledge_tree_nodes WHERE resourceType = 'note' AND resourceId = ?")
    .get(noteId) as { isDeleted: number };
  assert.equal(storedTrash.isTrashed, 1);
  assert.equal(treeTrash.isDeleted, 1);

  const activeTree = listKnowledgeTree({ userId: ownerId, workspaceId: null, db });
  assert.equal(activeTree.some((node) => node.resourceId === noteId), false);
  const deletedTree = listKnowledgeTree({ userId: ownerId, workspaceId: null, includeDeleted: true, db });
  assert.equal(deletedTree.some((node) => node.resourceId === noteId && node.isDeleted === 1), true);

  const trashList = await app.request("/api/notes?isTrashed=1", {
    headers: requestHeaders(ownerId),
  });
  assert.equal(trashList.status, 200);
  const trashedNotes = await trashList.json() as Array<{ id: string }>;
  assert.equal(trashedNotes.some((note) => note.id === noteId), true);

  const activeList = await app.request("/api/notes", {
    headers: requestHeaders(ownerId),
  });
  assert.equal(activeList.status, 200);
  const activeNotes = await activeList.json() as Array<{ id: string }>;
  assert.equal(activeNotes.some((note) => note.id === noteId), false);

  const directRead = await app.request(`/api/notes/${noteId}`, {
    headers: requestHeaders(ownerId),
  });
  assert.equal(directRead.status, 404);

  const otherUsersTrash = await app.request("/api/notes?isTrashed=1", {
    headers: requestHeaders(memberId),
  });
  assert.equal(otherUsersTrash.status, 200);
  assert.deepEqual(await otherUsersTrash.json(), []);

  const restore = await app.request(`/api/notes/${noteId}`, {
    method: "PUT",
    headers: requestHeaders(ownerId, true),
    body: JSON.stringify({ isTrashed: 0 }),
  });
  assert.equal(restore.status, 200);
  assert.equal(
    (db.prepare("SELECT isTrashed FROM notes WHERE id = ?").get(noteId) as { isTrashed: number }).isTrashed,
    0,
  );
  assert.equal(
    (db.prepare("SELECT isDeleted FROM knowledge_tree_nodes WHERE resourceType = 'note' AND resourceId = ?")
      .get(noteId) as { isDeleted: number }).isDeleted,
    0,
  );

  const trashAgain = await app.request(`/api/notes/${noteId}`, {
    method: "PUT",
    headers: requestHeaders(ownerId, true),
    body: JSON.stringify({ isTrashed: 1 }),
  });
  assert.equal(trashAgain.status, 200);

  const permanentDelete = await app.request(`/api/notes/${noteId}`, {
    method: "DELETE",
    headers: requestHeaders(ownerId),
  });
  assert.equal(permanentDelete.status, 200);
  assert.equal(db.prepare("SELECT 1 FROM notes WHERE id = ?").get(noteId), undefined);
});

test("workspace viewer cannot restore or permanently delete a tombstoned note", async () => {
  const { createKnowledgeChild } = await import("../src/services/knowledgeTree.js");
  const workspaceId = "recycle-workspace";

  db.prepare("INSERT INTO workspaces (id, name, ownerId) VALUES (?, ?, ?)")
    .run(workspaceId, "Recycle Workspace", ownerId);
  db.prepare("INSERT INTO workspace_members (workspaceId, userId, role) VALUES (?, ?, ?)")
    .run(workspaceId, ownerId, "owner");
  db.prepare("INSERT INTO workspace_members (workspaceId, userId, role) VALUES (?, ?, ?)")
    .run(workspaceId, memberId, "viewer");

  const folder = createKnowledgeChild({
    actorUserId: ownerId,
    workspaceId,
    parentId: null,
    nodeType: "folder",
    title: "Team Folder",
    db,
  });
  const noteNode = createKnowledgeChild({
    actorUserId: ownerId,
    workspaceId,
    parentId: folder.id,
    nodeType: "note",
    title: "Team Recycle Note",
    db,
  });
  const noteId = noteNode.resourceId;

  const trash = await app.request(`/api/notes/${noteId}`, {
    method: "PUT",
    headers: requestHeaders(ownerId, true),
    body: JSON.stringify({ isTrashed: 1 }),
  });
  assert.equal(trash.status, 200);

  const viewerTrash = await app.request(`/api/notes?workspaceId=${workspaceId}&isTrashed=1`, {
    headers: requestHeaders(memberId),
  });
  assert.equal(viewerTrash.status, 200);
  const viewerRows = await viewerTrash.json() as Array<{ id: string }>;
  assert.equal(viewerRows.some((note) => note.id === noteId), true);

  const viewerRestore = await app.request(`/api/notes/${noteId}`, {
    method: "PUT",
    headers: requestHeaders(memberId, true),
    body: JSON.stringify({ isTrashed: 0 }),
  });
  assert.equal(viewerRestore.status, 403);

  const viewerPermanentDelete = await app.request(`/api/notes/${noteId}`, {
    method: "DELETE",
    headers: requestHeaders(memberId),
  });
  assert.equal(viewerPermanentDelete.status, 403);
  assert.notEqual(db.prepare("SELECT 1 FROM notes WHERE id = ?").get(noteId), undefined);
});

test("direct maintainer ACL on a tombstone survives deletion and permits restore", async () => {
  const { createKnowledgeChild, restoreKnowledgeNode } = await import("../src/services/knowledgeTree.js");
  const { setKnowledgeNodeRole } = await import("../src/services/knowledgeCapabilities.js");
  const workspaceId = "recycle-direct-acl-workspace";

  db.prepare("INSERT INTO workspaces (id, name, ownerId) VALUES (?, ?, ?)")
    .run(workspaceId, "Direct ACL Workspace", ownerId);
  db.prepare("INSERT INTO workspace_members (workspaceId, userId, role) VALUES (?, ?, ?)")
    .run(workspaceId, ownerId, "owner");
  db.prepare("INSERT INTO workspace_members (workspaceId, userId, role) VALUES (?, ?, ?)")
    .run(workspaceId, memberId, "viewer");

  const folder = createKnowledgeChild({
    actorUserId: ownerId,
    workspaceId,
    parentId: null,
    nodeType: "folder",
    title: "Direct ACL Folder",
    db,
  });
  const noteNode = createKnowledgeChild({
    actorUserId: ownerId,
    workspaceId,
    parentId: folder.id,
    nodeType: "note",
    title: "Direct ACL Note",
    db,
  });

  setKnowledgeNodeRole({
    nodeId: noteNode.id,
    targetUserId: memberId,
    rolePreset: "maintainer",
    actorUserId: ownerId,
    db,
  });

  const trash = await app.request(`/api/notes/${noteNode.resourceId}`, {
    method: "PUT",
    headers: requestHeaders(ownerId, true),
    body: JSON.stringify({ isTrashed: 1 }),
  });
  assert.equal(trash.status, 200);

  const restored = restoreKnowledgeNode({
    actorUserId: memberId,
    nodeId: noteNode.id,
    includeSubtree: true,
    db,
  });
  assert.deepEqual(restored.restoredNodeIds, [noteNode.id]);
  assert.equal(
    (db.prepare("SELECT isTrashed FROM notes WHERE id = ?").get(noteNode.resourceId) as { isTrashed: number }).isTrashed,
    0,
  );
});
