import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-knowledge-projection-repair-"));
process.env.DB_PATH = path.join(tempDir, "projection-repair.db");
let closeDatabase: (() => void) | null = null;

test.after(() => {
  closeDatabase?.();
  fs.rmSync(tempDir, { recursive: true, force: true });
  delete process.env.DB_PATH;
});

test("读取正常笔记时自动修复遗留的 deleted 知识树投影", async () => {
  await import("../src/runtime/knowledge-tree-migration-bootstrap.js");
  const { Hono } = await import("hono");
  const { getDb, closeDb } = await import("../src/db/schema.js");
  const { wrapKnowledgeRoute } = await import("../src/runtime/knowledge-tree.js");

  closeDatabase = closeDb;
  const db = getDb();
  const userId = "projection-owner";
  const notebookId = "11111111-1111-4111-8111-111111111111";
  const noteId = "22222222-2222-4222-8222-222222222222";

  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
    .run(userId, userId, "hash");
  db.prepare(`
    INSERT INTO notebooks (id, userId, workspaceId, parentId, name, icon, sortOrder)
    VALUES (?, ?, NULL, NULL, '导入测试', '📁', 0)
  `).run(notebookId, userId);
  db.prepare(`
    INSERT INTO notes (
      id, userId, workspaceId, notebookId, title, content, contentText,
      contentFormat, note_type, sortOrder, isTrashed
    ) VALUES (?, ?, NULL, ?, '排版元素', '{}', '', 'tiptap-json', 'normal', 0, 0)
  `).run(noteId, userId, notebookId);

  // 模拟旧导入/恢复流程：业务表中的笔记仍是正常状态，但统一知识树投影残留为已删除。
  db.prepare(`
    UPDATE knowledge_tree_nodes
    SET isDeleted = 1, deletedAt = datetime('now')
    WHERE resourceType = 'note' AND resourceId = ?
  `).run(noteId);

  const routes = new Hono();
  routes.get("/:id", (c) => c.json({ id: c.req.param("id"), title: "排版元素" }));

  const api = new Hono();
  api.route("/api/notes", wrapKnowledgeRoute("/api/notes", routes));

  const response = await api.request(`http://localhost/api/notes/${noteId}`, {
    headers: { "X-User-Id": userId },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { id: noteId, title: "排版元素" });

  const projection = db.prepare(`
    SELECT isDeleted, deletedAt, scopeKey
    FROM knowledge_tree_nodes
    WHERE resourceType = 'note' AND resourceId = ?
  `).get(noteId) as { isDeleted: number; deletedAt: string | null; scopeKey: string };
  assert.equal(projection.isDeleted, 0);
  assert.equal(projection.deletedAt, null);
  assert.equal(projection.scopeKey, `personal:${userId}`);
});
