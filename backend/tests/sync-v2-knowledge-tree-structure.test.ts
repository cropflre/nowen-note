import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Hono } from "hono";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-tree-structure-"));
process.env.DB_PATH = path.join(tempDir, "tree-structure.db");
process.env.ELECTRON_USER_DATA = tempDir;
process.env.NOWEN_LOCAL_FIRST_SYNC_V2 = "1";

test.after(async () => {
  const { closeDb } = await import("../src/db/schema.js");
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("tree structure apply detects concurrent moves and rejects unsafe parents", async () => {
  await import("../src/runtime/knowledge-tree-migration-bootstrap.js");
  const { getDb } = await import("../src/db/schema.js");
  const { createKnowledgeChild } = await import("../src/services/knowledgeTree.js");
  const { applyKnowledgeTreeStructureMutation: apply } = await import("../src/sync/knowledgeTreeStructure.js");
  const { applyMutation } = await import("../src/sync/apply.js");
  const db = getDb();
  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES ('owner', 'owner', 'hash')").run();
  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES ('other', 'other', 'hash')").run();
  const folder = createKnowledgeChild({ actorUserId: "owner", workspaceId: null, parentId: null,
    nodeType: "folder", title: "目录", db });
  const note = createKnowledgeChild({ actorUserId: "owner", workspaceId: null, parentId: folder.id,
    nodeType: "markdown", title: "笔记", db });
  db.prepare("INSERT INTO mindmaps (id, userId, title, data) VALUES ('map', 'owner', '脑图', '{}')").run();
  const read = () => db.prepare("SELECT parentId, sortOrder, isDeleted FROM knowledge_tree_nodes WHERE id = 'mindmap:map'")
    .get() as { parentId: string | null; sortOrder: number; isDeleted: number };
  const base = { baseParentId: null, baseSortOrder: read().sortOrder, baseIsDeleted: 0 };
  const payload = (parentId: string | null, sortOrder: number, isDeleted = 0) => ({
    id: "mindmap:map", resourceType: "mindmap", resourceId: "map",
    parentId, sortOrder, isDeleted, deletedAt: isDeleted ? "2026-09-27 10:00:00" : null,
    ...base,
  });
  const input = (p: Record<string, unknown>, userId = "owner") => ({
    userId, workspaceId: null, entityId: "mindmap:map", operation: "upsert" as const, payload: p,
  });

  const first = db.transaction(() => applyMutation(db, {
    ...input(payload(note.id, 7)), entityType: "knowledge_tree_node",
    mutationId: "tree-move-1", deviceId: "device-a",
  }))();
  assert.equal(first.status, "applied");
  assert.equal(db.transaction(() => applyMutation(db, {
    ...input(payload(note.id, 7)), entityType: "knowledge_tree_node",
    mutationId: "tree-move-1", deviceId: "device-a",
  }))().status, "duplicate");
  assert.deepEqual(read(), { parentId: note.id, sortOrder: 7, isDeleted: 0 });
  assert.throws(() => db.transaction(() => applyMutation(db, {
    ...input(payload(folder.id, 1)), entityType: "knowledge_tree_node",
    mutationId: "tree-move-conflict", deviceId: "device-b",
  }))(),
    (error: { code: string }) => error.code === "VERSION_CONFLICT");
  assert.deepEqual(read(), { parentId: note.id, sortOrder: 7, isDeleted: 0 });
  assert.equal(db.prepare("SELECT 1 FROM sync_v2_applied_mutations WHERE mutationId = 'tree-move-conflict'").get(), undefined);
  apply(db, input(payload(note.id, 7))); // A replay of an already reached state is harmless.

  const current = { baseParentId: note.id, baseSortOrder: 7, baseIsDeleted: 0 };
  assert.throws(() => apply(db, input({ ...payload("note:missing", 8), ...current })),
    (error: { code: string }) => error.code === "MISSING_DEPENDENCY");
  assert.throws(() => apply(db, input({ ...payload(folder.id, 8), ...current, resourceId: "another" })),
    (error: { code: string }) => error.code === "INVALID_PAYLOAD");
  assert.throws(() => apply(db, input({ ...payload(folder.id, 8), ...current }, "other")),
    (error: { code: string }) => error.code === "MISSING_DEPENDENCY");
  assert.deepEqual(read(), { parentId: note.id, sortOrder: 7, isDeleted: 0 });

  apply(db, input({ ...payload(note.id, 7, 1), ...current }));
  assert.equal(read().isDeleted, 1);
  apply(db, input({ ...payload(note.id, 7, 0), ...current, baseIsDeleted: 1 }));
  assert.equal(read().isDeleted, 0);

  db.prepare("INSERT INTO mindmaps (id, userId, title, data) VALUES ('loop', 'owner', '循环图', '{}')").run();
  db.prepare("UPDATE knowledge_tree_nodes SET parentId = 'mindmap:loop' WHERE id = ?").run(note.id);
  assert.throws(() => apply(db, { userId: "owner", workspaceId: null,
    entityId: "mindmap:loop", operation: "upsert",
    payload: { id: "mindmap:loop", resourceType: "mindmap", resourceId: "loop",
      parentId: note.id, sortOrder: 1, isDeleted: 0,
      baseParentId: null, baseSortOrder: 0, baseIsDeleted: 0 } }),
  (error: { code: string }) => error.code === "INVALID_PAYLOAD");

  db.prepare("INSERT INTO workspaces (id, name, ownerId) VALUES ('ws', '团队', 'owner')").run();
  db.prepare("INSERT INTO workspace_members (workspaceId, userId, role) VALUES ('ws', 'owner', 'owner')").run();
  db.prepare("INSERT INTO workspace_members (workspaceId, userId, role) VALUES ('ws', 'other', 'viewer')").run();
  db.prepare("INSERT INTO mindmaps (id, userId, workspaceId, title, data) VALUES ('team-map', 'owner', 'ws', '团队图', '{}')").run();
  assert.throws(() => apply(db, input({ ...payload("mindmap:team-map", 8), ...current })),
    (error: { code: string }) => error.code === "SCOPE_FORBIDDEN");
  assert.throws(() => apply(db, { userId: "other", workspaceId: "ws", entityId: "mindmap:team-map",
    operation: "upsert", payload: { id: "mindmap:team-map", resourceType: "mindmap",
      resourceId: "team-map", parentId: null, sortOrder: 1, isDeleted: 0,
      baseParentId: null, baseSortOrder: 0, baseIsDeleted: 0 } }),
  (error: { code: string }) => error.code === "SCOPE_FORBIDDEN");

  const route = (await import("../src/routes/sync-v2.js")).default;
  const app = new Hono();
  app.route("/api/sync/v2", route);
  const response = await app.request("/api/sync/v2/push", {
    method: "POST",
    headers: { "X-User-Id": "owner", "Content-Type": "application/json" },
    body: JSON.stringify({ deviceId: "legacy-device", mutations: [{
      mutationId: "premature-tree-push", entityType: "knowledge_tree_node",
      entityId: "mindmap:loop", operation: "upsert", payload: {
        id: "mindmap:loop", resourceType: "mindmap", resourceId: "loop",
        parentId: null, sortOrder: 0, isDeleted: 0,
      },
    }] }),
  });
  assert.equal(response.status, 200);
  const result = await response.json() as { results: Array<{ code: string }> };
  assert.equal(result.results[0].code, "INVALID_PAYLOAD",
    "旧实体协议不能在客户端链路完成前推送知识树节点");

  db.prepare("DELETE FROM mindmaps WHERE id = 'map'").run();
  apply(db, { userId: "owner", workspaceId: null, entityId: "mindmap:map", operation: "delete" });
  assert.equal(db.prepare("SELECT 1 FROM knowledge_tree_nodes WHERE id = 'mindmap:map'").get(), undefined);
});
