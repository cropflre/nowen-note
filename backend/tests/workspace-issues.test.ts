import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-workspace-issues-"));
process.env.DB_PATH = path.join(tempDir, "issues.db");
let closeDatabase: (() => void) | undefined;
test.after(() => {
  closeDatabase?.();
  fs.rmSync(tempDir, { recursive: true, force: true });
  delete process.env.DB_PATH;
});

test("工作区议题、回复和通知闭环", async (t) => {
  await import("../src/runtime/knowledge-tree-migration-bootstrap.js");
  const { getDb, closeDb } = await import("../src/db/schema.js");
  const { default: issues } = await import("../src/routes/workspace-issues.js");
  const { default: notifications } = await import("../src/routes/notifications.js");
  const { workspaceIssuesMigration } = await import("../src/db/workspaceIssuesMigration.js");
  closeDatabase = closeDb;
  const db = getDb();
  workspaceIssuesMigration.up(db);
  workspaceIssuesMigration.up(db);
  for (const id of ["owner", "admin", "editor", "commenter", "viewer", "outsider", "disabled"]) {
    db.prepare("INSERT INTO users (id, username, passwordHash, role, isDisabled) VALUES (?, ?, 'hash', 'user', ?)").run(id, id, id === "disabled" ? 1 : 0);
  }
  db.prepare("INSERT INTO workspaces (id, name, ownerId) VALUES ('team', '团队', 'owner'), ('other', '其他团队', 'outsider')").run();
  for (const role of ["owner", "admin", "editor", "commenter", "viewer"]) {
    db.prepare("INSERT INTO workspace_members (workspaceId, userId, role) VALUES ('team', ?, ?)").run(role, role);
  }
  db.prepare("INSERT INTO workspace_members (workspaceId, userId, role) VALUES ('team', 'disabled', 'viewer'), ('other', 'outsider', 'owner')").run();

  const call = (url: string, user = "editor", method = "GET", body?: unknown) => issues.request(new Request(`http://localhost${url}`, {
    method, headers: { "X-User-Id": user, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
  }));
  const notify = (url = "/", user = "owner", method = "GET") => notifications.request(new Request(`http://localhost${url}`, {
    method, headers: { "X-User-Id": user },
  }));
  let issueId = "";
  let commentId = "";

  await t.test("成员创建议题，通知其他成员但不通知自己、外部用户或禁用账号", async () => {
    const response = await call("/", "editor", "POST", { workspaceId: "team", title: "移动端体验", content: "一起讨论改进方案" });
    assert.equal(response.status, 201);
    const issue = await response.json();
    issueId = issue.id;
    assert.equal(issue.number, 1);
    assert.equal(issue.status, "open");
    assert.equal((await call(`/${issueId}`)).status, 200);
    for (const user of ["owner", "admin", "commenter", "viewer"]) {
      const result = await (await notify("/", user)).json();
      assert.equal(result.unreadCount, 1);
      assert.equal(result.items[0].resourceId, issueId);
      assert.equal(result.items[0].actorName, "editor");
    }
    for (const user of ["editor", "outsider", "disabled"]) assert.equal((await (await notify("/", user)).json()).total, 0);
  });

  await t.test("查看、创建、回复和关闭按成员角色限制，外部用户不能越权", async () => {
    assert.equal((await call("/?workspaceId=team", "outsider")).status, 403);
    assert.equal((await call(`/${issueId}`, "outsider")).status, 403);
    assert.equal((await call(`/${issueId}/activity`, "outsider")).status, 403);
    assert.equal((await call("/", "viewer", "POST", { workspaceId: "team", title: "拒绝" })).status, 403);
    assert.equal((await call(`/${issueId}/comments`, "viewer", "POST", { content: "拒绝" })).status, 403);
    assert.equal((await call(`/${issueId}`, "viewer", "PATCH", { status: "closed" })).status, 403);
    assert.equal((await call(`/${issueId}`, "commenter", "PATCH", { status: "closed" })).status, 403);
    assert.equal((await call("/?workspaceId=team", "viewer")).status, 200);
    assert.equal((await call("/?workspaceId=team", "")).status, 401);
    for (const router of [issues, notifications]) {
      const response = await router.request(new Request("http://localhost/", { headers: { "X-User-Id": "owner", "X-Auth-Mode": "api-token" } }));
      assert.equal(response.status, 403);
    }
  });

  await t.test("评论有计数，可编辑删除自己的回复，父评论必须属于同一议题", async () => {
    const response = await call(`/${issueId}/comments`, "commenter", "POST", { content: "建议缩小工具栏" });
    assert.equal(response.status, 201);
    commentId = (await response.json()).id;
    assert.equal((await (await call(`/${issueId}`)).json()).commentCount, 1);
    assert.equal((await call(`/${issueId}/comments/${commentId}`, "editor", "PATCH", { content: "越权" })).status, 403);
    assert.equal((await call(`/${issueId}/comments/${commentId}`, "owner", "DELETE")).status, 403);
    assert.equal((await call(`/${issueId}/comments/${commentId}`, "commenter", "PATCH", { content: "修改后的方案" })).status, 200);
    const other = await (await call("/", "editor", "POST", { workspaceId: "team", title: "另外一个议题" })).json();
    assert.equal((await call(`/${other.id}/comments`, "editor", "POST", { parentId: commentId, content: "跨议题" })).status, 400);
    assert.equal((await call(`/${other.id}/comments/${commentId}`, "commenter", "DELETE")).status, 404);
    assert.equal((await call(`/${issueId}/comments`, "editor", "POST", { parentId: commentId, content: "同意" })).status, 201);
    const timeline = await (await call(`/${issueId}/activity`)).json();
    assert.equal(timeline.items[0].content, "修改后的方案");
    assert.equal(timeline.items[0].canEdit, false);
    assert.equal(timeline.items[1].canEdit, true);
  });

  await t.test("关闭与重开保留原件、回复和状态历史，重复状态请求不重复通知", async () => {
    assert.equal((await call(`/${issueId}`, "admin", "PATCH", { status: "closed" })).status, 200);
    const closed = await (await call(`/${issueId}`)).json();
    assert.equal(closed.closedBy, "admin");
    assert.ok(closed.closedAt);
    assert.equal(closed.commentCount, 2);
    const before = db.prepare("SELECT COUNT(*) AS n FROM notifications").get() as { n: number };
    assert.equal((await call(`/${issueId}`, "admin", "PATCH", { status: "closed" })).status, 200);
    assert.deepEqual(db.prepare("SELECT COUNT(*) AS n FROM notifications").get(), before);
    assert.equal((await call(`/${issueId}`, "editor", "PATCH", { status: "open" })).status, 200);
    const reopened = await (await call(`/${issueId}`)).json();
    assert.equal(reopened.closedBy, null);
    assert.equal(reopened.closedAt, null);
    const timeline = await (await call(`/${issueId}/activity`)).json();
    assert.deepEqual(timeline.items.filter((item: { type: string }) => item.type !== "comment").map((item: { type: string }) => item.type), ["closed", "reopened"]);
    const own = await (await call("/", "commenter", "POST", { workspaceId: "team", title: "我的议题" })).json();
    assert.equal((await call(`/${own.id}`, "commenter", "PATCH", { status: "closed", title: "修改标题" })).status, 200);
    assert.equal((await call(`/${own.id}`, "editor", "PATCH", { title: "其他编辑者" })).status, 403);
    assert.equal((await call(`/${own.id}`, "editor", "PATCH", { status: "open" })).status, 200);
  });

  await t.test("通知的单条和全部已读仅影响本人，退出工作区后立即隐藏", async () => {
    const result = await (await notify()).json();
    assert.ok(result.unreadCount > 0);
    const id = result.items[0].id;
    assert.equal((await notify(`/${id}/read`, "editor", "POST")).status, 404);
    assert.equal((await notify(`/${id}/read`, "owner", "POST")).status, 200);
    assert.equal((await (await notify("/?unread=true")).json()).total, result.unreadCount - 1);
    assert.equal((await notify("/read-all", "owner", "POST")).status, 200);
    assert.equal((await (await notify()).json()).unreadCount, 0);
    assert.ok((await (await notify("/", "admin")).json()).unreadCount > 0);
    db.prepare("DELETE FROM workspace_members WHERE workspaceId = 'team' AND userId = 'viewer'").run();
    assert.equal((await (await notify("/", "viewer")).json()).total, 0);
    assert.equal((await call(`/${issueId}`, "viewer")).status, 403);
    assert.equal((await notify("/", "")).status, 401);
  });

  await t.test("正文校验和分页过滤，编号在并发请求中唯一且按工作区隔离", async () => {
    for (const title of ["", 123, "x".repeat(201)]) assert.equal((await call("/", "editor", "POST", { workspaceId: "team", title })).status, 400);
    assert.equal((await call(`/${issueId}`, "editor", "PATCH", { status: "deleted" })).status, 400);
    assert.equal((await call("/?workspaceId=team&limit=-1")).status, 400);
    assert.equal((await call("/?workspaceId=team&offset=0.5")).status, 400);
    assert.equal((await call("/?workspaceId=team&status=deleted")).status, 400);
    const responses = await Promise.all(Array.from({ length: 8 }, (_, index) => call("/", "editor", "POST", { workspaceId: "team", title: `并发 ${index}` })));
    const rows = await Promise.all(responses.map((response) => response.json()));
    assert.equal(new Set(rows.map((row) => row.number)).size, 8);
    const other = await (await call("/", "outsider", "POST", { workspaceId: "other", title: "其他团队" })).json();
    assert.equal(other.number, 1);
    const list = await (await call("/?workspaceId=team&status=open&limit=2&offset=1")).json();
    assert.equal(list.items.length, 2);
    assert.ok(list.items.every((row: { status: string; workspaceId: string }) => row.status === "open" && row.workspaceId === "team"));
  });

  await t.test("关联笔记必须属于当前工作区且可读，不能借议题泄露受限笔记", async () => {
    db.prepare("INSERT INTO notebooks (id, userId, name, workspaceId) VALUES ('team-book', 'owner', '团队笔记本', 'team'), ('private-book', 'owner', '私人笔记本', NULL)").run();
    db.prepare("INSERT INTO notes (id, userId, notebookId, title, content, workspaceId) VALUES ('linked', 'owner', 'team-book', '关联文档', '', 'team'), ('private', 'owner', 'private-book', '私人文档', '', NULL)").run();
    const created = await (await call("/", "owner", "POST", { workspaceId: "team", title: "文档讨论", relatedNoteId: "linked" })).json();
    assert.equal(created.relatedNote.id, "linked");
    assert.equal((await call("/", "editor", "POST", { workspaceId: "team", title: "泄露", relatedNoteId: "private" })).status, 403);
    db.prepare("UPDATE notes SET isTrashed = 1 WHERE id = 'linked'").run();
    const detail = await (await call(`/${created.id}`)).json();
    assert.equal(detail.relatedNoteId, null);
    assert.equal(detail.relatedNote, null);
    db.prepare("DELETE FROM notes WHERE id = 'linked'").run();
    assert.equal((db.prepare("SELECT relatedNoteId FROM workspace_issues WHERE id = ?").get(created.id) as { relatedNoteId: string | null }).relatedNoteId, null);
    const { createKnowledgeChild } = await import("../src/services/knowledgeTree.js");
    const { setKnowledgeNodeRole } = await import("../src/services/knowledgeCapabilities.js");
    const restricted = createKnowledgeChild({ actorUserId: "owner", workspaceId: "team", parentId: null, nodeType: "note", title: "受限笔记", db });
    setKnowledgeNodeRole({ nodeId: restricted.id, targetUserId: "editor", rolePreset: "readonly", actorUserId: "owner", db });
    const linked = await (await call("/", "owner", "POST", { workspaceId: "team", title: "受限文档讨论", relatedNoteId: restricted.resourceId })).json();
    assert.equal((await (await call(`/${linked.id}`, "editor")).json()).relatedNoteId, restricted.resourceId);
    const denied = await (await call(`/${linked.id}`, "commenter")).json();
    assert.equal(denied.relatedNoteId, null);
    assert.equal(denied.relatedNote, null);
    assert.equal((await call("/", "commenter", "POST", { workspaceId: "team", title: "无权关联", relatedNoteId: restricted.resourceId })).status, 403);
  });

  await t.test("删除自己的评论不删除子回复，通知失败时创建整体回滚", async () => {
    assert.equal((await call(`/${issueId}/comments/${commentId}`, "commenter", "DELETE")).status, 200);
    const timeline = await (await call(`/${issueId}/activity`)).json();
    const comment = timeline.items.find((item: { type: string }) => item.type === "comment");
    assert.equal(comment.parentId, null);
    assert.equal((await (await call(`/${issueId}`)).json()).commentCount, 1);
    db.exec("CREATE TRIGGER fail_issue_notification BEFORE INSERT ON notifications BEGIN SELECT RAISE(ABORT, 'test notification failure'); END;");
    const before = db.prepare("SELECT COUNT(*) AS n FROM workspace_issues").get();
    assert.equal((await call("/", "editor", "POST", { workspaceId: "team", title: "需要回滚" })).status, 500);
    assert.deepEqual(db.prepare("SELECT COUNT(*) AS n FROM workspace_issues").get(), before);
    db.exec("DROP TRIGGER fail_issue_notification");
  });

  await t.test("工作区删除级联清理议题、评论、状态和通知，PostgreSQL 重放入口登记一致", async () => {
    const pg = fs.readFileSync(new URL("../src/db/postgres/migrations/0114-workspace-issues.sql", import.meta.url), "utf8");
    for (const table of ["workspace_issues", "workspace_issue_comments", "workspace_issue_events", "notifications"]) assert.match(pg, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
    assert.match(pg, /UNIQUE\("workspaceId", number\)/);
    assert.match(pg, /"relatedNoteId" TEXT REFERENCES notes\(id\) ON DELETE SET NULL/);
    assert.match(fs.readFileSync(new URL("../src/db/postgres/schema.sql", import.meta.url), "utf8"), /\\ir migrations\/0114-workspace-issues.sql/);
    db.prepare("DELETE FROM workspaces WHERE id = 'team'").run();
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM workspace_issue_comments").get() as { n: number }).n, 0);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM workspace_issue_events").get() as { n: number }).n, 0);
    assert.equal((await (await notify()).json()).total, 0);
  });
});
