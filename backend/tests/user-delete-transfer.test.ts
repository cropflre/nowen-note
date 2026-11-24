import "./setup-db-isolation";
import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { Hono } from "hono";

import { closeDb, getDb } from "../src/db/schema";
import { installNotebookTreeIntegrityGuards } from "../src/runtime/notebook-tree-hardening";
import users from "../src/routes/users";
import { signSudoToken } from "../src/lib/auth-security";

/**
 * 删除用户并把数据转移给另一个用户（DELETE /api/users/:id?transferTo=）。
 *
 * 转移必须真正可用：带嵌套/回收站笔记本的普通用户也能转移成功；挂在已转移内容上的
 * 数据（知识树、说说与任务附件、任务项目/标签/提醒、思维导图、表格、模板、分享链接、
 * 工作区日记）随之转给接收人；登录会话、习惯等个人数据仍随账号删除。
 */

const ADMIN = "transfer-admin";
const FROM = "transfer-from";
const TO = "transfer-to";
const GUARDS = ["notebooks_parent_guard_update", "notebooks_scope_guard_update", "knowledge_tree_parent_scope_guard_update"];

after(() => closeDb());

const db = () => getDb();
const one = <T = Record<string, unknown>>(sql: string, ...params: unknown[]) => db().prepare(sql).get(...params) as T | undefined;
const count = (sql: string, ...params: unknown[]) => (db().prepare(sql).get(...params) as { c: number }).c;

function app(actor = ADMIN) {
  const instance = new Hono();
  instance.use("*", async (c, next) => { c.req.raw.headers.set("X-User-Id", actor); return next(); });
  instance.route("/api/users", users);
  return instance;
}

function transfer(actor = ADMIN) {
  return app(actor).request(`/api/users/${FROM}?transferTo=${TO}`, {
    method: "DELETE",
    headers: { "X-Sudo-Token": signSudoToken(actor, 0) },
  });
}

beforeEach(() => {
  installNotebookTreeIntegrityGuards(db());
  db().pragma("foreign_keys = OFF");
  db().exec(`
    DROP TRIGGER IF EXISTS transfer_test_injected_failure;
    DELETE FROM users;
  `);
  for (const table of ["notebooks", "notes", "knowledge_tree_nodes", "diaries", "diary_attachments", "tasks", "task_projects",
    "task_labels", "task_label_links", "task_attachments", "task_reminders", "task_recurrence_state", "mindmaps", "mindmap_folders",
    "sheets", "note_templates", "note_template_attachments", "notebook_share_links", "workspaces", "workspace_members",
    "workspace_journals", "habits", "user_sessions"]) {
    db().exec(`DELETE FROM ${table}`);
  }
  db().pragma("foreign_keys = ON");
  for (const [id, role] of [[ADMIN, "admin"], [FROM, "user"], [TO, "user"]]) {
    db().prepare("INSERT INTO users(id, username, passwordHash, role) VALUES (?, ?, 'x', ?)").run(id, id, role);
  }
  db().exec(`
    INSERT INTO notebooks(id, userId, name) VALUES ('nb-root', '${FROM}', '资料');
    INSERT INTO notebooks(id, userId, name, parentId) VALUES ('nb-child', '${FROM}', '合同', 'nb-root');
    INSERT INTO notebooks(id, userId, name) VALUES ('nb-trash', '${FROM}', '旧项目');
    INSERT INTO notebooks(id, userId, name, parentId) VALUES ('nb-trash-child', '${FROM}', '旧项目子目录', 'nb-trash');
    UPDATE notebooks SET isDeleted = 1, deletedAt = datetime('now') WHERE id IN ('nb-trash-child', 'nb-trash');
    INSERT INTO notes(id, userId, notebookId, title) VALUES ('note-1', '${FROM}', 'nb-child', '续签合同');
    INSERT INTO notes(id, userId, notebookId, title, note_type, journal_date) VALUES ('journal-from', '${FROM}', 'nb-root', '11 月 18 日', 'journal', '2026-11-18');
    INSERT INTO notebooks(id, userId, name) VALUES ('nb-to', '${TO}', '接收人笔记本');
    INSERT INTO notes(id, userId, notebookId, title, note_type, journal_date) VALUES ('journal-to', '${TO}', 'nb-to', '接收人 11 月 18 日', 'journal', '2026-11-18');

    INSERT INTO diaries(id, userId, contentText, images, media) VALUES ('diary-1', '${FROM}', '现场照片', '["dm-1"]', '[{"id":"dm-1","type":"image"}]');
    INSERT INTO diary_attachments(id, diaryId, userId, mimeType, size, path) VALUES ('dm-1', 'diary-1', '${FROM}', 'image/png', 1, 'dm-1.png');

    INSERT INTO task_projects(id, userId, name) VALUES ('project-1', '${FROM}', '交接项目');
    INSERT INTO tasks(id, userId, title, projectId) VALUES ('task-1', '${FROM}', '续签', 'project-1');
    INSERT INTO task_labels(id, userId, scopeKey, name, normalizedName) VALUES ('label-from', '${FROM}', 'personal:${FROM}', '紧急', '紧急');
    INSERT INTO task_labels(id, userId, scopeKey, name, normalizedName) VALUES ('label-only', '${FROM}', 'personal:${FROM}', '合同', '合同');
    INSERT INTO task_labels(id, userId, scopeKey, name, normalizedName) VALUES ('label-to', '${TO}', 'personal:${TO}', '紧急', '紧急');
    INSERT INTO task_label_links(taskId, labelId) VALUES ('task-1', 'label-from'), ('task-1', 'label-only');
    INSERT INTO task_attachments(id, taskId, userId, filename, mimeType, size, path) VALUES ('ta-1', 'task-1', '${FROM}', '合同.pdf', 'application/pdf', 1, 'ta-1.pdf');
    INSERT INTO task_reminders(id, taskId, userId) VALUES ('reminder-1', 'task-1', '${FROM}');
    INSERT INTO task_recurrence_state(groupId, scopeKey, action, updatedAt) VALUES ('task-1', 'personal:${FROM}', 'stop', datetime('now'));

    INSERT INTO mindmap_folders(id, userId, name) VALUES ('mf-1', '${FROM}', '规划');
    INSERT INTO mindmaps(id, userId, title, data, folderId) VALUES ('mm-1', '${FROM}', '架构图', '{}', 'mf-1');
    INSERT INTO sheets(noteId, userId, data) VALUES ('note-1', '${FROM}', '{}');
    INSERT INTO note_templates(id, createdBy, name, contentFormat) VALUES ('tpl-1', '${FROM}', '周报模板', 'markdown');
    INSERT INTO note_template_attachments(id, templateId, filename, mimeType, size, path) VALUES ('tpl-att-1', 'tpl-1', 'logo.png', 'image/png', 1, 'tpl.png');
    INSERT INTO notebook_share_links(id, notebookId, token, createdBy) VALUES ('link-1', 'nb-root', 'share-token-1', '${FROM}');

    INSERT INTO workspaces(id, name, ownerId) VALUES ('ws-1', '团队', '${ADMIN}');
    INSERT INTO workspace_members(workspaceId, userId, role) VALUES ('ws-1', '${FROM}', 'editor');
    INSERT INTO notebooks(id, userId, name, workspaceId) VALUES ('nb-ws', '${FROM}', '团队日记', 'ws-1');
    INSERT INTO notes(id, userId, notebookId, title, workspaceId) VALUES ('ws-journal-note', '${FROM}', 'nb-ws', '团队日记 11-18', 'ws-1');
    INSERT INTO workspace_journals(workspaceId, journalDate, noteId, createdBy) VALUES ('ws-1', '2026-11-18', 'ws-journal-note', '${FROM}');

    INSERT INTO habits(id, userId, title) VALUES ('habit-1', '${FROM}', '晨跑');
  `);
});

test("transferring a user with nested, trashed and workspace notebooks moves the content and its tree", async () => {
  assert.equal(count("SELECT COUNT(*) c FROM knowledge_tree_nodes WHERE userId = ?", FROM) >= 6, true, "fixture creates tree nodes");
  const response = await transfer();
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(count("SELECT COUNT(*) c FROM users WHERE id = ?", FROM), 0);

  assert.deepEqual(
    db().prepare("SELECT id, userId, parentId, isDeleted FROM notebooks WHERE id LIKE 'nb-%' AND id <> 'nb-to' ORDER BY id").all(),
    [
      { id: "nb-child", userId: TO, parentId: "nb-root", isDeleted: 0 },
      { id: "nb-root", userId: TO, parentId: null, isDeleted: 0 },
      { id: "nb-trash", userId: TO, parentId: null, isDeleted: 1 },
      { id: "nb-trash-child", userId: TO, parentId: "nb-trash", isDeleted: 1 },
      { id: "nb-ws", userId: TO, parentId: null, isDeleted: 0 },
    ],
  );
  assert.equal(one<{ userId: string }>("SELECT userId FROM notes WHERE id = 'note-1'")?.userId, TO);
  assert.equal(count("SELECT COUNT(*) c FROM knowledge_tree_nodes WHERE userId = ?", FROM), 0);
  assert.deepEqual(
    one("SELECT userId, scopeKey, parentId FROM knowledge_tree_nodes WHERE resourceType = 'note' AND resourceId = 'note-1'"),
    { userId: TO, scopeKey: `personal:${TO}`, parentId: "notebook:nb-child" },
  );
  assert.deepEqual(
    one("SELECT userId, scopeKey FROM knowledge_tree_nodes WHERE resourceType = 'notebook' AND resourceId = 'nb-ws'"),
    { userId: TO, scopeKey: "workspace:ws-1" },
  );

  // 同一天两人都有日记：接收人的日记保留，被转移的那篇改为普通笔记，内容不丢
  assert.deepEqual(one("SELECT userId, note_type, journal_date FROM notes WHERE id = 'journal-to'"), { userId: TO, note_type: "journal", journal_date: "2026-11-18" });
  assert.deepEqual(one("SELECT userId, note_type, journal_date, title FROM notes WHERE id = 'journal-from'"), { userId: TO, note_type: "normal", journal_date: null, title: "11 月 18 日" });

  // workspace_journals.createdBy 是 ON DELETE RESTRICT：不改写就根本删不掉原用户
  assert.deepEqual(one("SELECT createdBy FROM workspace_journals WHERE noteId = 'ws-journal-note'"), { createdBy: TO });
});

test("data attached to transferred content follows it; personal account data does not", async () => {
  const response = await transfer();
  assert.equal(response.status, 200, await response.clone().text());

  assert.deepEqual(one("SELECT diaryId, userId FROM diary_attachments WHERE id = 'dm-1'"), { diaryId: "diary-1", userId: TO });
  assert.deepEqual(one("SELECT taskId, userId FROM task_attachments WHERE id = 'ta-1'"), { taskId: "task-1", userId: TO });
  assert.deepEqual(one("SELECT taskId, userId FROM task_reminders WHERE id = 'reminder-1'"), { taskId: "task-1", userId: TO });
  assert.deepEqual(one("SELECT projectId FROM tasks WHERE id = 'task-1'"), { projectId: "project-1" });
  assert.deepEqual(one("SELECT userId FROM task_projects WHERE id = 'project-1'"), { userId: TO });
  assert.deepEqual(
    db().prepare("SELECT labelId FROM task_label_links WHERE taskId = 'task-1' ORDER BY labelId").all(),
    [{ labelId: "label-only" }, { labelId: "label-to" }],
    "same-name labels merge into the receiver's label",
  );
  assert.deepEqual(one("SELECT userId, scopeKey FROM task_labels WHERE id = 'label-only'"), { userId: TO, scopeKey: `personal:${TO}` });
  assert.equal(count("SELECT COUNT(*) c FROM task_labels WHERE id = 'label-from'"), 0);
  assert.deepEqual(one("SELECT scopeKey, action FROM task_recurrence_state WHERE groupId = 'task-1'"), { scopeKey: `personal:${TO}`, action: "stop" });

  assert.deepEqual(one("SELECT userId, folderId FROM mindmaps WHERE id = 'mm-1'"), { userId: TO, folderId: "mf-1" });
  assert.deepEqual(one("SELECT userId FROM mindmap_folders WHERE id = 'mf-1'"), { userId: TO });
  assert.deepEqual(one("SELECT userId FROM sheets WHERE noteId = 'note-1'"), { userId: TO });
  assert.deepEqual(one("SELECT createdBy FROM note_templates WHERE id = 'tpl-1'"), { createdBy: TO });
  assert.equal(count("SELECT COUNT(*) c FROM note_template_attachments WHERE templateId = 'tpl-1'"), 1);
  assert.deepEqual(one("SELECT createdBy FROM notebook_share_links WHERE id = 'link-1'"), { createdBy: TO });

  assert.equal(count("SELECT COUNT(*) c FROM habits WHERE id = 'habit-1'"), 0, "personal habits are deleted with the account");
});

test("tree guards are restored after a transfer and still reject cross-owner writes", async () => {
  const response = await transfer();
  assert.equal(response.status, 200, await response.clone().text());
  const installed = (db().prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND name IN (${GUARDS.map(() => "?").join(",")})`).all(...GUARDS) as Array<{ name: string }>).map((row) => row.name).sort();
  assert.deepEqual(installed, [...GUARDS].sort());
  assert.throws(() => db().prepare("UPDATE notebooks SET userId = ? WHERE id = 'nb-root'").run(ADMIN), /NOTEBOOK_(CHILD|NOTE)_SCOPE_MISMATCH/);
  assert.throws(() => db().prepare("UPDATE notebooks SET parentId = 'nb-to' WHERE id = 'nb-ws'").run(), /NOTEBOOK_PARENT_SCOPE_MISMATCH/);
});

test("a failed transfer rolls back every change and keeps the guards (DCC-008)", async () => {
  const snapshot = () => ({
    notebooks: db().prepare("SELECT id, userId, parentId FROM notebooks ORDER BY id").all(),
    nodes: db().prepare("SELECT id, userId, scopeKey, parentId FROM knowledge_tree_nodes ORDER BY id").all(),
    attachments: db().prepare("SELECT id, userId FROM diary_attachments ORDER BY id").all(),
    labels: db().prepare("SELECT id, userId, scopeKey FROM task_labels ORDER BY id").all(),
    guards: db().prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name LIKE '%guard%' ORDER BY name").all(),
  });
  const before = snapshot();
  db().exec(`CREATE TRIGGER transfer_test_injected_failure BEFORE UPDATE OF userId ON mindmaps
    BEGIN SELECT RAISE(ABORT, 'INJECTED_TRANSFER_FAILURE'); END;`);
  const response = await transfer();
  assert.notEqual(response.status, 200);
  db().exec("DROP TRIGGER transfer_test_injected_failure");
  assert.equal(count("SELECT COUNT(*) c FROM users WHERE id = ?", FROM), 1);
  assert.deepEqual(snapshot(), before);
});

test("only administrators can delete a user with a transfer", async () => {
  const response = await transfer(TO);
  assert.equal(response.status, 403);
  assert.equal(count("SELECT COUNT(*) c FROM users WHERE id = ?", FROM), 1);
  assert.equal(one<{ userId: string }>("SELECT userId FROM notebooks WHERE id = 'nb-root'")?.userId, FROM);
});
