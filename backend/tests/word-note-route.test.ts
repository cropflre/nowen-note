import assert from "node:assert/strict";
import test from "node:test";

const owner = "word-note-owner";
const outsider = "word-note-outsider";

async function setup() {
  await import("../src/runtime/knowledge-tree-migration-bootstrap.js");
  const { Hono } = await import("hono");
  const { getDb } = await import("../src/db/schema.js");
  const { createKnowledgeChild } = await import("../src/services/knowledgeTree.js");
  const notes = (await import("../src/routes/notes.js")).default;
  const knowledgeTree = (await import("../src/routes/knowledge-tree.js")).default;
  const db = getDb();
  for (const userId of [owner, outsider]) {
    db.prepare("INSERT OR IGNORE INTO users (id, username, passwordHash) VALUES (?, ?, 'hash')").run(userId, userId);
  }
  const app = new Hono();
  app.route("/api/notes", notes);
  app.route("/api/knowledge-tree", knowledgeTree);
  return { app, db, createKnowledgeChild };
}

const json = (userId: string) => ({ "X-User-Id": userId, "Content-Type": "application/json" });

test("知识树创建 Word 文档后 notes 接口完整返回 noteType=word，且拒绝无权用户读取与修改", async () => {
  const { app, db, createKnowledgeChild } = await setup();
  const folder = createKnowledgeChild({
    actorUserId: owner,
    workspaceId: null,
    parentId: null,
    nodeType: "folder",
    title: "文档目录",
    db,
  });

  const created = await app.request("/api/knowledge-tree/nodes", {
    method: "POST",
    headers: json(owner),
    body: JSON.stringify({ parentId: folder.id, nodeType: "word", title: "需求文档" }),
  });
  assert.equal(created.status, 201);
  const node = (await created.json()) as any;
  assert.equal(node.nodeType, "word");
  assert.equal(node.noteType, "word");

  // 本人读取完整与 slim 接口均返回 noteType=word
  const detail = await app.request(`/api/notes/${node.resourceId}`, { headers: json(owner) });
  assert.equal(detail.status, 200);
  const detailJson = (await detail.json()) as any;
  assert.equal(detailJson.noteType, "word");

  const slim = await app.request(`/api/notes/${node.resourceId}?slim=1`, { headers: json(owner) });
  assert.equal(slim.status, 200);
  assert.equal(((await slim.json()) as any).noteType, "word");

  // 列表接口也透传 noteType=word
  const listRes = await app.request(`/api/notes?notebookId=${folder.resourceId}`, { headers: json(owner) });
  assert.equal(listRes.status, 200);
  const listJson = (await listRes.json()) as any[];
  const listed = listJson.find((item) => item.id === node.resourceId);
  assert.equal(listed?.noteType, "word");

  // 更新内容后仍保持 noteType=word
  const updatedContent = JSON.stringify({
    type: "doc",
    content: [
      { type: "wordPageSetup", attrs: { paperSize: "A4", orientation: "portrait", marginTop: 72, marginRight: 72, marginBottom: 72, marginLeft: 72, headerText: "页眉", footerText: "页脚" } },
      { type: "paragraph", content: [{ type: "text", text: "正文测试" }] },
    ],
  });
  const putRes = await app.request(`/api/notes/${node.resourceId}`, {
    method: "PUT",
    headers: json(owner),
    body: JSON.stringify({ title: "需求文档 v2", content: updatedContent, version: detailJson.version }),
  });
  assert.equal(putRes.status, 200);
  const putJson = (await putRes.json()) as any;
  assert.equal(putJson.noteType, "word");

  // 越权拒绝用例：非本人无法读取与修改
  const deniedGet = await app.request(`/api/notes/${node.resourceId}`, { headers: json(outsider) });
  assert.equal(deniedGet.status, 404);

  const deniedPut = await app.request(`/api/notes/${node.resourceId}`, {
    method: "PUT",
    headers: json(outsider),
    body: JSON.stringify({ title: "恶意篡改", content: "{}", version: putJson.version }),
  });
  assert.ok(deniedPut.status === 403 || deniedPut.status === 404);
});
