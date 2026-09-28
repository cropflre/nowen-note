import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-sheet-tree-"));
process.env.DB_PATH = path.join(dir, "sheet.db");

test.after(async () => {
  const { closeDb } = await import("../src/db/schema.js");
  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("lightweight sheet uses an independent data model and a unified tree note shell", async () => {
  await import("../src/runtime/knowledge-tree-migration-bootstrap.js");
  const { getDb } = await import("../src/db/schema.js");
  const { createKnowledgeChild, listKnowledgeTree, moveKnowledgeNode } = await import("../src/services/knowledgeTree.js");
  const db = getDb();
  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES ('owner', 'owner', 'hash')").run();
  const folder = createKnowledgeChild({
    actorUserId: "owner", workspaceId: null, parentId: null, nodeType: "folder", title: "数据", db,
  });
  const sheet = createKnowledgeChild({
    actorUserId: "owner", workspaceId: null, parentId: folder.id, nodeType: "sheet", title: "服务器清单", db,
  });

  const note = db.prepare("SELECT note_type, content FROM notes WHERE id = ?").get(sheet.resourceId) as {
    note_type: string; content: string;
  };
  assert.equal(note.note_type, "sheet");
  assert.equal(note.content, "{}", "导航壳不得承载表格单元格数据");

  const stored = db.prepare("SELECT data FROM sheets WHERE noteId = ?").get(sheet.resourceId) as { data: string };
  const data = JSON.parse(stored.data);
  assert.equal(data.rows.length, 20);
  assert.equal(data.columns.length, 8);
  assert.equal(data.columns[0].type, "text");
  assert.equal(data.columns[0].align, "left");

  const listed = listKnowledgeTree({ userId: "owner", workspaceId: null, db })
    .find((node) => node.resourceId === sheet.resourceId);
  assert.equal(listed?.resourceType, "note");
  assert.equal(listed?.noteType, "sheet");
  assert.equal(listed?.title, "服务器清单");

  const target = createKnowledgeChild({
    actorUserId: "owner", workspaceId: null, parentId: null, nodeType: "folder", title: "归档", db,
  });
  moveKnowledgeNode({ actorUserId: "owner", nodeId: sheet.id, parentId: target.id, db });
  assert.equal(
    listKnowledgeTree({ userId: "owner", workspaceId: null, db })
      .find((node) => node.id === sheet.id)?.parentId,
    target.id,
  );

  db.prepare("DELETE FROM notes WHERE id = ?").run(sheet.resourceId);
  assert.equal(db.prepare("SELECT 1 FROM sheets WHERE noteId = ?").get(sheet.resourceId), undefined);
});
