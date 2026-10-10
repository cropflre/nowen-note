import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Hono } from "hono";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-note-comments-"));
process.env.DB_PATH = path.join(directory, "comments.db");
process.env.JWT_SECRET = "note-comments-regression-secret";
let closeDatabase: (() => void) | undefined;
test.after(() => { closeDatabase?.(); fs.rmSync(directory, { recursive: true, force: true }); });

test("笔记评论管理与通知闭环", async (t) => {
  const { getDb, closeDb } = await import("../src/db/schema.js");
  const { sharesRouter, sharedRouter } = await import("../src/routes/shares.js");
  const { default: notifications } = await import("../src/routes/notifications.js");
  closeDatabase = closeDb;
  const db = getDb();
  const app = new Hono();
  app.route("/shares", sharesRouter); app.route("/shared", sharedRouter); app.route("/notifications", notifications);
  for (const id of ["owner", "author", "other", "viewer", "outsider", "disabled", "manager"]) {
    db.prepare("INSERT INTO users (id, username, passwordHash, isDisabled) VALUES (?, ?, 'hash', ?)").run(id, id, id === "disabled" ? 1 : 0);
  }
  db.prepare("INSERT INTO workspaces (id, name, ownerId) VALUES ('team', '团队', 'owner')").run();
  for (const [user, role] of [["owner", "owner"], ["manager", "admin"], ["author", "commenter"], ["other", "commenter"], ["viewer", "viewer"], ["disabled", "commenter"]]) {
    db.prepare("INSERT INTO workspace_members (workspaceId, userId, role) VALUES ('team', ?, ?)").run(user, role);
  }
  db.prepare("INSERT INTO notebooks (id, userId, name, workspaceId) VALUES ('personal-book','owner','个人',NULL), ('team-book','owner','团队','team'), ('foreign-book','outsider','他人',NULL)").run();
  db.prepare(`INSERT INTO notes (id, userId, notebookId, title, content, workspaceId, isTrashed) VALUES
    ('personal','owner','personal-book','个人文档','',NULL,0), ('team-note','owner','team-book','团队文档','','team',0),
    ('foreign','outsider','foreign-book','不可见文档','',NULL,0), ('trashed','owner','personal-book','回收站','',NULL,1)`).run();
  db.prepare("INSERT INTO shares (id, noteId, ownerId, shareToken, permission) VALUES ('personal-share','personal','owner','personal-token','comment')").run();
  const call = async (url: string, user = "owner", method = "GET", body?: unknown, extraHeaders: Record<string, string> = {}) => {
    const response = await app.request(`http://localhost${url}`, {
      method, headers: { "X-User-Id": user, "Content-Type": "application/json", ...extraHeaders },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, data: response.headers.get("content-type")?.includes("application/json") ? JSON.parse(text) : text };
  };
  const create = (note: string, user: string, content: string, parentId?: string) => call(`/shares/note/${note}/comments`, user, "POST", { content, parentId });
  const notices = async (user: string) => (await call("/notifications", user)).data;
  let rootId = ""; let replyId = ""; let guestId = "";

  await t.test("新评论提醒所有者，回复提醒作者，重合接收者去重且排除自己", async () => {
    const first = await create("team-note", "author", "首条评论");
    assert.equal(first.status, 201); rootId = first.data.id;
    const before = await notices("owner");
    assert.equal(before.unreadCount, 1); assert.equal(before.items[0].type, "note_commented");
    assert.equal(before.items[0].noteId, "team-note"); assert.equal(before.items[0].commentId, rootId);
    assert.equal((await notices("author")).total, 0);
    const reply = await create("team-note", "other", "回复内容", rootId);
    assert.equal(reply.status, 201); replyId = reply.data.id;
    assert.equal((await notices("owner")).total, 2);
    assert.equal((await notices("author")).items[0].type, "note_comment_replied");
    assert.equal((await notices("other")).total, 0);
    const ownerRoot = (await create("team-note", "owner", "所有者发言")).data.id;
    const count = (await notices("owner")).total;
    await create("team-note", "other", "回复所有者", ownerRoot);
    assert.equal((await notices("owner")).total, count + 1);
    const total = (db.prepare("SELECT COUNT(*) AS n FROM notifications").get() as { n: number }).n;
    await create("team-note", "owner", "无需提醒自己");
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM notifications").get() as { n: number }).n, total);
  });

  await t.test("访客评论产生个人空间提醒，不暴露 IP 哈希，跨笔记父评论被拒绝", async () => {
    const guest = await call("/shared/personal-token/comments", "", "POST", { guestName: "访客甲", content: "访客留言" });
    assert.equal(guest.status, 201); guestId = guest.data.id;
    const notification = (await notices("owner")).items.find((item: { commentId: string }) => item.commentId === guestId);
    assert.equal(notification.workspaceId, null); assert.equal(notification.actorName, "访客甲");
    assert.equal(notification.resourceType, "note_comment");
    assert.equal((await call("/shared/personal-token/comments", "", "POST", { guestName: "访客", content: "跨笔记回复", parentId: rootId })).status, 400);
    const list = await call("/shares/comments?q=访客留言");
    assert.equal(list.data.total, 1); assert.equal(list.data.items[0].displayName, "访客甲");
    assert.equal(Object.hasOwn(list.data.items[0], "guestIpHash"), false);
  });

  await t.test("评论中心按管理权限、状态和关键词分页，查看者不能管理", async () => {
    await create("foreign", "outsider", "他人私有评论");
    db.prepare("INSERT INTO share_comments (id,noteId,userId,content) VALUES ('trash-comment','trashed','owner','回收站评论')").run();
    const owner = await call("/shares/comments?limit=2&offset=0");
    assert.equal(owner.status, 200); assert.equal(owner.data.items.length, 2);
    assert.ok(owner.data.items.every((item: { noteId: string }) => !["foreign", "trashed"].includes(item.noteId)));
    assert.equal((await call("/shares/comments", "viewer")).data.total, 0);
    const manager = await call("/shares/comments", "manager");
    assert.ok(manager.data.items.length > 0); assert.ok(manager.data.items.every((item: { noteId: string }) => item.noteId === "team-note"));
    assert.equal((await call("/shares/comments?offset=-1")).status, 400);
    assert.equal((await call("/shares/comments?status=deleted")).status, 400);
    assert.equal((await call("/shares/comments", "")).status, 401);
    assert.equal((await call("/shares/comments", "owner", "GET", undefined, { "X-Auth-Mode": "api-token" })).status, 403);
    assert.equal((await call(`/shares/note/team-note/comments/${rootId}/resolve`, "viewer", "PATCH")).status, 403);
    assert.equal((await call(`/shares/note/team-note/comments/${rootId}/resolve`, "manager", "PATCH")).status, 200);
    const resolved = await call("/shares/comments?status=resolved&q=首条评论");
    assert.equal(resolved.data.total, 1); assert.equal(resolved.data.items[0].id, rootId);
    assert.equal((await call("/shares/comments?status=unresolved&q=首条评论")).data.total, 0);
    assert.equal((await call(`/shares/note/team-note/comments/${rootId}/resolve`, "owner", "PATCH")).status, 200);
  });

  await t.test("权限撤销后提醒隐藏、不能读取或标已读，禁用接收者不收到新通知", async () => {
    const notification = (await notices("author")).items.find((item: { commentId: string }) => item.commentId === replyId);
    db.prepare("DELETE FROM workspace_members WHERE workspaceId='team' AND userId='author'").run();
    assert.equal((await notices("author")).total, 0);
    assert.equal((await call(`/notifications/${notification.id}/read`, "author", "POST")).status, 404);
    assert.equal((await call(`/shares/note/team-note/comments/${rootId}`, "author", "DELETE")).status, 403);
    await call("/notifications/read-all", "author", "POST");
    assert.equal((db.prepare("SELECT readAt FROM notifications WHERE id=?").get(notification.id) as { readAt: string | null }).readAt, null);
    db.prepare("INSERT INTO workspace_members (workspaceId,userId,role) VALUES ('team','author','commenter')").run();
    db.prepare("INSERT INTO share_comments (id,noteId,userId,content) VALUES ('disabled-comment','team-note','disabled','禁用用户的旧评论')").run();
    assert.equal((await create("team-note", "other", "不提醒禁用用户", "disabled-comment")).status, 201);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE userId='disabled'").get() as { n: number }).n, 0);
  });

  await t.test("本人已读、全部已读和删除/回收站后的计数一致", async () => {
    const all = await notices("owner");
    assert.equal((await call(`/notifications/${all.items[0].id}/read`, "outsider", "POST")).status, 404);
    await call(`/notifications/${all.items[0].id}/read`, "owner", "POST");
    assert.equal((await notices("owner")).unreadCount, all.unreadCount - 1);
    await call("/notifications/read-all", "owner", "POST");
    assert.equal((await notices("owner")).unreadCount, 0);
    assert.equal((await call(`/shares/note/personal/comments/${guestId}`, "outsider", "DELETE")).status, 403);
    assert.equal((await call(`/shares/note/personal/comments/${guestId}`, "owner", "DELETE")).status, 200);
    assert.ok(!(await notices("owner")).items.some((item: { commentId: string }) => item.commentId === guestId));
    db.prepare("UPDATE notes SET isTrashed=1 WHERE id='team-note'").run();
    assert.equal((await notices("owner")).total, 0);
    assert.equal((await call("/shares/comments")).data.total, 0);
    db.prepare("UPDATE notes SET isTrashed=0 WHERE id='team-note'").run();
  });

  await t.test("目录密码锁定隐藏评论和提醒，有效解锁令牌恢复访问", async () => {
    const { signFolderUnlockToken } = await import("../src/lib/knowledgeTreePasswordAccess.js");
    const folder = db.prepare("SELECT id FROM knowledge_tree_nodes WHERE resourceType='notebook' AND resourceId='team-book'").get() as { id: string };
    const noteNode = db.prepare("SELECT parentId FROM knowledge_tree_nodes WHERE resourceType='note' AND resourceId='team-note'").get() as { parentId: string };
    assert.equal(noteNode.parentId, folder.id);
    db.prepare("INSERT INTO notebook_passwords (notebookId,passwordHash,passwordVersion) VALUES ('team-book','hash',1)").run();
    try {
      assert.equal((await call("/shares/comments")).data.total, 0);
      assert.equal((await notices("owner")).total, 0);
      assert.equal((await call("/shares/note/team-note/comments")).status, 403);
      assert.equal((await call(`/shares/note/team-note/comments/${rootId}/resolve`, "owner", "PATCH")).status, 403);
      const token = signFolderUnlockToken({ userId: "owner", nodeId: folder.id, notebookId: "team-book", passwordVersion: 1 });
      const headers = { "X-Folder-Unlock-Tokens": token };
      assert.ok((await call("/shares/comments", "owner", "GET", undefined, headers)).data.total > 0);
      assert.ok((await call("/notifications", "owner", "GET", undefined, headers)).data.total > 0);
      assert.equal((await call("/shares/note/team-note/comments", "owner", "GET", undefined, headers)).status, 200);
      assert.equal((await call("/shares/comments", "other", "GET", undefined, headers)).data.total, 0);
    } finally { db.prepare("DELETE FROM notebook_passwords WHERE notebookId='team-book'").run(); }
  });

  await t.test("通知写入失败时评论与通知一起回滚", async () => {
    const count = () => (db.prepare("SELECT COUNT(*) AS n FROM share_comments").get() as { n: number }).n;
    const before = count();
    db.exec("CREATE TRIGGER fail_note_notification BEFORE INSERT ON notifications BEGIN SELECT RAISE(ABORT, 'notification failure'); END;");
    try { assert.equal((await create("team-note", "other", "事务必须回滚")).status, 500); }
    finally { db.exec("DROP TRIGGER fail_note_notification"); }
    assert.equal(count(), before);
  });
});

test("通知迁移保留议题、已读状态、索引和外键，允许个人空间且幂等", async () => {
  const { default: Database } = await import("better-sqlite3");
  const { workspaceIssuesMigration } = await import("../src/db/workspaceIssuesMigration.js");
  const { noteCommentNotificationsMigration } = await import("../src/db/noteCommentNotificationsMigration.js");
  const db = new Database(":memory:");
  try {
    db.pragma("foreign_keys=ON");
    db.exec("CREATE TABLE users(id TEXT PRIMARY KEY); CREATE TABLE workspaces(id TEXT PRIMARY KEY); CREATE TABLE notes(id TEXT PRIMARY KEY); INSERT INTO users VALUES('user'); INSERT INTO workspaces VALUES('team');");
    workspaceIssuesMigration.up(db);
    db.prepare("INSERT INTO notifications(id,userId,workspaceId,type,resourceType,resourceId,title,readAt,createdAt) VALUES('old','user','team','issue_created','workspace_issue','issue','标题','read','created')").run();
    const before = db.prepare("SELECT * FROM notifications").all();
    db.transaction(() => noteCommentNotificationsMigration.up(db))();
    noteCommentNotificationsMigration.up(db);
    assert.deepEqual(db.prepare("SELECT * FROM notifications").all(), before);
    db.prepare("INSERT INTO notifications(id,userId,workspaceId,type,resourceType,resourceId,title,createdAt) VALUES('personal','user',NULL,'note_commented','note_comment','comment','笔记','created')").run();
    assert.deepEqual(db.pragma("foreign_key_check"), []);
    const pg = fs.readFileSync(new URL("../src/db/postgres/migrations/0116-note-comment-notifications.sql", import.meta.url), "utf8");
    assert.match(pg, /ALTER COLUMN "workspaceId" DROP NOT NULL/);
  } finally { db.close(); }
});
