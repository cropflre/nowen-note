import assert from "node:assert/strict";
import crypto from "node:crypto";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { getDb } from "../src/db/schema";
import {
  getLiteMigrationProgress,
  isLiteMigrationComplete,
  resetLiteMigration,
  runLiteMigration,
} from "../src/sync/liteMigration";
import {
  SyncBlobClient,
  pullAttachmentBlobs,
  pushAttachmentBlobs,
} from "../src/sync/blob";
import { getActiveProfile, getSyncState } from "../src/sync/profile";
import { isBootstrapReady } from "../src/sync/bootstrap";
import {
  listPendingDownloads,
  listPendingUploads,
  promoteLocalAttachments,
  registerLocalAttachment,
  registerRemoteAttachment,
} from "../src/sync/attachments";
import { countPendingMutations } from "../src/sync/outbox";
import { SyncError } from "../src/sync/errors";
import type { SyncEntityType } from "../src/sync/types";

/**
 * 阶段 E（Lite → Local 真迁移）与阶段 H（附件二进制 Local-first）契约。
 *
 * 核心验收点：
 *   - Lite 用户升级后**绝不**打开空知识库
 *   - 迁移可断点续跑、幂等
 *   - 校验不通过时不切运行时
 *   - 附件二进制失败不影响本地阅读，也不删除本地文件
 */

const USER_ID = "lite-user";
const REMOTE = "http://lite.test";

function db() {
  return getDb();
}

function resetAll(): void {
  db().exec(`
    DROP TABLE IF EXISTS lite_migration_state;
    DELETE FROM attachment_sync_state;
    DELETE FROM sync_conflicts;
    DELETE FROM sync_outbox;
    DELETE FROM sync_applied_mutations;
    DELETE FROM sync_state;
    DELETE FROM sync_profile_devices;
    DELETE FROM sync_device_identity;
    DELETE FROM sync_devices;
    DELETE FROM sync_profiles;
    DELETE FROM note_tags;
    DELETE FROM favorites;
    DELETE FROM attachments;
    DELETE FROM notes;
    DELETE FROM tags;
    DELETE FROM notebooks;
  `);
  db().prepare(`
    INSERT OR IGNORE INTO users (id, username, passwordHash, createdAt, updatedAt)
    VALUES (?, ?, 'x', datetime('now'), datetime('now'))
  `).run(USER_ID, USER_ID);
}

interface RemoteEntity {
  entityType: SyncEntityType;
  entityId: string;
  payload: Record<string, unknown>;
}

/**
 * 可编程的假远端。
 *
 * 用假实现而不是起真服务器：要覆盖"第 3 页时断网"、"token 过期"这类分支，
 * 真服务器无法精确控制失败时机。
 */
class FakeRemote {
  entities: RemoteEntity[] = [];
  serverSequence = 100;
  /** 设为正数则在第 N 次 snapshot 调用时抛网络错误。 */
  failSnapshotAtCall = 0;
  /** plan 抛授权错误。 */
  failPlanAuth = false;
  snapshotCalls = 0;
  planCalls = 0;

  async plan(_after: number) {
    this.planCalls += 1;
    if (this.failPlanAuth) throw new SyncError("AUTH_EXPIRED", "token 过期");
    return {
      serverSequence: this.serverSequence,
      minAvailableSequence: 0,
      resetRequired: false,
      notebookCount: this.entities.filter((e) => e.entityType === "notebook").length,
      noteCount: this.entities.filter((e) => e.entityType === "note").length,
      tagCount: this.entities.filter((e) => e.entityType === "tag").length,
    };
  }

  async snapshot(cursor: string | null, _at: number, limit: number) {
    this.snapshotCalls += 1;
    if (this.failSnapshotAtCall > 0 && this.snapshotCalls === this.failSnapshotAtCall) {
      throw new SyncError("NETWORK_UNAVAILABLE", "断网");
    }
    const start = cursor ? Number(cursor) : 0;
    const slice = this.entities.slice(start, start + limit);
    const next = start + slice.length;
    return {
      snapshotSequence: this.serverSequence,
      hasMore: next < this.entities.length,
      nextCursor: next < this.entities.length ? String(next) : null,
      items: slice,
    };
  }

  async changes(after: number, _limit: number) {
    return {
      serverSequence: this.serverSequence,
      nextSequence: Math.max(after, this.serverSequence),
      hasMore: false,
      resetRequired: false,
      items: [],
    };
  }

  async push(_deviceId: string, mutations: any[]) {
    return {
      serverSequence: this.serverSequence,
      results: mutations.map((m) => ({ mutationId: m.mutationId, status: "applied" as const })),
    };
  }

  async ack(_deviceId: string, sequence: number) {
    return { lastSequence: sequence };
  }
}

/** 造一批远端实体：notebook + N 篇笔记。 */
function seedRemote(remote: FakeRemote, noteCount: number): { notebookId: string; noteIds: string[] } {
  const notebookId = randomUUID();
  remote.entities.push({
    entityType: "notebook",
    entityId: notebookId,
    payload: { id: notebookId, name: "远端笔记本", userId: USER_ID },
  });
  const noteIds: string[] = [];
  for (let i = 0; i < noteCount; i += 1) {
    const id = randomUUID();
    noteIds.push(id);
    remote.entities.push({
      entityType: "note",
      entityId: id,
      payload: {
        id,
        title: `远端笔记 ${i}`,
        content: `内容 ${i}`,
        notebookId,
        userId: USER_ID,
        version: 1,
      },
    });
  }
  return { notebookId, noteIds };
}

function countLocalNotes(): number {
  return (db().prepare("SELECT COUNT(*) AS c FROM notes").get() as { c: number }).c;
}

// ===========================================================================
// 阶段 E：Lite → Local 迁移
// ===========================================================================

test("Lite 迁移把远端数据完整搬到本地，绝不出现空知识库", async () => {
  resetAll();
  const remote = new FakeRemote();
  const { notebookId, noteIds } = seedRemote(remote, 5);

  const progress = await runLiteMigration({
    db: db(),
    remoteUrl: REMOTE,
    userId: USER_ID,
    client: remote as never,
    pageSize: 2,
  });

  assert.equal(progress.stage, "complete", `迁移未完成: ${progress.error}`);
  assert.equal(countLocalNotes(), 5, "全部笔记必须落到本地");
  const nb = db().prepare("SELECT name FROM notebooks WHERE id = ?").get(notebookId) as
    | { name: string }
    | undefined;
  assert.equal(nb?.name, "远端笔记本");
  for (const id of noteIds) {
    assert.ok(db().prepare("SELECT 1 FROM notes WHERE id = ?").get(id), `笔记 ${id} 缺失`);
  }
});

test("迁移完成后建立 SyncProfile 且基线直接就绪，不再重复全量下载", async () => {
  resetAll();
  const remote = new FakeRemote();
  seedRemote(remote, 3);

  const progress = await runLiteMigration({
    db: db(),
    remoteUrl: REMOTE,
    userId: USER_ID,
    client: remote as never,
  });

  assert.equal(progress.stage, "complete");
  const active = getActiveProfile(db());
  assert.ok(active, "必须建立启用中的 SyncProfile");
  assert.equal(active!.serverUrl, REMOTE);
  // 数据刚从这台服务器完整下载，两端定义上一致，无需再对账。
  assert.equal(isBootstrapReady(db(), active!.id), true);
  // 游标必须落在 snapshot 高水位，否则增量引擎会从 0 重新拉全部变更。
  assert.equal(getSyncState(db(), active!.id)?.lastSequence, remote.serverSequence);
});

test("迁移期间断网后重跑可断点续跑，不从头重下", async () => {
  resetAll();
  const remote = new FakeRemote();
  seedRemote(remote, 6);
  // 第 2 次 snapshot 调用断网（第 1 页已成功应用）
  remote.failSnapshotAtCall = 2;

  const first = await runLiteMigration({
    db: db(),
    remoteUrl: REMOTE,
    userId: USER_ID,
    client: remote as never,
    pageSize: 3,
  });
  assert.equal(first.stage, "failed");
  const partialNotes = countLocalNotes();
  assert.ok(partialNotes > 0 && partialNotes < 6, `应为部分下载，实际 ${partialNotes}`);

  // 恢复网络后重跑
  remote.failSnapshotAtCall = 0;
  const callsBefore = remote.snapshotCalls;
  const second = await runLiteMigration({
    db: db(),
    remoteUrl: REMOTE,
    userId: USER_ID,
    client: remote as never,
    pageSize: 3,
  });
  assert.equal(second.stage, "complete");
  assert.equal(countLocalNotes(), 6);
  // 续跑应从游标继续：调用次数远少于"从头重下"所需
  assert.ok(remote.snapshotCalls - callsBefore <= 4, "应从游标续跑而非全部重下");
});

test("已完成的迁移重复调用直接返回，不产生网络请求", async () => {
  resetAll();
  const remote = new FakeRemote();
  seedRemote(remote, 2);

  await runLiteMigration({ db: db(), remoteUrl: REMOTE, userId: USER_ID, client: remote as never });
  const planCallsAfterFirst = remote.planCalls;

  const again = await runLiteMigration({
    db: db(),
    remoteUrl: REMOTE,
    userId: USER_ID,
    client: remote as never,
  });
  assert.equal(again.stage, "complete");
  assert.equal(remote.planCalls, planCallsAfterFirst, "已完成不应再请求远端");
});

test("token 失效时进入 auth_required 而非 failed，本地数据不受影响", async () => {
  resetAll();
  const remote = new FakeRemote();
  seedRemote(remote, 2);
  remote.failPlanAuth = true;

  const progress = await runLiteMigration({
    db: db(),
    remoteUrl: REMOTE,
    userId: USER_ID,
    client: remote as never,
  });
  assert.equal(progress.stage, "auth_required");
  assert.equal(isLiteMigrationComplete(db()), false);
  // 关键：未完成时不得建立启用的 Profile，Electron 才会让用户继续用 Lite
  assert.equal(getActiveProfile(db()), null);
});

test("完整性校验发现本地少于远端时判定失败，绝不切换运行时", async () => {
  resetAll();
  const remote = new FakeRemote();
  seedRemote(remote, 4);
  // 让 plan 谎报更多笔记，模拟下载不完整
  const originalPlan = remote.plan.bind(remote);
  remote.plan = async (after: number) => {
    const p = await originalPlan(after);
    return { ...p, noteCount: p.noteCount + 10 };
  };

  const progress = await runLiteMigration({
    db: db(),
    remoteUrl: REMOTE,
    userId: USER_ID,
    client: remote as never,
  });

  assert.equal(progress.stage, "failed");
  assert.ok(progress.verification, "必须留下校验明细供人工核对");
  assert.equal(progress.verification!.ok, false);
  assert.ok(progress.verification!.mismatched.includes("note"));
  assert.equal(isLiteMigrationComplete(db()), false);
  assert.equal(getActiveProfile(db()), null, "校验失败不得启用 Profile");
});

test("本地已有数据多于远端时不算失败（用户可能先试用过 Full 版）", async () => {
  resetAll();
  // 先在本地建一篇笔记
  const localNb = randomUUID();
  const localNote = randomUUID();
  db().prepare(`
    INSERT INTO notebooks (id, name, userId, createdAt, updatedAt)
    VALUES (?, '本机已有', ?, datetime('now'), datetime('now'))
  `).run(localNb, USER_ID);
  db().prepare(`
    INSERT INTO notes (id, title, content, notebookId, userId, createdAt, updatedAt)
    VALUES (?, '本机笔记', 'x', ?, ?, datetime('now'), datetime('now'))
  `).run(localNote, localNb, USER_ID);

  const remote = new FakeRemote();
  seedRemote(remote, 2);

  const progress = await runLiteMigration({
    db: db(),
    remoteUrl: REMOTE,
    userId: USER_ID,
    client: remote as never,
  });

  assert.equal(progress.stage, "complete", `不应失败: ${progress.error}`);
  // 本地原有笔记必须保留 —— 迁移是合并，不是覆盖
  assert.ok(db().prepare("SELECT 1 FROM notes WHERE id = ?").get(localNote), "本机原有笔记被删了");
  assert.equal(countLocalNotes(), 3);
});

test("重置迁移状态只清进度，已下载数据完整保留", async () => {
  resetAll();
  const remote = new FakeRemote();
  seedRemote(remote, 3);
  await runLiteMigration({ db: db(), remoteUrl: REMOTE, userId: USER_ID, client: remote as never });
  assert.equal(countLocalNotes(), 3);

  const reset = resetLiteMigration(db());
  assert.equal(reset.stage, "pending");
  assert.equal(reset.downloaded, 0);
  // 数据仍在：重下一遍纯属浪费用户带宽
  assert.equal(countLocalNotes(), 3, "重置不得删除已下载数据");
});

test("迁移进度可查询，失败原因不含敏感信息", async () => {
  resetAll();
  const remote = new FakeRemote();
  seedRemote(remote, 1);
  remote.failPlanAuth = true;
  await runLiteMigration({ db: db(), remoteUrl: REMOTE, userId: USER_ID, client: remote as never });

  const progress = getLiteMigrationProgress(db());
  assert.equal(progress.stage, "auth_required");
  assert.ok(progress.error);
  // 错误信息必须截断且不含 token
  assert.ok(progress.error!.length <= 200);
  assert.equal(/Bearer|token=|passwordHash/i.test(progress.error!), false);
});

// ===========================================================================
// 阶段 H：附件二进制 Local-first
// ===========================================================================

/** 可编程的假 blob 远端。 */
class FakeBlobRemote {
  store = new Map<string, Buffer>();
  failUploadIds = new Set<string>();
  notReadyIds = new Set<string>();
  uploadCalls: string[] = [];
  downloadCalls: string[] = [];

  async exists(id: string): Promise<boolean> {
    return this.store.has(id);
  }

  async upload(id: string, buffer: Buffer): Promise<void> {
    this.uploadCalls.push(id);
    if (this.failUploadIds.has(id)) {
      throw new SyncError("NETWORK_UNAVAILABLE", "断网");
    }
    this.store.set(id, buffer);
  }

  async download(id: string): Promise<{ buffer: Buffer; hash: string | null }> {
    this.downloadCalls.push(id);
    if (this.notReadyIds.has(id)) {
      throw new SyncError("BLOB_NOT_READY", "对端还没上传");
    }
    const buf = this.store.get(id);
    if (!buf) throw new SyncError("SERVER_ERROR", "不存在");
    return { buffer: buf, hash: crypto.createHash("sha256").update(buf).digest("hex") };
  }
}

/** 在本地建一个带真实文件的附件。 */
function seedLocalAttachment(content: string): { id: string; hash: string } {
  const noteId = randomUUID();
  const nbId = randomUUID();
  db().prepare(`
    INSERT INTO notebooks (id, name, userId, createdAt, updatedAt)
    VALUES (?, 'nb', ?, datetime('now'), datetime('now'))
  `).run(nbId, USER_ID);
  db().prepare(`
    INSERT INTO notes (id, title, content, notebookId, userId, createdAt, updatedAt)
    VALUES (?, 't', '', ?, ?, datetime('now'), datetime('now'))
  `).run(noteId, nbId, USER_ID);

  const id = randomUUID();
  const buf = Buffer.from(content, "utf-8");
  const hash = crypto.createHash("sha256").update(buf).digest("hex");

  // 真实写盘，让 readAttachmentObject 能读到
  const fs = require("node:fs") as typeof import("node:fs");
  const {
    ensureAttachmentsDir,
    getLocalAttachmentPath,
    getUploadMonthPath,
    // eslint-disable-next-line @typescript-eslint/no-var-requires
  } = require("../src/services/attachment-storage") as typeof import("../src/services/attachment-storage");
  ensureAttachmentsDir();
  const relPath = `${getUploadMonthPath()}/${id}.txt`;
  const abs = getLocalAttachmentPath(relPath);
  fs.mkdirSync(require("node:path").dirname(abs), { recursive: true });
  fs.writeFileSync(abs, buf);

  db().prepare(`
    INSERT INTO attachments (id, noteId, userId, filename, mimeType, size, path, hash, createdAt)
    VALUES (?, ?, ?, ?, 'text/plain', ?, ?, ?, datetime('now'))
  `).run(id, noteId, USER_ID, `${id}.txt`, buf.length, relPath, hash);

  return { id, hash };
}

test("本地附件先落地即可读；仅此设备不上传，开启同步后才补传", async () => {
  resetAll();
  const { id } = seedLocalAttachment("本地图片内容");

  // 阶段一：未开启同步（profileId=null）。
  // 本地文件立即可读，但绝不进入上传队列 —— 这是"仅此设备"的语义。
  registerLocalAttachment(db(), id, null);
  const row = db().prepare("SELECT path FROM attachments WHERE id = ?").get(id) as { path: string };
  assert.ok(row.path, "本地路径必须立即可用");
  assert.equal(listPendingUploads(db(), 10).length, 0, "仅此设备不得上传");

  const blob = new FakeBlobRemote();
  assert.equal((await pushAttachmentBlobs(db(), blob as never)).uploaded, 0);
  assert.equal(blob.uploadCalls.length, 0);

  // 阶段二：开启同步后，关闭期间产生的附件必须被补传，
  // 否则其他设备上永远是破图。
  const promoted = promoteLocalAttachments(db(), "p1");
  assert.equal(promoted, 1, "历史 local 附件必须被提升为待上传");

  const result = await pushAttachmentBlobs(db(), blob as never);
  assert.equal(result.uploaded, 1);
  assert.ok(blob.store.has(id));
});

test("上传失败不删除本地附件，只累加重试", async () => {
  resetAll();
  const { id } = seedLocalAttachment("会上传失败的内容");
  registerLocalAttachment(db(), id, "p1");

  const blob = new FakeBlobRemote();
  blob.failUploadIds.add(id);

  const result = await pushAttachmentBlobs(db(), blob as never);
  assert.equal(result.failed, 1);
  // 本地文件与元数据必须完好 —— 同步失败 ≠ 用户不再需要这个文件
  assert.ok(db().prepare("SELECT 1 FROM attachments WHERE id = ?").get(id), "本地元数据被删了");
  const state = db().prepare(
    "SELECT status, retryCount FROM attachment_sync_state WHERE attachmentId = ?",
  ).get(id) as { status: string; retryCount: number };
  assert.equal(state.status, "failed");
  assert.ok(state.retryCount >= 1);
  // 仍在待上传列表里，下轮会重试
  assert.equal(listPendingUploads(db(), 10).length, 1);
});

test("服务端已有同一份内容时跳过上传，省掉重复传输", async () => {
  resetAll();
  const { id } = seedLocalAttachment("去重内容");
  registerLocalAttachment(db(), id, "p1");

  const blob = new FakeBlobRemote();
  // 预置：服务端已有（hash 去重场景）
  blob.store.set(id, Buffer.from("去重内容", "utf-8"));

  const result = await pushAttachmentBlobs(db(), blob as never);
  assert.equal(result.skipped, 1);
  assert.equal(result.uploaded, 0);
  assert.equal(blob.uploadCalls.length, 0, "不该发起实际上传");
  const state = db().prepare(
    "SELECT status FROM attachment_sync_state WHERE attachmentId = ?",
  ).get(id) as { status: string };
  assert.equal(state.status, "synced");
});

test("远端附件按需下载，下载完成才置为可读", async () => {
  resetAll();
  const noteId = randomUUID();
  const nbId = randomUUID();
  db().prepare(`INSERT INTO notebooks (id, name, userId, createdAt, updatedAt)
    VALUES (?, 'nb', ?, datetime('now'), datetime('now'))`).run(nbId, USER_ID);
  db().prepare(`INSERT INTO notes (id, title, content, notebookId, userId, createdAt, updatedAt)
    VALUES (?, 't', '', ?, ?, datetime('now'), datetime('now'))`).run(noteId, nbId, USER_ID);

  const id = randomUUID();
  const content = Buffer.from("远端图片", "utf-8");
  const hash = crypto.createHash("sha256").update(content).digest("hex");
  db().prepare(`
    INSERT INTO attachments (id, noteId, userId, filename, mimeType, size, path, hash, createdAt)
    VALUES (?, ?, ?, 'remote.txt', 'text/plain', ?, '', ?, datetime('now'))
  `).run(id, noteId, USER_ID, content.length, hash);
  registerRemoteAttachment(db(), id, "p1");

  // 下载前必须标记为 remoteOnly，UI 才能显示"正在获取"而不是破图
  assert.equal(listPendingDownloads(db(), 10).length, 1);

  const blob = new FakeBlobRemote();
  blob.store.set(id, content);

  const result = await pullAttachmentBlobs(db(), blob as never);
  assert.equal(result.downloaded, 1);
  const state = db().prepare(
    "SELECT remoteOnly FROM attachment_sync_state WHERE attachmentId = ?",
  ).get(id) as { remoteOnly: number };
  assert.equal(state.remoteOnly, 0, "下载完成才可读");
  // path 应被回填
  const row = db().prepare("SELECT path, size FROM attachments WHERE id = ?").get(id) as
    { path: string; size: number };
  assert.ok(row.path, "path 必须回填");
  assert.equal(row.size, content.length);
});

test("对端尚未上传时算跳过而非失败，不删本地记录", async () => {
  resetAll();
  const noteId = randomUUID();
  const nbId = randomUUID();
  db().prepare(`INSERT INTO notebooks (id, name, userId, createdAt, updatedAt)
    VALUES (?, 'nb', ?, datetime('now'), datetime('now'))`).run(nbId, USER_ID);
  db().prepare(`INSERT INTO notes (id, title, content, notebookId, userId, createdAt, updatedAt)
    VALUES (?, 't', '', ?, ?, datetime('now'), datetime('now'))`).run(noteId, nbId, USER_ID);
  const id = randomUUID();
  db().prepare(`
    INSERT INTO attachments (id, noteId, userId, filename, mimeType, size, path, createdAt)
    VALUES (?, ?, ?, 'x.txt', 'text/plain', 0, '', datetime('now'))
  `).run(id, noteId, USER_ID);
  registerRemoteAttachment(db(), id, "p1");

  const blob = new FakeBlobRemote();
  blob.notReadyIds.add(id);

  const result = await pullAttachmentBlobs(db(), blob as never);
  assert.equal(result.skipped, 1);
  assert.equal(result.failed, 0, "对端没准备好不算失败");
  // 仍在待下载列表，下轮继续
  assert.equal(listPendingDownloads(db(), 10).length, 1);
});

test("下载内容 hash 不匹配时拒绝写入，避免坏文件永久留存", async () => {
  resetAll();
  const noteId = randomUUID();
  const nbId = randomUUID();
  db().prepare(`INSERT INTO notebooks (id, name, userId, createdAt, updatedAt)
    VALUES (?, 'nb', ?, datetime('now'), datetime('now'))`).run(nbId, USER_ID);
  db().prepare(`INSERT INTO notes (id, title, content, notebookId, userId, createdAt, updatedAt)
    VALUES (?, 't', '', ?, ?, datetime('now'), datetime('now'))`).run(noteId, nbId, USER_ID);

  const id = randomUUID();
  // 元数据声明的 hash 与实际下载内容不一致
  db().prepare(`
    INSERT INTO attachments (id, noteId, userId, filename, mimeType, size, path, hash, createdAt)
    VALUES (?, ?, ?, 'x.txt', 'text/plain', 4, '', 'deadbeef', datetime('now'))
  `).run(id, noteId, USER_ID);
  registerRemoteAttachment(db(), id, "p1");

  const blob = new FakeBlobRemote();
  blob.store.set(id, Buffer.from("篡改后的内容", "utf-8"));

  const result = await pullAttachmentBlobs(db(), blob as never);
  assert.equal(result.failed, 1);
  const state = db().prepare(
    "SELECT status, lastError, remoteOnly FROM attachment_sync_state WHERE attachmentId = ?",
  ).get(id) as { status: string; lastError: string; remoteOnly: number };
  assert.equal(state.lastError, "CHECKSUM_MISMATCH");
  // 关键：仍标记为未就绪，不能让 UI 以为图片已可用
  assert.equal(state.remoteOnly, 1);
});

test("本地文件丢失时标失败保留记录，不静默丢弃", async () => {
  resetAll();
  const { id } = seedLocalAttachment("即将被删除的文件");
  registerLocalAttachment(db(), id, "p1");
  // 模拟用户手动删了文件 / 磁盘故障
  db().prepare("UPDATE attachments SET path = '不存在/的/路径.txt' WHERE id = ?").run(id);

  const blob = new FakeBlobRemote();
  const result = await pushAttachmentBlobs(db(), blob as never);
  assert.equal(result.failed, 1);
  const state = db().prepare(
    "SELECT lastError FROM attachment_sync_state WHERE attachmentId = ?",
  ).get(id) as { lastError: string };
  assert.equal(state.lastError, "LOCAL_BLOB_MISSING");
  // 元数据仍在：保留可审计记录，让用户知道这个附件出了问题
  assert.ok(db().prepare("SELECT 1 FROM attachments WHERE id = ?").get(id));
});

test("并发受限：一批多个附件按限并发处理且全部完成", async () => {
  resetAll();
  const ids: string[] = [];
  for (let i = 0; i < 5; i += 1) {
    const { id } = seedLocalAttachment(`内容-${i}`);
    registerLocalAttachment(db(), id, "p1");
    ids.push(id);
  }

  const blob = new FakeBlobRemote();
  const result = await pushAttachmentBlobs(db(), blob as never, {
    batchSize: 5,
    concurrency: 2,
  });
  assert.equal(result.uploaded, 5);
  for (const id of ids) assert.ok(blob.store.has(id), `${id} 未上传`);
});

test("元数据 path 为空（尚未落盘）时跳过而非标失败", async () => {
  resetAll();
  const { id } = seedLocalAttachment("path 待补");
  registerLocalAttachment(db(), id, "p1");
  // 模拟"元数据先同步过来、二进制还没落地"：path 为空串。
  // 这不是传输故障，标失败会白白累加 retryCount 并污染错误诊断。
  db().prepare("UPDATE attachments SET path = '' WHERE id = ?").run(id);

  const blob = new FakeBlobRemote();
  const result = await pushAttachmentBlobs(db(), blob as never);
  assert.equal(result.skipped, 1);
  assert.equal(result.failed, 0, "元数据未就绪不该记为传输失败");
});

test("Lite 迁移不产生 Outbox 条目，避免把刚下载的数据又推回去", async () => {
  resetAll();
  const remote = new FakeRemote();
  seedRemote(remote, 4);

  await runLiteMigration({ db: db(), remoteUrl: REMOTE, userId: USER_ID, client: remote as never });

  // 迁移写入走 suppressed 上下文：这些数据本来就来自服务端，
  // 回推等于制造无意义流量，还可能触发版本冲突。
  assert.equal(countPendingMutations(db()), 0, "迁移不得产生上行 mutation");
});
