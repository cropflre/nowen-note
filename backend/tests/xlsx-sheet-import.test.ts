import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-xlsx-import-"));
process.env.DB_PATH = path.join(dir, "import.db");
let closeDatabase: (() => void) | undefined;
test.after(() => { closeDatabase?.(); fs.rmSync(dir, { recursive: true, force: true }); delete process.env.DB_PATH; });

test("XLSX sheet import creates data atomically and enforces destination capabilities and budgets", async () => {
  const { Hono } = await import("hono");
  const { getDb, closeDb } = await import("../src/db/schema.js");
  const { createKnowledgeChild } = await import("../src/services/knowledgeTree.js");
  const { setKnowledgeNodeRole } = await import("../src/services/knowledgeCapabilities.js");
  const route = (await import("../src/routes/knowledge-tree.js")).default;
  closeDatabase = closeDb;
  const db = getDb();
  for (const user of ["owner", "viewer"]) db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, 'hash')").run(user, user);
  const folder = createKnowledgeChild({ actorUserId: "owner", workspaceId: null, parentId: null, nodeType: "folder", title: "导入", db });
  setKnowledgeNodeRole({ nodeId: folder.id, targetUserId: "viewer", rolePreset: "readonly", actorUserId: "owner", db });
  const app = new Hono();
  app.route("/api/knowledge-tree", route);
  const sheetData = { version: 1, rows: [{ id: "r1", height: 32 }], columns: [{ id: "c1", title: "金额", type: "number", align: "right", width: 120 }], cells: { "r1:c1": "3000" } };
  const request = (body: any, user = "owner") => app.request("http://localhost/api/knowledge-tree/nodes?workspaceId=personal", {
    method: "POST", headers: { "X-User-Id": user, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const payload = { nodeType: "sheet", title: "预算.xlsx · Sheet1", parentId: folder.id, sheetData };
  const imported = await request(payload);
  assert.equal(imported.status, 201);
  const node = await imported.json() as any;
  assert.equal(node.parentId, folder.id);
  assert.equal(node.noteType, "sheet");
  const stored = db.prepare("SELECT data FROM sheets WHERE noteId = ?").get(node.resourceId) as { data: string };
  assert.deepEqual(JSON.parse(stored.data), sheetData);
  const counts = () => ["notes", "sheets", "knowledge_tree_nodes", "notebooks"].map((table) => (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as any).count);
  const before = counts();
  const forbidden = await request(payload, "viewer");
  assert.equal(forbidden.status, 403);
  assert.equal((await forbidden.json() as any).required, "canCreate");
  assert.deepEqual(counts(), before);
  for (const invalid of [{ ...sheetData, rows: Array.from({ length: 1001 }, () => ({ id: "r", height: 32 })) }, { ...sheetData, cells: Object.fromEntries(Array.from({ length: 50001 }, (_, i) => [`r${i}:c1`, "x"])) }, null]) {
    const result = await request({ ...payload, parentId: null, sheetData: invalid });
    assert.equal(result.status, 400);
    assert.equal((await result.json() as any).code, "INVALID_PAYLOAD");
    assert.deepEqual(counts(), before, "invalid imports must not leave empty documents or root containers");
  }
  const wrongType = await request({ ...payload, nodeType: "note" });
  assert.equal(wrongType.status, 400);
  assert.deepEqual(counts(), before);
  db.exec("CREATE TRIGGER fail_sheet_import BEFORE INSERT ON sheets BEGIN SELECT RAISE(ABORT, 'test import rollback'); END;");
  assert.throws(() => createKnowledgeChild({ actorUserId: "owner", workspaceId: null, parentId: folder.id, nodeType: "sheet", title: "rollback", sheetData, db }), /test import rollback/);
  assert.deepEqual(counts(), before, "failed sheet write rolls back its note and tree node");
  db.exec("DROP TRIGGER fail_sheet_import");
  const root = await request({ ...payload, parentId: null });
  assert.equal(root.status, 201);
  const rootNode = await root.json() as any;
  assert.equal(rootNode.parentId, null);
  assert.deepEqual(JSON.parse((db.prepare("SELECT data FROM sheets WHERE noteId = ?").get(rootNode.resourceId) as any).data), sheetData);
});
