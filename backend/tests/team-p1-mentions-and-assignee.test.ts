import assert from "node:assert/strict";
import test from "node:test";
import { extractMentionedUsernames } from "../src/services/teamMentions.js";

const owner = "team-p1-owner";
const memberA = "team-p1-alice";
const memberB = "team-p1-bob";
const outsider = "team-p1-outsider";

async function setup() {
  await import("../src/runtime/knowledge-tree-migration-bootstrap.js");
  const { Hono } = await import("hono");
  const { getDb } = await import("../src/db/schema.js");
  const workspaces = (await import("../src/routes/workspaces.js")).default;
  const issues = (await import("../src/routes/workspace-issues.js")).default;
  const tasks = (await import("../src/routes/tasks.js")).default;
  const notifications = (await import("../src/routes/notifications.js")).default;
  const { createNoteCommentWithNotifications } = await import("../src/services/noteCommentManagement.js");
  const { createKnowledgeChild } = await import("../src/services/knowledgeTree.js");

  const db = getDb();
  for (const [uid, username, displayName] of [
    [owner, "owner_p1", "负责人"],
    [memberA, "alice_p1", "爱丽丝"],
    [memberB, "bob_p1", "鲍勃"],
    [outsider, "outsider_p1", "外部人员"],
  ] as const) {
    db.prepare("INSERT OR IGNORE INTO users (id, username, displayName, passwordHash, isDisabled) VALUES (?, ?, ?, 'hash', 0)")
      .run(uid, username, displayName);
  }

  const app = new Hono();
  app.route("/api/workspaces", workspaces);
  app.route("/api/workspace-issues", issues);
  app.route("/api/tasks", tasks);
  app.route("/api/notifications", notifications);

  return { app, db, createNoteCommentWithNotifications, createKnowledgeChild };
}

const headers = (userId: string) => ({
  "X-User-Id": userId,
  "Content-Type": "application/json",
});

test("extractMentionedUsernames 精准提取 @提及 且忽略邮箱地址", () => {
  const names = extractMentionedUsernames("请 @alice_p1 和 @鲍勃 确认方案，联系 test@example.com，再 @alice_p1 一次。");
  assert.deepEqual(names, ["alice_p1", "鲍勃"]);
});

test("团队 P1：议题与笔记评论 @提及精准通知、权限隔离、任务负责人指派与筛选", async () => {
  const { app, db, createNoteCommentWithNotifications, createKnowledgeChild } = await setup();

  // 创建工作区并加入 alice_p1 和 bob_p1
  const wsRes = await app.request("/api/workspaces", {
    method: "POST",
    headers: headers(owner),
    body: JSON.stringify({ name: "P1协作空间" }),
  });
  assert.equal(wsRes.status, 201);
  const ws = (await wsRes.json()) as { id: string };

  for (const uid of [memberA, memberB]) {
    const addRes = await app.request(`/api/workspaces/${ws.id}/members`, {
      method: "POST",
      headers: headers(owner),
      body: JSON.stringify({ userId: uid, role: "editor" }),
    });
    assert.equal(addRes.status, 201);
  }

  // 1. 议题 @提及：alice 被 @ 收到 issue_mentioned，bob 收到普通 issue_created
  const issueRes = await app.request("/api/workspace-issues", {
    method: "POST",
    headers: headers(owner),
    body: JSON.stringify({
      workspaceId: ws.id,
      title: "发布评审",
      content: "请 @alice_p1 确认 Word 导出兼容性",
    }),
  });
  assert.equal(issueRes.status, 201);

  const aliceNotifs = (await (await app.request("/api/notifications", { headers: headers(memberA) })).json()) as { items: Array<{ type: string; resourceType: string }> };
  const bobNotifs = (await (await app.request("/api/notifications", { headers: headers(memberB) })).json()) as { items: Array<{ type: string; resourceType: string }> };
  assert.equal(aliceNotifs.items.some((n) => n.type === "issue_mentioned"), true);
  assert.equal(bobNotifs.items.some((n) => n.type === "issue_created"), true);
  assert.equal(bobNotifs.items.some((n) => n.type === "issue_mentioned"), false);

  // 2. 笔记评论 @提及：有权限成员收到 note_comment_mentioned，无权限外部用户被 @ 不得收到通知
  const folder = createKnowledgeChild({ actorUserId: owner, workspaceId: ws.id, parentId: null, nodeType: "folder", title: "文档", db });
  const noteNode = createKnowledgeChild({ actorUserId: owner, workspaceId: ws.id, parentId: folder.id, nodeType: "note", title: "接口规范", db });

  createNoteCommentWithNotifications({
    id: crypto.randomUUID(),
    noteId: noteNode.resourceId,
    userId: owner,
    content: "请 @bob_p1 和 @outsider_p1 看下这段",
  });

  const bobAfterComment = (await (await app.request("/api/notifications", { headers: headers(memberB) })).json()) as { items: Array<{ type: string; resourceType: string }> };
  const outsiderAfterComment = (await (await app.request("/api/notifications", { headers: headers(outsider) })).json()) as { items: Array<{ type: string; resourceType: string }> };
  assert.equal(bobAfterComment.items.some((n) => n.type === "note_comment_mentioned"), true);
  assert.equal(outsiderAfterComment.items.length, 0);

  // 3. 团队任务负责人：指派工作区成员成功并产生通知；指派外部非成员拒绝(400)；个人任务指派他人拒绝(400)
  const invalidWsAssignee = await app.request(`/api/tasks?workspaceId=${ws.id}`, {
    method: "POST",
    headers: headers(owner),
    body: JSON.stringify({ title: "非法指派", assigneeId: outsider }),
  });
  assert.equal(invalidWsAssignee.status, 400);

  const invalidPersonalAssignee = await app.request("/api/tasks", {
    method: "POST",
    headers: headers(owner),
    body: JSON.stringify({ title: "个人任务指派他人", assigneeId: memberA }),
  });
  assert.equal(invalidPersonalAssignee.status, 400);

  const taskRes = await app.request(`/api/tasks?workspaceId=${ws.id}`, {
    method: "POST",
    headers: headers(owner),
    body: JSON.stringify({ title: "完成无障碍验收", assigneeId: memberA }),
  });
  assert.equal(taskRes.status, 201);
  const createdTask = (await taskRes.json()) as { id: string; assigneeId: string; assigneeName: string };
  assert.equal(createdTask.assigneeId, memberA);
  assert.equal(createdTask.assigneeName, "爱丽丝");

  // 按 assigneeId=me 精准筛选
  const aliceMyTasks = (await (await app.request(`/api/tasks?workspaceId=${ws.id}&assigneeId=me`, { headers: headers(memberA) })).json()) as Array<{ id: string }>;
  const bobMyTasks = (await (await app.request(`/api/tasks?workspaceId=${ws.id}&assigneeId=me`, { headers: headers(memberB) })).json()) as Array<{ id: string }>;
  assert.equal(aliceMyTasks.some((t) => t.id === createdTask.id), true);
  assert.equal(bobMyTasks.some((t) => t.id === createdTask.id), false);

  // alice 收到 task_assigned 实时通知；移出工作区后通知自动不可见
  const aliceAfterTask = (await (await app.request("/api/notifications", { headers: headers(memberA) })).json()) as { items: Array<{ type: string; resourceType: string }> };
  assert.equal(aliceAfterTask.items.some((n) => n.type === "task_assigned" && n.resourceType === "workspace_task"), true);

  await app.request(`/api/workspaces/${ws.id}/members/${memberA}`, { method: "DELETE", headers: headers(owner) });
  const aliceAfterKick = (await (await app.request("/api/notifications", { headers: headers(memberA) })).json()) as { items: Array<{ type: string; resourceType: string }> };
  assert.equal(aliceAfterKick.items.some((n) => n.resourceType === "workspace_task"), false);
});
