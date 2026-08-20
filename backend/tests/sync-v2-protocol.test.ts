import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import type Database from "better-sqlite3";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-sync-v2-protocol-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");
process.env.ELECTRON_USER_DATA = tmpDir;
// 路由受 Feature Flag 守卫，测试里显式开启。
process.env.NOWEN_LOCAL_FIRST_SYNC_V2 = "1";

let app: Hono;
let getDb: () => Database.Database;
let closeDb: () => void;

const USER_ID = "sync-v2-user";
const OTHER_USER = "sync-v2-other";
const DEVICE_ID = "device-a";

async function call(method: string, route: string, body?: unknown, userId = USER_ID) {
  const response = await app.request(route, {
    method,
    headers: {
      "X-User-Id": userId,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = response.status === 204 ? null : await response.json() as any;
  return { response, json };
}

function push(mutations: unknown[], userId = USER_ID, deviceId = DEVICE_ID) {
  return call("POST", "/api/sync/v2/push", { deviceId, mutations }, userId);
}

function seedUser(userId: string): void {
  getDb().prepare(`
    INSERT OR IGNORE INTO users (id, username, passwordHash, createdAt, updatedAt)
    VALUES (?, ?, 'x', datetime('now'), datetime('now'))
  `).run(userId, userId);
}

/** 直接建一个笔记本，作为 note 的父实体。 */
function seedNotebook(userId = USER_ID): string {
  const id = randomUUID();
  getDb().prepare(`
    INSERT INTO notebooks (id, userId, parentId, name, workspaceId, createdAt, updatedAt)
    VALUES (?, ?, NULL, '测试本', NULL, datetime('now'), datetime('now'))
  `).run(id, userId);
  return id;
}

function clearFeed(): void {
  getDb().exec("DELETE FROM sync_changes_v2");
}

test.before(async () => {
  const [routes, schema] = await Promise.all([
    import("../src/routes/sync-v2"),
    import("../src/db/schema"),
  ]);
  getDb = schema.getDb;
  closeDb = schema.closeDb;
  // 只挂载被测路由，与项目既有路由测试保持一致：
  // 不加载整个 index.ts，避免拉起 WebSocket / 定时任务等无关副作用。
  app = new Hono();
  app.route("/api/sync/v2", routes.default);

  seedUser(USER_ID);
  seedUser(OTHER_USER);
});

test.after(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// V1 必须完好无损
// ---------------------------------------------------------------------------

test("V1 的 offline_sync_changes 与触发器未被 V2 改动", () => {
  const db = getDb();
  const table = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='offline_sync_changes'",
  ).get();
  assert.ok(table, "V1 change feed 表必须仍然存在");

  const v1Triggers = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'offline_sync_%'",
  ).all() as Array<{ name: string }>;
  assert.ok(v1Triggers.length >= 8, `V1 触发器应保持完整，实际 ${v1Triggers.length}`);
});

test("V2 使用独立的 feed 表，与 V1 互不写入", () => {
  const db = getDb();
  clearFeed();
  db.exec("DELETE FROM offline_sync_changes");

  const notebookId = seedNotebook();
  const v2 = db.prepare("SELECT COUNT(*) AS c FROM sync_changes_v2").get() as { c: number };
  const v1 = db.prepare("SELECT COUNT(*) AS c FROM offline_sync_changes").get() as { c: number };

  assert.ok(v2.c >= 1, "V2 feed 应记录 notebook 变更");
  // notebooks 不在 V1 的触发器范围内，V1 不应产生记录。
  assert.equal(v1.c, 0);
  assert.ok(notebookId);
});

// ---------------------------------------------------------------------------
// Change Feed 覆盖六类实体
// ---------------------------------------------------------------------------

test("六类实体的写入都进入 Change Feed", async () => {
  const db = getDb();
  clearFeed();

  const notebookId = seedNotebook();
  const noteId = randomUUID();
  const tagId = randomUUID();

  db.prepare(`
    INSERT INTO notes (id, userId, notebookId, workspaceId, title, content, contentText, version, createdAt, updatedAt)
    VALUES (?, ?, ?, NULL, '标题', '{}', '', 1, datetime('now'), datetime('now'))
  `).run(noteId, USER_ID, notebookId);
  db.prepare(`
    INSERT INTO tags (id, userId, name, workspaceId, createdAt) VALUES (?, ?, ?, NULL, datetime('now'))
  `).run(tagId, USER_ID, `标签-${tagId.slice(0, 6)}`);
  db.prepare("INSERT INTO note_tags (noteId, tagId) VALUES (?, ?)").run(noteId, tagId);
  db.prepare(`
    INSERT INTO favorites (userId, noteId, workspaceId, createdAt) VALUES (?, ?, NULL, datetime('now'))
  `).run(USER_ID, noteId);
  db.prepare(`
    INSERT INTO attachments (id, noteId, userId, filename, mimeType, size, path, createdAt)
    VALUES (?, ?, ?, 'a.png', 'image/png', 10, 'p', datetime('now'))
  `).run(randomUUID(), noteId, USER_ID);

  const types = (db.prepare(
    "SELECT DISTINCT entityType FROM sync_changes_v2 ORDER BY entityType",
  ).all() as Array<{ entityType: string }>).map((r) => r.entityType);

  assert.deepEqual(types, [
    "attachment", "favorite", "note", "note_tag", "notebook", "tag",
  ]);
});

test("关系型实体使用复合 entityId，可精确定位单条关联", () => {
  const db = getDb();
  const row = db.prepare(`
    SELECT entityId FROM sync_changes_v2
    WHERE entityType = 'note_tag' ORDER BY sequence DESC LIMIT 1
  `).get() as { entityId: string };
  assert.ok(row.entityId.includes(":"), "note_tag entityId 应为 noteId:tagId");
});

test("sequence 单调递增，可作为增量对账依据", () => {
  const db = getDb();
  const rows = db.prepare("SELECT sequence FROM sync_changes_v2 ORDER BY rowid ASC")
    .all() as Array<{ sequence: number }>;
  for (let i = 1; i < rows.length; i += 1) {
    assert.ok(rows[i].sequence > rows[i - 1].sequence, "sequence 必须严格递增");
  }
});

test("抑制开关生效期间不记录变更，避免同步回环", async () => {
  const db = getDb();
  const { runChangeFeedSuppressed } = await import("../src/sync/suppression.js");
  clearFeed();

  runChangeFeedSuppressed(db, () => {
    seedNotebook();
  });
  const suppressed = db.prepare("SELECT COUNT(*) AS c FROM sync_changes_v2").get() as { c: number };
  assert.equal(suppressed.c, 0, "抑制期间不得写入 feed");

  // 退出抑制后必须恢复记录，否则同步会永久静默失效。
  seedNotebook();
  const after = db.prepare("SELECT COUNT(*) AS c FROM sync_changes_v2").get() as { c: number };
  assert.ok(after.c >= 1, "退出抑制后必须恢复记录");
});

test("抑制回调抛异常也会复位开关", async () => {
  const db = getDb();
  const { runChangeFeedSuppressed, isChangeFeedSuppressed } = await import("../src/sync/suppression.js");

  assert.throws(() => runChangeFeedSuppressed(db, () => {
    throw new Error("apply failed");
  }), /apply failed/);

  assert.equal(isChangeFeedSuppressed(db), false, "异常后必须复位");
  clearFeed();
  seedNotebook();
  const after = db.prepare("SELECT COUNT(*) AS c FROM sync_changes_v2").get() as { c: number };
  assert.ok(after.c >= 1);
});

// ---------------------------------------------------------------------------
// Push 幂等
// ---------------------------------------------------------------------------

test("同一 mutationId 重复 push 不产生重复数据", async () => {
  const notebookId = seedNotebook();
  const noteId = randomUUID();
  const mutationId = randomUUID();
  const mutation = {
    mutationId,
    entityType: "note",
    entityId: noteId,
    operation: "upsert",
    payload: { notebookId, title: "幂等测试", content: "{}", contentText: "", version: 1 },
  };

  const first = await push([mutation]);
  assert.equal(first.response.status, 200);
  assert.equal(first.json.results[0].status, "applied");

  // 模拟请求超时后客户端重发
  const second = await push([mutation]);
  assert.equal(second.json.results[0].status, "duplicate");

  const count = getDb().prepare("SELECT COUNT(*) AS c FROM notes WHERE id = ?")
    .get(noteId) as { c: number };
  assert.equal(count.c, 1, "重复 push 不得产生第二条笔记");
});

test("幂等重发返回与首次一致的版本语义", async () => {
  const notebookId = seedNotebook();
  const noteId = randomUUID();
  const mutationId = randomUUID();
  const mutation = {
    mutationId,
    entityType: "note",
    entityId: noteId,
    operation: "upsert",
    payload: { notebookId, title: "版本语义", version: 1 },
  };
  const first = await push([mutation]);
  const second = await push([mutation]);
  assert.equal(first.json.results[0].version, second.json.results[0].version);
});

test("delete 天然幂等：对不存在的实体重复删除不报错", async () => {
  const missing = randomUUID();
  const r1 = await push([{
    mutationId: randomUUID(), entityType: "note", entityId: missing, operation: "delete",
  }]);
  const r2 = await push([{
    mutationId: randomUUID(), entityType: "note", entityId: missing, operation: "delete",
  }]);
  assert.equal(r1.json.results[0].status, "applied");
  assert.equal(r2.json.results[0].status, "applied");
});

// ---------------------------------------------------------------------------
// 冲突：绝不静默覆盖正文
// ---------------------------------------------------------------------------

test("baseVersion 与服务端不一致时返回 VERSION_CONFLICT，正文不被覆盖", async () => {
  const notebookId = seedNotebook();
  const noteId = randomUUID();

  await push([{
    mutationId: randomUUID(),
    entityType: "note",
    entityId: noteId,
    operation: "upsert",
    payload: { notebookId, title: "服务器版本", contentText: "服务器内容", version: 1 },
  }]);

  // 客户端拿着过期的 baseVersion 提交
  const conflict = await push([{
    mutationId: randomUUID(),
    entityType: "note",
    entityId: noteId,
    operation: "upsert",
    baseVersion: 99,
    payload: { notebookId, title: "本机版本", contentText: "本机内容" },
  }]);

  assert.equal(conflict.json.results[0].status, "conflict");
  assert.equal(conflict.json.results[0].code, "VERSION_CONFLICT");
  assert.equal(conflict.json.results[0].serverVersion, 1, "必须回传服务端版本供构造三方冲突");

  const row = getDb().prepare("SELECT title, contentText FROM notes WHERE id = ?")
    .get(noteId) as { title: string; contentText: string };
  assert.equal(row.title, "服务器版本", "冲突时服务端正文不得被覆盖");
  assert.equal(row.contentText, "服务器内容");
});

test("已存在的笔记缺少 baseVersion 时判冲突，而不是盲目覆盖", async () => {
  const notebookId = seedNotebook();
  const noteId = randomUUID();
  await push([{
    mutationId: randomUUID(),
    entityType: "note",
    entityId: noteId,
    operation: "upsert",
    payload: { notebookId, title: "原始", version: 1 },
  }]);

  const result = await push([{
    mutationId: randomUUID(),
    entityType: "note",
    entityId: noteId,
    operation: "upsert",
    payload: { notebookId, title: "无 baseVersion 覆盖" },
  }]);

  assert.equal(result.json.results[0].code, "VERSION_CONFLICT");
  const row = getDb().prepare("SELECT title FROM notes WHERE id = ?").get(noteId) as { title: string };
  assert.equal(row.title, "原始");
});

test("baseVersion 匹配时正常更新并递增版本", async () => {
  const notebookId = seedNotebook();
  const noteId = randomUUID();
  await push([{
    mutationId: randomUUID(),
    entityType: "note",
    entityId: noteId,
    operation: "upsert",
    payload: { notebookId, title: "v1", version: 1 },
  }]);

  const updated = await push([{
    mutationId: randomUUID(),
    entityType: "note",
    entityId: noteId,
    operation: "upsert",
    baseVersion: 1,
    payload: { notebookId, title: "v2" },
  }]);

  assert.equal(updated.json.results[0].status, "applied");
  assert.equal(updated.json.results[0].version, 2);
  const row = getDb().prepare("SELECT title, version FROM notes WHERE id = ?")
    .get(noteId) as { title: string; version: number };
  assert.equal(row.title, "v2");
  assert.equal(row.version, 2);
});

test("一条冲突不影响同批次其他 mutation 落库", async () => {
  const notebookId = seedNotebook();
  const conflictNote = randomUUID();
  const okNote = randomUUID();

  await push([{
    mutationId: randomUUID(),
    entityType: "note",
    entityId: conflictNote,
    operation: "upsert",
    payload: { notebookId, title: "已存在", version: 1 },
  }]);

  const batch = await push([
    {
      mutationId: randomUUID(),
      entityType: "note",
      entityId: conflictNote,
      operation: "upsert",
      baseVersion: 42,
      payload: { notebookId, title: "冲突项" },
    },
    {
      mutationId: randomUUID(),
      entityType: "note",
      entityId: okNote,
      operation: "upsert",
      payload: { notebookId, title: "正常项", version: 1 },
    },
  ]);

  assert.equal(batch.json.results[0].code, "VERSION_CONFLICT");
  assert.equal(batch.json.results[1].status, "applied");
  const ok = getDb().prepare("SELECT title FROM notes WHERE id = ?").get(okNote) as { title: string };
  assert.equal(ok.title, "正常项", "同批次正常项必须成功");
});

// ---------------------------------------------------------------------------
// 参数校验与范围控制
// ---------------------------------------------------------------------------

test("拒绝越界实体，防止范围失控", async () => {
  const r = await push([{
    mutationId: randomUUID(), entityType: "task", entityId: "t1", operation: "upsert",
  }]);
  assert.equal(r.json.results[0].code, "INVALID_PAYLOAD");
});

test("缺少 deviceId 时拒绝整个 push", async () => {
  const r = await call("POST", "/api/sync/v2/push", { mutations: [] });
  assert.equal(r.response.status, 400);
  assert.equal(r.json.code, "INVALID_PAYLOAD");
});

test("超出单批上限时拒绝，避免打爆服务端事务", async () => {
  const mutations = Array.from({ length: 201 }, () => ({
    mutationId: randomUUID(), entityType: "note", entityId: randomUUID(), operation: "delete",
  }));
  const r = await push(mutations);
  assert.equal(r.response.status, 400);
  assert.equal(r.json.code, "INVALID_PAYLOAD");
});

test("第一版显式拒绝 workspace 作用域，而不是静默按个人空间处理", async () => {
  const r = await call("GET", "/api/sync/v2/plan?workspaceId=ws-1");
  assert.equal(r.response.status, 400);
  assert.equal(r.json.code, "SYNC_V2_SCOPE_UNSUPPORTED");
});

test("缺少用户身份时拒绝访问", async () => {
  // 生产环境由全局 JWT 中间件注入 X-User-Id；这里验证路由自身也有兜底守卫，
  // 避免将来挂载顺序调整导致无鉴权访问。
  const response = await app.request("/api/sync/v2/plan", { method: "GET" });
  assert.equal(response.status, 401);
  const json = await response.json() as any;
  assert.equal(json.code, "SYNC_V2_UNAUTHORIZED");
});

test("note_tag 引用他人笔记时拒绝，防止越权挂标签", async () => {
  const foreignNotebook = seedNotebook(OTHER_USER);
  const foreignNote = randomUUID();
  getDb().prepare(`
    INSERT INTO notes (id, userId, notebookId, workspaceId, title, content, contentText, version, createdAt, updatedAt)
    VALUES (?, ?, ?, NULL, '他人笔记', '{}', '', 1, datetime('now'), datetime('now'))
  `).run(foreignNote, OTHER_USER, foreignNotebook);

  const tagId = randomUUID();
  getDb().prepare(`
    INSERT INTO tags (id, userId, name, workspaceId, createdAt) VALUES (?, ?, ?, NULL, datetime('now'))
  `).run(tagId, USER_ID, `own-${tagId.slice(0, 6)}`);

  const r = await push([{
    mutationId: randomUUID(),
    entityType: "note_tag",
    entityId: `${foreignNote}:${tagId}`,
    operation: "upsert",
  }]);
  assert.equal(r.json.results[0].code, "MISSING_DEPENDENCY");
});

test("附件二进制未上传时拒绝元数据先行同步", async () => {
  const r = await push([{
    mutationId: randomUUID(),
    entityType: "attachment",
    entityId: randomUUID(),
    operation: "upsert",
    payload: { filename: "ghost.png" },
  }]);
  assert.equal(r.json.results[0].code, "MISSING_DEPENDENCY");
});

// ---------------------------------------------------------------------------
// changes / plan / ack
// ---------------------------------------------------------------------------

test("changes 只返回本人个人空间的变更", async () => {
  clearFeed();
  const own = seedNotebook(USER_ID);
  const foreign = seedNotebook(OTHER_USER);

  const r = await call("GET", "/api/sync/v2/changes?after=0");
  const ids = r.json.items.map((i: any) => i.entityId);
  assert.ok(ids.includes(own), "应包含本人变更");
  assert.ok(!ids.includes(foreign), "不得泄漏他人变更");
});

test("changes 支持分页并推进游标", async () => {
  clearFeed();
  for (let i = 0; i < 5; i += 1) seedNotebook(USER_ID);

  const page1 = await call("GET", "/api/sync/v2/changes?after=0&limit=2");
  assert.equal(page1.json.items.length, 2);
  assert.equal(page1.json.hasMore, true);

  const page2 = await call("GET", `/api/sync/v2/changes?after=${page1.json.nextSequence}&limit=10`);
  assert.equal(page2.json.hasMore, false);
  assert.ok(page2.json.items.length >= 3);
});

test("游标早于 minAvailableSequence 时要求回退 snapshot", async () => {
  const db = getDb();
  clearFeed();
  seedNotebook(USER_ID);
  // 模拟历史变更已被清理：把最小序号抬高
  const min = db.prepare("SELECT MIN(sequence) AS s FROM sync_changes_v2").get() as { s: number };

  const r = await call("GET", `/api/sync/v2/changes?after=${Math.max(1, min.s - 10)}`);
  if (min.s > 11) {
    assert.equal(r.json.resetRequired, true);
    assert.deepEqual(r.json.items, []);
  } else {
    // 序号尚小时不触发 reset，属正常路径
    assert.equal(r.json.resetRequired, false);
  }
});

test("plan 返回服务端序号与实体计数", async () => {
  const r = await call("GET", "/api/sync/v2/plan");
  assert.equal(r.response.status, 200);
  assert.equal(r.json.scopeKey, "personal");
  assert.ok(Number.isInteger(r.json.serverSequence));
  assert.ok(r.json.notebookCount >= 1);
  assert.ok(typeof r.json.serverTime === "string");
});

test("ack 游标只前进不后退", async () => {
  const high = await call("POST", "/api/sync/v2/ack", { deviceId: DEVICE_ID, sequence: 500 });
  assert.equal(high.json.lastSequence, 500);

  const late = await call("POST", "/api/sync/v2/ack", { deviceId: DEVICE_ID, sequence: 3 });
  assert.equal(late.json.lastSequence, 500, "迟到的小序号不得回退游标");
});

test("ack 拒绝非法参数", async () => {
  const r1 = await call("POST", "/api/sync/v2/ack", { sequence: 1 });
  assert.equal(r1.response.status, 400);
  const r2 = await call("POST", "/api/sync/v2/ack", { deviceId: DEVICE_ID, sequence: -1 });
  assert.equal(r2.response.status, 400);
});

// ---------------------------------------------------------------------------
// snapshot 分页
// ---------------------------------------------------------------------------

test("snapshot 分页遍历且按固定实体顺序，父实体先于子实体", async () => {
  const notebookId = seedNotebook(USER_ID);
  const noteId = randomUUID();
  getDb().prepare(`
    INSERT INTO notes (id, userId, notebookId, workspaceId, title, content, contentText, version, createdAt, updatedAt)
    VALUES (?, ?, ?, NULL, 'snapshot 笔记', '{}', '', 1, datetime('now'), datetime('now'))
  `).run(noteId, USER_ID, notebookId);

  const first = await call("GET", "/api/sync/v2/snapshot?limit=1");
  assert.equal(first.json.items.length, 1);
  assert.equal(first.json.items[0].entityType, "notebook", "首个实体类型应为 notebook");
  assert.equal(first.json.hasMore, true);
  assert.ok(first.json.snapshotSequence >= 0);

  // 逐页遍历直到结束，确认不会无限循环也不会漏项
  let cursor = first.json.nextCursor;
  let guard = 0;
  const seen = new Set<string>([`${first.json.items[0].entityType}:${first.json.items[0].entityId}`]);
  while (cursor && guard < 500) {
    const page = await call(
      "GET",
      `/api/sync/v2/snapshot?limit=5&cursor=${encodeURIComponent(cursor)}&snapshotSequence=${first.json.snapshotSequence}`,
    );
    for (const item of page.json.items) {
      seen.add(`${item.entityType}:${item.entityId}`);
    }
    cursor = page.json.nextCursor;
    guard += 1;
  }
  assert.ok(guard < 500, "分页必须能终止");
  assert.ok(seen.has(`note:${noteId}`), "遍历结果应包含所有实体");
});

test("snapshot 不泄漏他人数据", async () => {
  const foreign = seedNotebook(OTHER_USER);
  const r = await call("GET", "/api/sync/v2/snapshot?limit=200");
  const ids = r.json.items.map((i: any) => i.entityId);
  assert.ok(!ids.includes(foreign));
});

test("snapshot 附件只返回元数据，不含二进制路径", async () => {
  const notebookId = seedNotebook(USER_ID);
  const noteId = randomUUID();
  getDb().prepare(`
    INSERT INTO notes (id, userId, notebookId, workspaceId, title, content, contentText, version, createdAt, updatedAt)
    VALUES (?, ?, ?, NULL, '附件笔记', '{}', '', 1, datetime('now'), datetime('now'))
  `).run(noteId, USER_ID, notebookId);
  const attachmentId = randomUUID();
  getDb().prepare(`
    INSERT INTO attachments (id, noteId, userId, filename, mimeType, size, path, createdAt)
    VALUES (?, ?, ?, 'x.png', 'image/png', 5, '/secret/path', datetime('now'))
  `).run(attachmentId, noteId, USER_ID);

  const r = await call("GET", "/api/sync/v2/snapshot?limit=500");
  const attachment = r.json.items.find((i: any) => i.entityId === attachmentId);
  assert.ok(attachment, "应返回附件元数据");
  assert.equal(attachment.payload.path, undefined, "不得回传服务器文件路径");
  assert.equal(attachment.payload.filename, "x.png");
});
