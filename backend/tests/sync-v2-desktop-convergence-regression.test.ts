import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before, beforeEach } from "node:test";

import Database from "better-sqlite3";
import { Hono } from "hono";

import { getDb, getDbPath } from "../src/db/schema";
import { ensureNormalizedSearchFts } from "../src/lib/searchIndex";
import { installNotebookTreeIntegrityGuards } from "../src/runtime/notebook-tree-hardening";
import syncV2Routes from "../src/routes/sync-v2";
import { applyRemoteChanges } from "../src/sync/applyLocal";
import { runBootstrap, reconcile } from "../src/sync/bootstrap";
import { listUnresolvedConflicts } from "../src/sync/conflict";
import { ensureDevice, getDevice } from "../src/sync/device";
import { SyncEngine } from "../src/sync/engine";
import { isKnowledgeTreeSyncReady, resetKnowledgeTreeSyncReadiness } from "../src/sync/knowledgeTreeReadiness";
import { runLiteMigration } from "../src/sync/liteMigration";
import { countPendingMutations } from "../src/sync/outbox";
import { createProfile, getSyncState, switchActiveProfile } from "../src/sync/profile";
import { reconcileSyncEngine, stopSyncEngine } from "../src/sync/runtime";
import { recordConflict } from "../src/sync/conflict";
import { saveRemoteCredential, clearRemoteCredential } from "../src/sync/credentials";
import { refreshWorkspaceScopeStates } from "../src/sync/workspaceScopes";
import { SyncRemoteClient, type FetchLike } from "../src/sync/remote";

const NAS_USER = "nas-owner-0001";
const WIN_USER = "win-local-9999";
const SERVER_URL = "http://nas-convergence.test";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-sync-convergence-"));
let templatePath = "";
let nas: Database.Database;
let nasApp: Hono;
const opened: Database.Database[] = [];

let forcedSnapshotLimit: number | null = null;
let snapshotMutator: ((items: Array<{ entityType: string; entityId: string; payload: Record<string, unknown> }>) => void) | null = null;

before(() => {
  process.env.NOWEN_LOCAL_FIRST_SYNC_V2 = "1";
  nas = getDb();
  installNotebookTreeIntegrityGuards(nas);
  nas.pragma("wal_checkpoint(TRUNCATE)");
  templatePath = path.join(tmpDir, "template.db");
  fs.copyFileSync(getDbPath(), templatePath);
  nas.prepare(`
    INSERT OR IGNORE INTO users (id, username, passwordHash, createdAt, updatedAt)
    VALUES (?, ?, 'x', datetime('now'), datetime('now'))
  `).run(NAS_USER, NAS_USER);

  nasApp = new Hono();
  nasApp.use("*", async (c, next) => {
    c.req.raw.headers.set("X-User-Id", NAS_USER);
    await next();
  });
  nasApp.route("/api/sync/v2", syncV2Routes);
});

after(() => {
  for (const db of opened) {
    try { db.close(); } catch { /* ignore */ }
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  forcedSnapshotLimit = null;
  snapshotMutator = null;
  nas.exec(`
    DELETE FROM sync_v2_snapshot_sessions;
    DELETE FROM sync_v2_clients;
    DELETE FROM sync_v2_applied_mutations;
    DELETE FROM sync_changes_v2;
    DELETE FROM asset_sync_metadata;
    DELETE FROM attachment_folders;
    DELETE FROM note_tags;
    DELETE FROM favorites;
    DELETE FROM attachments;
    DELETE FROM notes;
    DELETE FROM tags;
    DELETE FROM notebooks;
    DELETE FROM knowledge_tree_nodes;
  `);
});

const nasFetch: FetchLike = async (url, init) => {
  const target = new URL(url);
  if (forcedSnapshotLimit !== null && target.pathname.endsWith("/snapshot")) {
    target.searchParams.set("limit", String(forcedSnapshotLimit));
  }
  const response = await nasApp.request(`${target.pathname}${target.search}`, {
    method: init?.method,
    headers: init?.headers,
    body: init?.body,
  });
  if (snapshotMutator && target.pathname.endsWith("/snapshot") && response.ok) {
    const body = await response.json() as {
      items: Array<{ entityType: string; entityId: string; payload: Record<string, unknown> }>;
    };
    snapshotMutator(body.items);
    return {
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  }
  return response as never;
};

function createClient(): SyncRemoteClient {
  return new SyncRemoteClient({ serverUrl: SERVER_URL, token: "test-token" }, { fetchImpl: nasFetch });
}

function openWinDb(label: string): Database.Database {
  const file = path.join(tmpDir, `${label}-${randomUUID().slice(0, 8)}.db`);
  fs.copyFileSync(templatePath, file);
  const db = new Database(file);
  db.pragma("foreign_keys = ON");
  ensureNormalizedSearchFts(db);
  installNotebookTreeIntegrityGuards(db);
  db.prepare(`
    INSERT OR IGNORE INTO users (id, username, passwordHash, createdAt, updatedAt)
    VALUES (?, ?, 'x', datetime('now'), datetime('now'))
  `).run(WIN_USER, WIN_USER);
  opened.push(db);
  return db;
}

function seedNasNotebook(id: string, parentId: string | null, name: string): string {
  nas.prepare(`
    INSERT INTO notebooks (id, userId, parentId, name, icon, sortOrder, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, '📒', 0, datetime('now'), datetime('now'))
  `).run(id, NAS_USER, parentId, name);
  return id;
}

function seedNasNote(notebookId: string, title: string, id = randomUUID()): string {
  nas.prepare(`
    INSERT INTO notes (id, userId, notebookId, title, content, contentText, contentFormat, version, sortOrder, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, '{"type":"doc","content":[]}', ?, 'tiptap-json', 1, 0, datetime('now'), datetime('now'))
  `).run(id, NAS_USER, notebookId, title, `正文：${title}`);
  return id;
}

test("DCC-004 / DCC-005 / DCC-007: Windows PC clean first download with different userId converges with 0 conflicts, valid cursor/timestamps, tree structure and asset sync", async () => {
  const folderA = seedNasNotebook(randomUUID(), null, "目录 A");
  const folderB = seedNasNotebook(randomUUID(), folderA, "子目录 B");
  const noteParent = seedNasNote(folderA, "父文档");
  const noteChild = seedNasNote(folderA, "子文档（文档下文档）");
  const noteInB = seedNasNote(folderB, "子目录文档");

  // 模拟真实 NAS 知识树特征：文档挂在文档下 + 自定义排序 + 附件文件节点 + 根文档隐藏容器
  nas.prepare("UPDATE knowledge_tree_nodes SET parentId = ?, sortOrder = 42 WHERE id = ?")
    .run(`note:${noteParent}`, `note:${noteChild}`);
  nas.prepare("UPDATE knowledge_tree_nodes SET sortOrder = 15 WHERE id = ?")
    .run(`notebook:${folderA}`);

  const rootContainer = `__nowen_root_documents__:personal:${NAS_USER}`;
  nas.prepare(`
    INSERT INTO notebooks (id, userId, parentId, name, icon, sortOrder, isExpanded, isDeleted, createdAt, updatedAt)
    VALUES (?, ?, NULL, '__NOWEN_ROOT_DOCUMENTS__', '📄', -2147483648, 0, 0, datetime('now'), datetime('now'))
  `).run(rootContainer, NAS_USER);
  seedNasNote(rootContainer, "根文档");
  nas.prepare("UPDATE notebooks SET isDeleted = 1, deletedAt = datetime('now') WHERE id = ?").run(rootContainer);
  nas.prepare("DELETE FROM knowledge_tree_nodes WHERE id = ?").run(`notebook:${rootContainer}`);

  // 附件与附件整理目录（归属 NAS_USER，与 WIN_USER 不同）
  const attId = randomUUID();
  nas.prepare(`
    INSERT INTO attachments (id, noteId, userId, filename, mimeType, size, path, hash)
    VALUES (?, ?, ?, 'spec.pdf', 'application/pdf', 128, '/nas/spec.pdf', 'hash-spec')
  `).run(attId, noteInB, NAS_USER);
  nas.prepare(`
    INSERT INTO knowledge_tree_nodes (
      id, userId, workspaceId, scopeKey, parentId, nodeType, resourceType, resourceId, sortOrder, isDeleted
    ) VALUES (?, ?, NULL, ?, ?, 'file', 'file', ?, 7, 0)
  `).run(`file:${attId}`, NAS_USER, `personal:${NAS_USER}`, `notebook:${folderB}`, attId);

  const assetFolderId = randomUUID();
  nas.prepare("INSERT INTO attachment_folders (id, userId, name) VALUES (?, ?, 'NAS 附件目录')")
    .run(assetFolderId, NAS_USER);
  nas.prepare("UPDATE attachments SET folderId = ? WHERE id = ?")
    .run(assetFolderId, attId);

  const win = openWinDb("win-clean");
  const progress = await runLiteMigration({
    db: win,
    remoteUrl: SERVER_URL,
    userId: WIN_USER,
    remoteUserId: NAS_USER,
    client: createClient(),
    pageSize: 3,
  });
  assert.equal(progress.stage, "complete", `首次迁移失败: ${progress.error} ${JSON.stringify(progress.diagnostic)}`);
  assert.ok(progress.profileId);

  const device = ensureDevice(win, { profileId: progress.profileId!, platform: "win32" });
  const engine = new SyncEngine({
    db: win,
    profileId: progress.profileId!,
    deviceId: device.id,
    userId: WIN_USER,
    client: createClient(),
    intervalMs: 0,
  });

  try {
    const status1 = await engine.syncOnce();
    assert.equal(status1.lastError, null, `首轮同步失败: ${JSON.stringify(status1)}`);
    assert.equal(status1.conflictCount, 0, "全新 Windows PC 首次同步不应产生误报冲突");
    assert.ok(status1.localCursor > 0, `本地游标应 > 0，实际 ${status1.localCursor}`);

    const state = getSyncState(win, progress.profileId!, "personal");
    assert.ok(state && state.lastSequence > 0, "sync_state.lastSequence 不应被重置为 0");
    assert.ok(state?.lastSyncAt, "sync_state.lastSyncAt 不应为 NULL");
    assert.equal(state?.lastError, null);

    const deviceRow = getDevice(win, device.id);
    assert.ok(deviceRow?.lastSeenAt, "最近通信时间 lastSeenAt 应被记录");

    assert.equal(isKnowledgeTreeSyncReady(win, progress.profileId!, "personal"), true, "知识树协议应自动就绪");
    assert.equal(
      (win.prepare("SELECT ready FROM asset_sync_bindings WHERE profileId = ? AND userId = ?")
        .get(progress.profileId!, WIN_USER) as { ready: number } | undefined)?.ready,
      1,
      "跨 userId 时附件整理同步绑定应成功完成",
    );

    // 验证知识树特殊结构完整保留
    const childTree = win.prepare("SELECT parentId, sortOrder FROM knowledge_tree_nodes WHERE id = ?")
      .get(`note:${noteChild}`) as { parentId: string | null; sortOrder: number } | undefined;
    assert.deepEqual(childTree, { parentId: `note:${noteParent}`, sortOrder: 42 });

    const fileTree = win.prepare("SELECT parentId, sortOrder FROM knowledge_tree_nodes WHERE id = ?")
      .get(`file:${attId}`) as { parentId: string | null; sortOrder: number } | undefined;
    assert.deepEqual(fileTree, { parentId: `notebook:${folderB}`, sortOrder: 7 });

    // 验证桌面端新建附件目录可正常推回 NAS（尽管 WIN_USER !== NAS_USER）
    const winFolderId = randomUUID();
    win.prepare("INSERT INTO attachment_folders (id, userId, name) VALUES (?, ?, 'PC 新建目录')")
      .run(winFolderId, WIN_USER);
    const status2 = await engine.syncOnce();
    assert.equal(status2.lastError, null, `桌面推送附件目录失败: ${JSON.stringify(status2)}`);
    assert.equal(countPendingMutations(win, progress.profileId!), 0);
    assert.equal(
      (nas.prepare("SELECT name FROM attachment_folders WHERE id = ? AND userId = ?")
        .get(winFolderId, NAS_USER) as { name: string } | undefined)?.name,
      "PC 新建目录",
    );
  } finally {
    engine.stop();
  }
});

test("DCC-005 / DCC-007: multi-page runSnapshotRebuild handles cross-page notebooks, deleted tree subtrees, and cross-userId asset organization without DATA_STRUCTURE", async () => {
  const liveParent = seedNasNotebook(randomUUID(), null, "活父目录");
  const liveChild = seedNasNotebook(randomUUID(), liveParent, "活子目录");
  const deadParent = seedNasNotebook(randomUUID(), null, "已删父目录");
  const deadChild = seedNasNotebook(randomUUID(), deadParent, "已删子目录");
  seedNasNote(liveChild, "活笔记");
  seedNasNote(deadChild, "已删子树里的笔记");
  // 软删除整棵子树
  nas.prepare("UPDATE notebooks SET isDeleted = 1, deletedAt = datetime('now') WHERE id IN (?, ?)")
    .run(deadParent, deadChild);
  nas.prepare("UPDATE notes SET isTrashed = 1, trashedAt = datetime('now') WHERE notebookId = ?")
    .run(deadChild);

  const assetFolder = randomUUID();
  nas.prepare("INSERT INTO attachment_folders (id, userId, name) VALUES (?, ?, '分页附件目录')")
    .run(assetFolder, NAS_USER);

  const win = openWinDb("win-multipage");
  const profile = createProfile(win, { name: "NAS", serverUrl: SERVER_URL, remoteUserId: NAS_USER });
  switchActiveProfile(win, profile.id);
  const device = ensureDevice(win, { profileId: profile.id, platform: "win32" });

  // 先完成 bootstrap（localEmpty），随后强制把 personal 标记为 replan_required 并以极小分页（limit=2）跑 runSnapshotRebuild
  const boot = await runBootstrap({
    db: win,
    profileId: profile.id,
    deviceId: device.id,
    userId: WIN_USER,
    client: createClient(),
    pageSize: 2,
  });
  assert.equal(boot.status, "ready");
  assert.equal(boot.conflicts, 0);

  // 强制触发极小分页的 Snapshot Rebuild（包含 12 类实体，确保 deleted parent 与 deleted child 跨页）
  forcedSnapshotLimit = 2;
  win.prepare(`
    INSERT INTO sync_workspace_scopes (
      profileId, scopeKey, workspaceId, workspaceName, role, canWrite,
      accessFingerprint, accessStatus, updatedAt
    ) VALUES (?, 'personal', NULL, NULL, NULL, 1, 'stale-fingerprint', 'replan_required', datetime('now'))
    ON CONFLICT(profileId, scopeKey) DO UPDATE SET
      accessFingerprint = 'stale-fingerprint',
      accessStatus = 'replan_required'
  `).run(profile.id);

  const engine = new SyncEngine({
    db: win,
    profileId: profile.id,
    deviceId: device.id,
    userId: WIN_USER,
    client: createClient(),
    intervalMs: 0,
  });
  try {
    const status = await engine.syncOnce();
    assert.equal(status.lastError, null, `多页 Snapshot Rebuild 失败: ${JSON.stringify(status)}`);
    assert.equal(status.conflictCount, 0);
    assert.ok(status.localCursor > 0);
    const deadChildTree = win.prepare("SELECT parentId, isDeleted FROM knowledge_tree_nodes WHERE id = ?")
      .get(`notebook:${deadChild}`) as { parentId: string | null; isDeleted: number } | undefined;
    assert.deepEqual(deadChildTree, { parentId: `notebook:${deadParent}`, isDeleted: 1 });
  } finally {
    engine.stop();
  }
});

test("DCC-003: knowledge tree note/notebook triggers never fail with KNOWLEDGE_TREE_PARENT_SCOPE_MISMATCH when parent tree projection is hidden or deleted", () => {
  const win = openWinDb("win-trigger-guard");
  const containerId = `__nowen_root_documents__:${NAS_USER}`;
  // 模拟一个在 notebooks 表中 isDeleted=0 但 knowledge_tree_nodes 中已被隐藏/不存在的容器目录
  win.prepare(`
    INSERT INTO notebooks (id, userId, parentId, name, icon, sortOrder, isDeleted, createdAt, updatedAt)
    VALUES (?, ?, NULL, '根文档容器', '📒', 0, 0, datetime('now'), datetime('now'))
  `).run(containerId, WIN_USER);
  win.prepare("DELETE FROM knowledge_tree_nodes WHERE id = ?").run(`notebook:${containerId}`);

  const noteId = randomUUID();
  const result = applyRemoteChanges(win, [{
    entityType: "note",
    entityId: noteId,
    operation: "upsert",
    payload: {
      id: noteId,
      notebookId: containerId,
      title: "容器下笔记",
      content: "{}",
      contentText: "hello",
      contentFormat: "richtext",
      version: 1,
    },
  }], { userId: WIN_USER });

  assert.equal(result.applied, 1);
  const tree = win.prepare("SELECT parentId FROM knowledge_tree_nodes WHERE id = ?")
    .get(`note:${noteId}`) as { parentId: string | null } | undefined;
  assert.equal(tree?.parentId ?? null, null);
});

test("DCC-003: remote permanent deletion of trashed attachment and its parent note succeeds without ATTACHMENT_TRASH_RETAINED while local guard remains active", () => {
  const win = openWinDb("win-trash-delete");
  const nbId = randomUUID();
  const note1 = randomUUID();
  const note2 = randomUUID();
  const att1 = randomUUID();
  const att2 = randomUUID();
  const attLocal = randomUUID();

  win.prepare("INSERT INTO notebooks (id, userId, name) VALUES (?, ?, '默认')").run(nbId, WIN_USER);
  win.prepare("INSERT INTO notes (id, userId, notebookId, title, content) VALUES (?, ?, ?, 'n1', '{}')").run(note1, WIN_USER, nbId);
  win.prepare("INSERT INTO notes (id, userId, notebookId, title, content) VALUES (?, ?, ?, 'n2', '{}')").run(note2, WIN_USER, nbId);
  win.prepare(`
    INSERT INTO attachments (id, noteId, userId, filename, mimeType, size, path, trashedAt)
    VALUES (?, ?, ?, 'a1.txt', 'text/plain', 4, '/tmp/a1', datetime('now')),
           (?, ?, ?, 'a2.txt', 'text/plain', 4, '/tmp/a2', datetime('now')),
           (?, ?, ?, 'local.txt', 'text/plain', 4, '/tmp/local', datetime('now'))
  `).run(att1, note1, WIN_USER, att2, note2, WIN_USER, attLocal, note1, WIN_USER);

  // 本地非同步裸 DELETE 仍受 ATTACHMENT_TRASH_RETAINED 保护
  assert.throws(
    () => win.prepare("DELETE FROM attachments WHERE id = ?").run(attLocal),
    /ATTACHMENT_TRASH_RETAINED/,
  );

  // 远端权威删除单条已回收附件
  const res1 = applyRemoteChanges(win, [{
    entityType: "attachment",
    entityId: att1,
    operation: "delete",
  }], { userId: WIN_USER });
  assert.equal(res1.applied, 1);
  assert.equal(win.prepare("SELECT 1 FROM attachments WHERE id = ?").get(att1), undefined);

  // 远端权威永久删除包含已回收附件的笔记（ON DELETE CASCADE 不应撞 ATTACHMENT_TRASH_RETAINED）
  const res2 = applyRemoteChanges(win, [{
    entityType: "note",
    entityId: note2,
    operation: "delete",
  }], { userId: WIN_USER });
  assert.equal(res2.applied, 1);
  assert.equal(win.prepare("SELECT 1 FROM notes WHERE id = ?").get(note2), undefined);
  assert.equal(win.prepare("SELECT 1 FROM attachments WHERE id = ?").get(att2), undefined);
});

test("DCC-004: reconcile ignores wire capability / default column drift from older servers but preserves genuine content conflicts", () => {
  const noteId = randomUUID();
  const nbId = randomUUID();

  // 模拟：本地已按新版本 schema 落库，远端来自旧版本 NAS（缺少 encryptedBlocksVersion / note_type / themeId=''）
  const samePlan = reconcile(
    [{
      entityType: "note",
      entityId: noteId,
      operation: "upsert",
      payload: {
        id: noteId,
        notebookId: nbId,
        title: "周报",
        content: "{}",
        contentText: "hello",
        contentFormat: "richtext",
        note_type: "normal",
        isPinned: 0,
        isFavorite: 0,
        isLocked: 0,
        isArchived: 0,
        isTrashed: 0,
        trashedAt: null,
        themeId: null,
        sortOrder: 0,
        version: 2,
        createdAt: "2026-01-01 00:00:00",
        encryptedBlocksVersion: 1,
      },
    }],
    [{
      entityType: "note",
      entityId: noteId,
      operation: "upsert",
      payload: {
        id: noteId,
        notebookId: nbId,
        title: "周报",
        content: "{}",
        contentText: "hello",
        contentFormat: "richtext",
        isPinned: false,
        isFavorite: 0,
        isLocked: 0,
        isArchived: 0,
        isTrashed: 0,
        trashedAt: null,
        themeId: "",
        sortOrder: 0,
        version: 2,
        createdAt: "2026-01-01 00:00:00",
      },
    }],
  );
  assert.equal(samePlan.conflicts.length, 0, "仅协议能力字段/默认值形态差异不应产生误报冲突");

  // 真正的正文差异必须保留冲突（DCC-004）
  const diffPlan = reconcile(
    [{
      entityType: "note",
      entityId: noteId,
      operation: "upsert",
      payload: {
        id: noteId,
        notebookId: nbId,
        title: "周报",
        content: "{\"local\":1}",
        contentText: "本地改动",
        contentFormat: "richtext",
        note_type: "normal",
        encryptedBlocksVersion: 1,
      },
    }],
    [{
      entityType: "note",
      entityId: noteId,
      operation: "upsert",
      payload: {
        id: noteId,
        notebookId: nbId,
        title: "周报",
        content: "{\"remote\":2}",
        contentText: "远端改动",
        contentFormat: "richtext",
      },
    }],
  );
  assert.equal(diffPlan.conflicts.length, 1, "真实正文分歧必须记入冲突台账");
});

test("DCC-003: DATA_STRUCTURE failure in SyncEngine persists sanitized lastErrorDiagnostic without leaking content", async () => {
  const nb = seedNasNotebook(randomUUID(), null, "正常目录");
  const secretTitle = "绝密笔记标题-不可泄露";
  const noteId = seedNasNote(nb, secretTitle);

  const win = openWinDb("win-diag");
  const profile = createProfile(win, { name: "NAS", serverUrl: SERVER_URL, remoteUserId: NAS_USER });
  switchActiveProfile(win, profile.id);
  const device = ensureDevice(win, { profileId: profile.id, platform: "win32" });
  win.prepare("UPDATE sync_profiles SET bootstrapStatus = 'ready' WHERE id = ?").run(profile.id);

  // 制造一个不可恢复的外键错误，触发 DATA_STRUCTURE
  snapshotMutator = (items) => {
    for (const item of items) {
      if (item.entityType === "note" && item.entityId === noteId) {
        item.payload.notebookId = randomUUID();
      }
    }
  };

  const engine = new SyncEngine({
    db: win,
    profileId: profile.id,
    deviceId: device.id,
    userId: WIN_USER,
    client: createClient(),
    intervalMs: 0,
  });
  try {
    const status = await engine.syncOnce();
    assert.equal(status.lastError, "DATA_STRUCTURE");
    const state = getSyncState(win, profile.id, "personal");
    assert.equal(state?.lastError, "DATA_STRUCTURE");
    assert.ok(state?.lastErrorDiagnostic, "应持久化脱敏诊断详情");
    const parsed = JSON.parse(state!.lastErrorDiagnostic!);
    assert.equal(parsed.sqliteCode, "SQLITE_CONSTRAINT_FOREIGNKEY");
    assert.equal(parsed.entityType, "note");
    assert.ok(!state!.lastErrorDiagnostic!.includes(secretTitle), "诊断详情绝不能包含笔记标题或正文");
    assert.ok(!state!.lastErrorDiagnostic!.includes(noteId), "诊断详情里的实体 ID 必须脱敏");
  } finally {
    engine.stop();
  }
});

test("DCC-003 / DCC-006: multi-user local DB binds SyncEngine to actual owner and upgrades broken v1.6.1 DB without NOTEBOOK_ID_COLLISION or replan flip", async () => {
  const folder = seedNasNotebook(randomUUID(), null, "用户目录");
  const note = seedNasNote(folder, "用户笔记");

  const win = openWinDb("win-multi-user");
  // 模拟真实用户日志中的场景：本地库里先存在一个更早创建的旧账号（User A，空账号），
  // 用户手动登录的是第二个账号（WIN_USER），并把 NAS 数据迁移到了 WIN_USER 名下。
  const OLD_EMPTY_USER = "older-default-desktop-user";
  win.prepare(`
    INSERT INTO users (id, username, passwordHash, createdAt, updatedAt)
    VALUES (?, 'desktop', 'x', '2025-01-01 00:00:00', '2025-01-01 00:00:00')
  `).run(OLD_EMPTY_USER);
  win.prepare("UPDATE users SET createdAt = '2026-01-01 00:00:00' WHERE id = ?").run(WIN_USER);

  const progress = await runLiteMigration({
    db: win,
    remoteUrl: SERVER_URL,
    userId: WIN_USER,
    remoteUserId: NAS_USER,
    client: createClient(),
    pageSize: 5,
  });
  assert.equal(progress.stage, "complete");
  const profileId = progress.profileId!;

  // 1. 模拟从 v1.6.1 升级：localUserId 尚未写入，且残留上一版错绑空账号导致的幽灵冲突与 DATA_STRUCTURE
  win.prepare("UPDATE sync_profiles SET localUserId = NULL WHERE id = ?").run(profileId);
  resetKnowledgeTreeSyncReadiness(win, profileId, "personal");
  const remoteFolderTree = nas.prepare("SELECT * FROM knowledge_tree_nodes WHERE id = ?").get(`notebook:${folder}`) as Record<string, unknown>;
  const remoteNoteTree = nas.prepare("SELECT * FROM knowledge_tree_nodes WHERE id = ?").get(`note:${note}`) as Record<string, unknown>;
  recordConflict(win, {
    profileId,
    scopeKey: "personal",
    entityType: "knowledge_tree_node",
    entityId: `notebook:${folder}`,
    localPayload: null,
    remotePayload: remoteFolderTree,
  });
  recordConflict(win, {
    profileId,
    scopeKey: "personal",
    entityType: "knowledge_tree_node",
    entityId: `note:${note}`,
    localPayload: null,
    remotePayload: remoteNoteTree,
  });
  assert.equal(listUnresolvedConflicts(win, profileId).length, 2);

  // 2. 启动 runtime（模拟重启后 index.ts 调用 reconcileSyncEngine(db) 不传 userId）：
  // 必须选中真正持有个人笔记/目录的 WIN_USER，而不是更早创建的 OLD_EMPTY_USER
  saveRemoteCredential({ profileId, serverUrl: SERVER_URL, token: "test-token", remoteUserId: NAS_USER });
  try {
    const started = reconcileSyncEngine(win, { intervalMs: 0 });
    assert.ok(started);
    // 立刻停掉真实网络的定时器和 realtime，改用进程内 client 验证同一绑定后的 localUserId
    stopSyncEngine();
    const bound = win.prepare("SELECT localUserId FROM sync_profiles WHERE id = ?").get(profileId) as { localUserId: string | null };
    assert.equal(bound.localUserId, WIN_USER, "升级后应自动识别并绑定真正持有数据的本地账号 WIN_USER");

    const device = ensureDevice(win, { profileId, platform: "win32" });
    const engine = new SyncEngine({
      db: win,
      profileId,
      deviceId: device.id,
      userId: bound.localUserId!,
      client: createClient(),
      intervalMs: 0,
    });
    try {
      const status = await engine.syncOnce();
      assert.equal(status.lastError, null, `切回正确账号后不应再出现 NOTEBOOK_ID_COLLISION: ${JSON.stringify(status)}`);
      assert.equal(listUnresolvedConflicts(win, profileId).length, 0, "两端已完全一致的 v1.6.1 幽灵树冲突应自动销账");
      assert.equal(isKnowledgeTreeSyncReady(win, profileId, "personal"), true);
    } finally {
      engine.stop();
    }
  } finally {
    stopSyncEngine();
    clearRemoteCredential(profileId);
  }

  // 3. 验证 workspaceScopes 不会在 replan_required 尚未完成时把状态提前翻回 active
  win.prepare(`
    INSERT INTO sync_workspace_scopes (
      profileId, scopeKey, workspaceId, workspaceName, role, canWrite,
      accessFingerprint, accessStatus, updatedAt
    ) VALUES (?, 'workspace:ws-test', 'ws-test', 'Team', 'editor', 1, 'fp-1', 'replan_required', datetime('now'))
    ON CONFLICT(profileId, scopeKey) DO UPDATE SET
      accessFingerprint = 'fp-1', accessStatus = 'replan_required'
  `).run(profileId);
  const refreshed = refreshWorkspaceScopeStates(win, profileId, [{
    scopeKey: "workspace:ws-test",
    workspaceId: "ws-test",
    workspaceName: "Team",
    role: "editor",
    canWrite: true,
    accessFingerprint: "fp-1",
  }], WIN_USER);
  const wsScope = refreshed.find((s) => s.scopeKey === "workspace:ws-test");
  assert.equal(wsScope?.accessStatus, "replan_required", "上一轮重建失败后不能因指纹未变就提前翻回 active");
});

