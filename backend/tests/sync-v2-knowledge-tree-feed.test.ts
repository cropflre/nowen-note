import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Hono } from "hono";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-tree-feed-"));
process.env.DB_PATH = path.join(tempDir, "tree-feed.db");
process.env.ELECTRON_USER_DATA = tempDir;
process.env.NOWEN_LOCAL_FIRST_SYNC_V2 = "1";

test.after(async () => {
  const { closeDb } = await import("../src/db/schema.js");
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("tree structure enters the server feed atomically while legacy clients skip it", async () => {
  await import("../src/runtime/knowledge-tree-migration-bootstrap.js");
  const { getDb } = await import("../src/db/schema.js");
  const { runChangeFeedSuppressed } = await import("../src/sync/suppression.js");
  const route = (await import("../src/routes/sync-v2.js")).default;
  const db = getDb();
  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES ('owner', 'owner', 'hash')").run();
  db.prepare("INSERT INTO notebooks (id, userId, name) VALUES ('folder', 'owner', '目录')").run();
  db.prepare("INSERT INTO mindmaps (id, userId, title, data) VALUES ('map', 'owner', '脑图', '{}')").run();
  db.exec("DELETE FROM sync_changes_v2");

  db.prepare("UPDATE knowledge_tree_nodes SET parentId = 'notebook:folder', sortOrder = 7 WHERE id = 'mindmap:map'").run();
  db.prepare("UPDATE knowledge_tree_nodes SET isDeleted = 1, deletedAt = datetime('now') WHERE id = 'mindmap:map'").run();
  db.prepare("UPDATE knowledge_tree_nodes SET isDeleted = 0, deletedAt = NULL WHERE id = 'mindmap:map'").run();
  db.prepare("UPDATE knowledge_tree_nodes SET isExpanded = 0, updatedAt = datetime('now') WHERE id = 'mindmap:map'").run();
  const rows = db.prepare(`
    SELECT entityType, entityId, operation FROM sync_changes_v2 ORDER BY sequence
  `).all() as Array<{ entityType: string; entityId: string; operation: string }>;
  assert.deepEqual(rows, [
    { entityType: "knowledge_tree_node", entityId: "mindmap:map", operation: "upsert" },
    { entityType: "knowledge_tree_node", entityId: "mindmap:map", operation: "upsert" },
    { entityType: "knowledge_tree_node", entityId: "mindmap:map", operation: "upsert" },
  ]);

  assert.throws(() => db.transaction(() => {
    db.prepare("UPDATE knowledge_tree_nodes SET sortOrder = 9 WHERE id = 'mindmap:map'").run();
    throw new Error("rollback");
  })(), /rollback/);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM sync_changes_v2").get() as { count: number }).count, 3);
  db.transaction(() => runChangeFeedSuppressed(db, () => {
    db.prepare("UPDATE knowledge_tree_nodes SET sortOrder = 8 WHERE id = 'mindmap:map'").run();
  }))();
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM sync_changes_v2").get() as { count: number }).count, 3);

  const app = new Hono();
  app.route("/api/sync/v2", route);
  const response = await app.request("/api/sync/v2/changes?after=0", {
    headers: { "X-User-Id": "owner" },
  });
  assert.equal(response.status, 200);
  const legacy = await response.json() as { items: unknown[]; nextSequence: number };
  assert.deepEqual(legacy.items, []);
  assert.ok(legacy.nextSequence > 0, "旧客户端应跳过未来实体并推进旧协议游标");

  db.prepare("DELETE FROM knowledge_tree_nodes WHERE id = 'mindmap:map'").run();
  const last = db.prepare("SELECT entityType, operation FROM sync_changes_v2 ORDER BY sequence DESC LIMIT 1")
    .get() as { entityType: string; operation: string };
  assert.deepEqual(last, { entityType: "knowledge_tree_node", operation: "delete" });

  const { syncV2KnowledgeTreeFeedMigration } = await import("../src/db/syncV2KnowledgeTreeFeedMigration.js");
  const before = db.prepare("SELECT sequence, entityType FROM sync_changes_v2 ORDER BY sequence").all();
  syncV2KnowledgeTreeFeedMigration.up(db);
  assert.deepEqual(db.prepare("SELECT sequence, entityType FROM sync_changes_v2 ORDER BY sequence").all(), before,
    "扩展 feed 约束时不得改变已有 sequence");
  const highWater = (db.prepare("SELECT MAX(sequence) AS value FROM sync_changes_v2").get() as { value: number }).value;
  db.exec("DELETE FROM sync_changes_v2");
  syncV2KnowledgeTreeFeedMigration.up(db);
  db.prepare("INSERT INTO mindmaps (id, userId, title, data) VALUES ('next-map', 'owner', '下一张', '{}')").run();
  const next = db.prepare("SELECT MIN(sequence) AS value FROM sync_changes_v2").get() as { value: number };
  assert.ok(next.value > highWater, "清理历史 feed 后新序号仍须高于旧游标");
  const types = (db.prepare("SELECT DISTINCT entityType FROM sync_changes_v2").all() as Array<{ entityType: string }>)
    .map((row) => row.entityType);
  assert.ok(types.includes("mindmap"), "原有实体的 Change Feed 触发器必须仍然工作");
  assert.ok(types.includes("knowledge_tree_node"));
});

test("workspace tree events retain their scope and remain hidden from legacy subscriptions", async () => {
  const { getDb } = await import("../src/db/schema.js");
  const route = (await import("../src/routes/sync-v2.js")).default;
  const db = getDb();
  db.prepare("INSERT INTO workspaces (id, name, ownerId) VALUES ('tree-ws', '团队', 'owner')").run();
  db.prepare("INSERT INTO workspace_members (workspaceId, userId, role) VALUES ('tree-ws', 'owner', 'owner')").run();
  db.prepare(`
    INSERT INTO mindmaps (id, userId, workspaceId, title, data)
    VALUES ('workspace-map', 'owner', 'tree-ws', '团队脑图', '{}')
  `).run();
  const event = db.prepare(`
    SELECT sequence, userId, workspaceId FROM sync_changes_v2
    WHERE entityType = 'knowledge_tree_node' AND entityId = 'mindmap:workspace-map'
    ORDER BY sequence DESC LIMIT 1
  `).get() as { sequence: number; userId: string; workspaceId: string };
  assert.equal(event.userId, "owner");
  assert.equal(event.workspaceId, "tree-ws");

  const app = new Hono();
  app.route("/api/sync/v2", route);
  const response = await app.request("/api/sync/v2/changes?after=0&scopeKey=workspace%3Atree-ws", {
    headers: { "X-User-Id": "owner" },
  });
  assert.equal(response.status, 200);
  const legacy = await response.json() as { items: Array<{ entityType: string }>; nextSequence: number };
  assert.ok(legacy.items.every((item) => item.entityType !== "knowledge_tree_node"));
  assert.ok(legacy.nextSequence >= event.sequence);
});
