/**
 * Excel 工作簿（Univer 快照）后端行为测试。功能来源：cropflre/nowen-note PR #802。
 */
import assert from "node:assert/strict";
import test from "node:test";

const owner = "excel-owner";
const viewer = "excel-viewer";
const outsider = "excel-outsider";
const otherWorkspaceMember = "excel-other-ws";

function workbook(cells: Record<string, Record<string, Record<string, unknown>>>, extra: Record<string, unknown> = {}) {
  return {
    id: "workbook-01",
    name: "预算",
    sheetOrder: ["sheet-01", "sheet-02"],
    styles: {},
    sheets: {
      "sheet-01": {
        id: "sheet-01", name: "收入", rowCount: 200, columnCount: 30,
        cellData: cells,
        mergeData: [{ startRow: 5, endRow: 6, startColumn: 0, endColumn: 2 }],
      },
      "sheet-02": {
        id: "sheet-02", name: "支出", rowCount: 200, columnCount: 30,
        cellData: { 0: { 0: { v: "房租" }, 1: { v: 3000, t: 2 } } },
        mergeData: [],
      },
    },
    ...extra,
  };
}

async function setup() {
  await import("../src/runtime/knowledge-tree-migration-bootstrap.js");
  const { Hono } = await import("hono");
  const { getDb } = await import("../src/db/schema.js");
  const { createKnowledgeChild } = await import("../src/services/knowledgeTree.js");
  const excels = (await import("../src/routes/excels.js")).default;
  const knowledgeTree = (await import("../src/routes/knowledge-tree.js")).default;
  const db = getDb();
  for (const userId of [owner, viewer, outsider, otherWorkspaceMember]) {
    db.prepare("INSERT OR IGNORE INTO users (id, username, passwordHash) VALUES (?, ?, 'hash')").run(userId, userId);
  }
  const app = new Hono();
  app.route("/api/excels", excels);
  app.route("/api/knowledge-tree", knowledgeTree);
  return { app, db, createKnowledgeChild };
}

const json = (userId: string) => ({ "X-User-Id": userId, "Content-Type": "application/json" });

test("新建 Excel 需显式开启；开启后创建默认工作簿，revision 从 1 开始", async () => {
  const { app, db, createKnowledgeChild } = await setup();
  const folder = createKnowledgeChild({ actorUserId: owner, workspaceId: null, parentId: null, nodeType: "folder", title: "表格", db });

  delete process.env.NOWEN_EXCEL_WORKBOOK;
  const disabled = await app.request("/api/knowledge-tree/nodes", {
    method: "POST", headers: json(owner),
    body: JSON.stringify({ parentId: folder.id, nodeType: "excel", title: "预算" }),
  });
  assert.equal(disabled.status, 403);
  assert.equal((await disabled.json() as any).code, "EXCEL_WORKBOOK_DISABLED");
  assert.equal((await (await app.request("/api/excels/capabilities", { headers: json(owner) })).json() as any).createEnabled, false);

  process.env.NOWEN_EXCEL_WORKBOOK = "1";
  try {
    const created = await app.request("/api/knowledge-tree/nodes", {
      method: "POST", headers: json(owner),
      body: JSON.stringify({ parentId: folder.id, nodeType: "excel", title: "预算" }),
    });
    assert.equal(created.status, 201);
    const node = await created.json() as any;
    assert.equal(node.noteType, "excel");
    const opened = await app.request(`/api/excels/${node.resourceId}`, { headers: json(owner) });
    assert.equal(opened.status, 200);
    const document = await opened.json() as any;
    assert.equal(document.revision, 1);
    assert.equal(document.canEdit, true);
    assert.deepEqual(document.data.sheetOrder, ["sheet-01"]);

    assert.throws(
      () => createKnowledgeChild({ actorUserId: owner, workspaceId: null, parentId: folder.id, nodeType: "excel", title: "x", encryptedContent: "{}", encryptedNoteId: crypto.randomUUID(), db }),
      /Excel 表格暂不支持加密/,
    );
  } finally {
    delete process.env.NOWEN_EXCEL_WORKBOOK;
  }
});

test("保存后重开保留多工作表、公式、合并区域，并以同事务更新检索文本", async () => {
  const { app, db, createKnowledgeChild } = await setup();
  const folder = createKnowledgeChild({ actorUserId: owner, workspaceId: null, parentId: null, nodeType: "folder", title: "保存", db });
  const node = createKnowledgeChild({ actorUserId: owner, workspaceId: null, parentId: folder.id, nodeType: "excel", title: "收支", db });
  const data = workbook({
    0: { 0: { v: 100, t: 2 }, 1: { v: "工资" } },
    1: { 0: { v: 200, t: 2 } },
    2: { 0: { f: "=SUM(A1:A2)", v: 300, t: 2 } },
  });
  const saved = await app.request(`/api/excels/${node.resourceId}`, {
    method: "PUT", headers: json(owner), body: JSON.stringify({ data, expectedRevision: 1 }),
  });
  assert.equal(saved.status, 200);
  const ack = await saved.json() as any;
  assert.equal(ack.revision, 2);

  const reopened = await (await app.request(`/api/excels/${node.resourceId}`, { headers: json(owner) })).json() as any;
  assert.equal(reopened.revision, 2);
  assert.deepEqual(reopened.data, data);
  assert.equal(reopened.data.sheets["sheet-01"].cellData["2"]["0"].f, "=SUM(A1:A2)");
  assert.deepEqual(reopened.data.sheets["sheet-01"].mergeData, [{ startRow: 5, endRow: 6, startColumn: 0, endColumn: 2 }]);

  const text = (db.prepare("SELECT contentText FROM notes WHERE id = ?").get(node.resourceId) as { contentText: string }).contentText;
  assert.equal(text, "收入\n100\t工资\n200\n300\n支出\n房租\t3000");
});

test("DCC-004: 过期 revision 返回 409，服务器版本不被覆盖；缺少 expectedRevision 拒绝盲写", async () => {
  const { app, db, createKnowledgeChild } = await setup();
  const folder = createKnowledgeChild({ actorUserId: owner, workspaceId: null, parentId: null, nodeType: "folder", title: "冲突", db });
  const node = createKnowledgeChild({ actorUserId: owner, workspaceId: null, parentId: folder.id, nodeType: "excel", title: "两窗口", db });
  const windowA = workbook({ 0: { 0: { v: "A 窗口" } } });
  const windowB = workbook({ 0: { 0: { v: "B 窗口" } } });
  assert.equal((await app.request(`/api/excels/${node.resourceId}`, {
    method: "PUT", headers: json(owner), body: JSON.stringify({ data: windowA, expectedRevision: 1 }),
  })).status, 200);
  const stale = await app.request(`/api/excels/${node.resourceId}`, {
    method: "PUT", headers: json(owner), body: JSON.stringify({ data: windowB, expectedRevision: 1 }),
  });
  assert.equal(stale.status, 409);
  const conflict = await stale.json() as any;
  assert.equal(conflict.code, "EXCEL_CONFLICT");
  assert.equal(conflict.currentRevision, 2);
  const blind = await app.request(`/api/excels/${node.resourceId}`, {
    method: "PUT", headers: json(owner), body: JSON.stringify({ data: windowB }),
  });
  assert.equal(blind.status, 400);
  const current = await (await app.request(`/api/excels/${node.resourceId}`, { headers: json(owner) })).json() as any;
  assert.equal(current.data.sheets["sheet-01"].cellData["0"]["0"].v, "A 窗口");

  // 用户明确选择“以本机版本覆盖”时，客户端带上 409 返回的 currentRevision。
  const overwrite = await app.request(`/api/excels/${node.resourceId}`, {
    method: "PUT", headers: json(owner), body: JSON.stringify({ data: windowB, expectedRevision: conflict.currentRevision }),
  });
  assert.equal(overwrite.status, 200);
  assert.equal((await overwrite.json() as any).revision, 3);
});

test("只读成员可看不可写，无权与跨工作区用户被拒绝且数据不变", async () => {
  const { app, db, createKnowledgeChild } = await setup();
  db.prepare("INSERT INTO workspaces (id, name, ownerId) VALUES ('excel-ws', 'Excel WS', ?)").run(owner);
  db.prepare("INSERT INTO workspace_members (workspaceId, userId, role) VALUES ('excel-ws', ?, 'owner')").run(owner);
  db.prepare("INSERT INTO workspace_members (workspaceId, userId, role) VALUES ('excel-ws', ?, 'viewer')").run(viewer);
  db.prepare("INSERT INTO workspaces (id, name, ownerId) VALUES ('excel-ws-other', 'Other WS', ?)").run(otherWorkspaceMember);
  db.prepare("INSERT INTO workspace_members (workspaceId, userId, role) VALUES ('excel-ws-other', ?, 'owner')").run(otherWorkspaceMember);
  const folder = createKnowledgeChild({ actorUserId: owner, workspaceId: "excel-ws", parentId: null, nodeType: "folder", title: "共享", db });
  const node = createKnowledgeChild({ actorUserId: owner, workspaceId: "excel-ws", parentId: folder.id, nodeType: "excel", title: "团队", db });
  const before = (db.prepare("SELECT data, revision FROM excel_documents WHERE noteId = ?").get(node.resourceId)) as { data: string; revision: number };

  const viewerRead = await app.request(`/api/excels/${node.resourceId}`, { headers: json(viewer) });
  assert.equal(viewerRead.status, 200);
  assert.equal((await viewerRead.json() as any).canEdit, false);
  const viewerWrite = await app.request(`/api/excels/${node.resourceId}`, {
    method: "PUT", headers: json(viewer), body: JSON.stringify({ data: workbook({}), expectedRevision: 1 }),
  });
  assert.equal(viewerWrite.status, 403);

  for (const userId of [outsider, otherWorkspaceMember]) {
    assert.equal((await app.request(`/api/excels/${node.resourceId}`, { headers: json(userId) })).status, 403);
    const write = await app.request(`/api/excels/${node.resourceId}`, {
      method: "PUT", headers: json(userId), body: JSON.stringify({ data: workbook({}), expectedRevision: 1 }),
    });
    assert.equal(write.status, 403);
  }
  assert.equal((await app.request(`/api/excels/${crypto.randomUUID()}`, { headers: json(owner) })).status, 404);
  assert.deepEqual(db.prepare("SELECT data, revision FROM excel_documents WHERE noteId = ?").get(node.resourceId), before);
});

test("超限与损坏数据明确拒绝，不截断也不以空表顶替", async () => {
  const { app, db, createKnowledgeChild } = await setup();
  const folder = createKnowledgeChild({ actorUserId: owner, workspaceId: null, parentId: null, nodeType: "folder", title: "上限", db });
  const node = createKnowledgeChild({ actorUserId: owner, workspaceId: null, parentId: folder.id, nodeType: "excel", title: "大表", db });
  const huge = JSON.stringify({ data: workbook({ 0: { 0: { v: "x".repeat(11 * 1024 * 1024) } } }), expectedRevision: 1 });
  const tooLarge = await app.request(`/api/excels/${node.resourceId}`, {
    method: "PUT", headers: { ...json(owner), "Content-Length": String(Buffer.byteLength(huge)) }, body: huge,
  });
  assert.equal(tooLarge.status, 413);
  assert.equal((await tooLarge.json() as any).code, "EXCEL_TOO_LARGE");
  // 即使请求未声明长度，序列化体积校验也会拒绝。
  const undeclared = await app.request(`/api/excels/${node.resourceId}`, { method: "PUT", headers: json(owner), body: huge });
  assert.equal(undeclared.status >= 400 && undeclared.status < 500, true);
  const invalid = await app.request(`/api/excels/${node.resourceId}`, {
    method: "PUT", headers: json(owner),
    body: JSON.stringify({ data: { id: "w", sheetOrder: ["missing"], sheets: { a: {} } }, expectedRevision: 1 }),
  });
  assert.equal(invalid.status, 400);
  assert.equal((db.prepare("SELECT revision FROM excel_documents WHERE noteId = ?").get(node.resourceId) as any).revision, 1);

  db.prepare("UPDATE excel_documents SET data = '{broken' WHERE noteId = ?").run(node.resourceId);
  const corrupt = await app.request(`/api/excels/${node.resourceId}`, { headers: json(owner) });
  assert.equal(corrupt.status, 500);
  assert.equal((await corrupt.json() as any).code, "EXCEL_DATA_CORRUPT");
});

test("DCC-007: 回收站删除后不可编辑，恢复后工作簿完整；永久删除级联清理", async () => {
  const { app, db, createKnowledgeChild } = await setup();
  const { deleteKnowledgeNode } = await import("../src/services/knowledgeTree.js");
  const { listTrash, restoreTrashItem, permanentlyDeleteTrashItem } = await import("../src/services/trash/trashService.js");
  const folder = createKnowledgeChild({ actorUserId: owner, workspaceId: null, parentId: null, nodeType: "folder", title: "回收", db });
  const node = createKnowledgeChild({ actorUserId: owner, workspaceId: null, parentId: folder.id, nodeType: "excel", title: "回收表", db });
  const data = workbook({ 0: { 0: { f: "=1+1", v: 2, t: 2 } } });
  await app.request(`/api/excels/${node.resourceId}`, { method: "PUT", headers: json(owner), body: JSON.stringify({ data, expectedRevision: 1 }) });

  deleteKnowledgeNode({ actorUserId: owner, nodeId: node.id, mode: "cascade", db });
  assert.equal((await app.request(`/api/excels/${node.resourceId}`, { headers: json(owner) })).status, 404);
  const trashed = listTrash({ userId: owner, workspaceId: null }).find((item) => item.resourceId === node.resourceId);
  assert.ok(trashed);
  restoreTrashItem({ userId: owner, workspaceId: null }, trashed!.id);
  const restored = await (await app.request(`/api/excels/${node.resourceId}`, { headers: json(owner) })).json() as any;
  assert.deepEqual(restored.data, data);
  assert.equal(restored.revision, 2);

  deleteKnowledgeNode({ actorUserId: owner, nodeId: node.id, mode: "cascade", db });
  const again = listTrash({ userId: owner, workspaceId: null }).find((item) => item.resourceId === node.resourceId)!;
  permanentlyDeleteTrashItem({ userId: owner, workspaceId: null }, again.id);
  assert.equal((db.prepare("SELECT count(*) AS count FROM excel_documents WHERE noteId = ?").get(node.resourceId) as any).count, 0);
});

test("分享链接、复制和公开发布对 Excel 明确拒绝或排除，不产生空白副本", async () => {
  const { db, createKnowledgeChild } = await setup();
  const { Hono } = await import("hono");
  const { sharesRouter: shares } = await import("../src/routes/shares.js");
  const { duplicateNote } = await import("../src/services/noteDuplicates.js");
  const { listPublishedKnowledgeResources } = await import("../src/services/notebookPublicationResources.js");
  const folder = createKnowledgeChild({ actorUserId: owner, workspaceId: null, parentId: null, nodeType: "folder", title: "发布", db });
  const node = createKnowledgeChild({ actorUserId: owner, workspaceId: null, parentId: folder.id, nodeType: "excel", title: "公开?", db });

  const app = new Hono().route("/api/shares", shares);
  const share = await app.request("/api/shares", { method: "POST", headers: json(owner), body: JSON.stringify({ noteId: node.resourceId }) });
  assert.equal(share.status, 400);
  assert.equal((await share.json() as any).code, "EXCEL_SHARE_UNSUPPORTED");
  await assert.rejects(() => duplicateNote({ userId: owner, noteId: node.resourceId, placement: "child" } as any), /Excel 表格暂不支持创建副本/);

  const notebookId = (db.prepare("SELECT resourceId FROM knowledge_tree_nodes WHERE id = ?").get(folder.id) as any).resourceId;
  const published = listPublishedKnowledgeResources(db, notebookId);
  assert.equal(published.some((resource) => resource.resourceId === node.resourceId), false);
});
