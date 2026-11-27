import assert from "node:assert/strict";
import test from "node:test";

const owner = "ppt-route-owner";
const viewer = "ppt-route-viewer";

async function setup() {
  await import("../src/runtime/knowledge-tree-migration-bootstrap.js");
  const { Hono } = await import("hono");
  const { getDb } = await import("../src/db/schema.js");
  const workspaces = (await import("../src/routes/workspaces.js")).default;
  const knowledgeTree = (await import("../src/routes/knowledge-tree.js")).default;
  const notes = (await import("../src/routes/notes.js")).default;
  const db = getDb();

  for (const uid of [owner, viewer]) {
    db.prepare("INSERT OR IGNORE INTO users (id, username, passwordHash, isDisabled) VALUES (?, ?, 'hash', 0)").run(uid, uid);
  }

  const app = new Hono();
  app.route("/api/workspaces", workspaces);
  app.route("/api/knowledge-tree", knowledgeTree);
  app.route("/api/notes", notes);
  return { app, db };
}

const headers = (userId: string) => ({
  "X-User-Id": userId,
  "Content-Type": "application/json",
});

test("PPT 演示文稿后端链路：知识树创建、notes 读写、全文索引提取与只读权限拒绝", async () => {
  const { app } = await setup();

  // 创建工作区并加入 viewer
  const wsRes = await app.request("/api/workspaces", {
    method: "POST",
    headers: headers(owner),
    body: JSON.stringify({ name: "PPT 协作空间" }),
  });
  assert.equal(wsRes.status, 201);
  const ws = (await wsRes.json()) as { id: string };

  const addViewer = await app.request(`/api/workspaces/${ws.id}/members`, {
    method: "POST",
    headers: headers(owner),
    body: JSON.stringify({ userId: viewer, role: "viewer" }),
  });
  assert.equal(addViewer.status, 201);

  // 先创建文件夹作为容器
  const folderRes = await app.request(`/api/knowledge-tree/nodes?workspaceId=${ws.id}`, {
    method: "POST",
    headers: headers(owner),
    body: JSON.stringify({ parentId: null, nodeType: "folder", title: "汇报目录" }),
  });
  assert.equal(folderRes.status, 201);
  const folder = (await folderRes.json()) as { id: string; resourceId: string };

  // 拒绝用例：只读 viewer 不能在目录内新建 PPT
  const viewerCreatePpt = await app.request(`/api/knowledge-tree/nodes?workspaceId=${ws.id}`, {
    method: "POST",
    headers: headers(viewer),
    body: JSON.stringify({ parentId: folder.id, nodeType: "ppt", title: "越权演示" }),
  });
  assert.equal(viewerCreatePpt.status, 403);

  // Owner 通过知识树创建 PPT 演示文稿
  const createNodeRes = await app.request(`/api/knowledge-tree/nodes?workspaceId=${ws.id}`, {
    method: "POST",
    headers: headers(owner),
    body: JSON.stringify({ parentId: folder.id, nodeType: "ppt", title: "" }),
  });
  assert.equal(createNodeRes.status, 201);
  const pptNode = (await createNodeRes.json()) as { id: string; resourceId: string; title: string; noteType: string };
  assert.equal(pptNode.title, "无标题 PPT 演示文稿");

  // 读取 note 验证 noteType=ppt 与 contentFormat=ppt-json
  const getRes = await app.request(`/api/notes/${pptNode.resourceId}`, { headers: headers(owner) });
  assert.equal(getRes.status, 200);
  const pptNote = (await getRes.json()) as { id: string; noteType: string; contentFormat: string; version: number };
  assert.equal(pptNote.noteType, "ppt");
  assert.equal(pptNote.contentFormat, "ppt-json");

  // 保存 PPT JSON 正文，验证服务端自动派生全文检索 contentText
  const deckPayload = JSON.stringify({
    version: 1,
    aspectRatio: "16:9",
    theme: "classic-light",
    slides: [
      {
        id: "s1",
        layout: "cover",
        title: "季度产品发布",
        subtitle: "核心亮点一览",
        bullets: [],
        notes: "记得重点强调无障碍特性",
      },
    ],
  });
  const putRes = await app.request(`/api/notes/${pptNote.id}`, {
    method: "PUT",
    headers: headers(owner),
    body: JSON.stringify({ title: "季度产品发布", content: deckPayload, version: pptNote.version }),
  });
  assert.equal(putRes.status, 200);
  const updated = (await putRes.json()) as { contentText: string; noteType: string; version: number };
  assert.equal(updated.noteType, "ppt");
  assert.match(updated.contentText, /季度产品发布/);
  assert.match(updated.contentText, /无障碍特性/);

  // 拒绝用例：只读 viewer 不能修改 PPT
  const viewerPut = await app.request(`/api/notes/${pptNote.id}`, {
    method: "PUT",
    headers: headers(viewer),
    body: JSON.stringify({ title: "篡改标题", content: deckPayload, version: updated.version }),
  });
  assert.equal(viewerPut.status, 403);

  // 直接通过 POST /api/notes 创建 PPT（导入 .pptx 走此接口）
  const directCreateRes = await app.request("/api/notes", {
    method: "POST",
    headers: headers(owner),
    body: JSON.stringify({
      notebookId: folder.resourceId,
      title: "导入的汇报",
      content: deckPayload,
      contentFormat: "ppt-json",
      noteType: "ppt",
    }),
  });
  assert.equal(directCreateRes.status, 201);
  const importedNote = (await directCreateRes.json()) as { noteType: string; contentFormat: string; contentText: string };
  assert.equal(importedNote.noteType, "ppt");
  assert.equal(importedNote.contentFormat, "ppt-json");
  assert.match(importedNote.contentText, /核心亮点一览/);
});
