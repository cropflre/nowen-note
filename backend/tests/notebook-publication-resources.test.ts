import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-publication-resources-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");

let closeDb: () => void;

test("published knowledge resources include notes, sheets and mindmaps inside the unified tree only", async () => {
  const [{ getDb, closeDb: close }, { ensureKnowledgeTreeTables }, resourceModule] = await Promise.all([
    import("../src/db/schema"),
    import("../src/db/knowledgeTreeMigration"),
    import("../src/services/notebookPublicationResources"),
  ]);
  closeDb = close;
  const db = getDb();
  ensureKnowledgeTreeTables(db);

  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)").run("owner", "owner", "hash");
  db.prepare("INSERT INTO notebooks (id, userId, name, icon) VALUES (?, ?, ?, ?)").run("root", "owner", "公开目录", "📚");
  db.prepare("INSERT INTO notebooks (id, userId, parentId, name, icon) VALUES (?, ?, ?, ?, ?)").run("child", "owner", "root", "子目录", "📁");
  db.prepare("INSERT INTO notebooks (id, userId, name, icon) VALUES (?, ?, ?, ?)").run("private", "owner", "未发布目录", "🔒");

  db.prepare(`
    INSERT INTO notes (id, userId, notebookId, title, content, contentText, contentFormat, note_type)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run("note-1", "owner", "child", "公开笔记", "# Hello", "Hello", "markdown", "normal");
  db.prepare(`
    INSERT INTO notes (id, userId, notebookId, title, content, contentText, contentFormat, note_type)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run("sheet-1", "owner", "child", "服务器清单", "{}", "", "tiptap-json", "sheet");
  db.prepare("INSERT INTO sheets (noteId, userId, data) VALUES (?, ?, ?)").run(
    "sheet-1",
    "owner",
    JSON.stringify({
      version: 1,
      columns: [{ id: "c1", title: "地址", width: 120, type: "text", align: "left" }],
      rows: [{ id: "r1", height: 32 }],
      cells: { "r1:c1": "10.24.8.19" },
    }),
  );
  db.prepare("INSERT INTO mindmaps (id, userId, title, data) VALUES (?, ?, ?, ?)").run(
    "11111111-2222-4333-8444-555555555555",
    "owner",
    "公开脑图",
    JSON.stringify({ root: { id: "root", text: "Agent 架构", children: [{ id: "n1", text: "Tool Router", children: [] }] } }),
  );
  db.prepare("INSERT INTO mindmaps (id, userId, title, data) VALUES (?, ?, ?, ?)").run(
    "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    "owner",
    "私有脑图",
    JSON.stringify({ root: { id: "root", text: "不能公开", children: [] } }),
  );

  db.prepare("UPDATE knowledge_tree_nodes SET parentId = ? WHERE id = ?").run(
    "notebook:child",
    "mindmap:11111111-2222-4333-8444-555555555555",
  );
  db.prepare("UPDATE knowledge_tree_nodes SET parentId = ? WHERE id = ?").run(
    "notebook:private",
    "mindmap:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  );

  const resources = resourceModule.listPublishedKnowledgeResources(db, "root");
  const types = new Map(resources.map((resource) => [resource.resourceId, resource.resourceType]));
  assert.equal(types.get("note-1"), "note");
  assert.equal(types.get("sheet-1"), "sheet");
  assert.equal(types.get("11111111-2222-4333-8444-555555555555"), "mindmap");
  assert.equal(types.has("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"), false);

  const sheet = resources.find((resource) => resource.resourceId === "sheet-1");
  assert.equal(sheet?.notebookId, "child");
  assert.match(sheet?.contentText || "", /10\.24\.8\.19/);

  const mindmap = resources.find((resource) => resource.resourceType === "mindmap");
  assert.match(mindmap?.contentText || "", /Tool Router/);

  const sheetContent = resourceModule.getPublishedKnowledgeResource(db, "root", "note:sheet-1");
  assert.equal(sheetContent?.resourceType, "sheet");
  assert.match(sheetContent?.data || "", /10\.24\.8\.19/);

  const denied = resourceModule.getPublishedKnowledgeResource(
    db,
    "root",
    "mindmap:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  );
  assert.equal(denied, null);
});

test.after(() => {
  closeDb?.();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
