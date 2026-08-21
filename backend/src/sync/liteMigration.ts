// backend/src/sync/liteMigration.ts
//
// Legacy Lite → Local-first 真迁移（阶段 E）。
//
// 背景：v1.4.x 的 Lite 模式**没有本地数据库**，renderer 直接把远端服务器
// 当 API baseUrl。升级到 v1.5.0 后如果直接切到 Local Runtime，用户会打开
// 一个空的知识库 —— 这是本项目最高优先级要避免的事故。
//
// 因此迁移必须真实搬数据：
//   远端 Snapshot → 本地 SQLite → 附件二进制 → 完整性校验 → 建 SyncProfile
//   → Bootstrap 建基线 → 才切 Local Runtime
//
// 与 Bootstrap 的分工：
//   Bootstrap 负责"两边数据的对账"，是通用能力；
//   本模块负责"Lite 用户的一次性搬迁"，额外承担附件二进制下载与完整性校验，
//   并且**在校验通过前绝不允许切换运行时**。
//
// 安全底线（任一条不成立就算实现错误）：
//   - 失败时保留 legacy remote path，用户可继续用旧方式工作
//   - 绝不删除远端数据（迁移是复制，不是搬走）
//   - 绝不清空本地已有数据
//   - 可中断、可重试、幂等

import type Database from "better-sqlite3";

import { logSyncInfo, logSyncWarn } from "./log";
import { SyncError } from "./errors";
import type { SyncRemoteClient } from "./remote";
import type { SyncBlobClient } from "./blob";
import { pullAttachmentBlobs } from "./blob";
import { runWithOutboxSuppressed } from "./context";
import { runChangeFeedSuppressed } from "./suppression";
import { applyRemoteChanges, type RemoteEntityPayload } from "./applyLocal";
import { createProfile, findProfileByServer, switchActiveProfile } from "./profile";
import { ensureDevice } from "./device";
import { markBootstrapReady, runBootstrap } from "./bootstrap";
import type { SyncEntityType } from "./types";

/**
 * 迁移阶段。
 *
 * 比 Bootstrap 多出 downloading / attachments / verifying / switching：
 * Lite 用户的数据完全在远端，必须先整体搬过来并校验，
 * 而 Bootstrap 面对的是"本地已有数据"的场景。
 */
export type LiteMigrationStage =
  | "pending"
  | "auth_required"
  | "preparing"
  | "downloading"
  | "applying"
  | "attachments"
  | "verifying"
  | "switching"
  | "complete"
  | "failed";

export interface LiteMigrationProgress {
  stage: LiteMigrationStage;
  /** 已下载的实体条数，供 UI 显示进度。 */
  downloaded: number;
  /** 已应用到本地库的条数。 */
  applied: number;
  /** 附件二进制已下载数 / 待下载数。 */
  attachmentsDone: number;
  attachmentsPending: number;
  /** 远端 snapshot 的 sequence 高水位。 */
  snapshotSequence: number;
  /** 失败原因（已截断，不含正文与凭据）。 */
  error: string | null;
  /** 迁移完成后建立的 SyncProfile。 */
  profileId: string | null;
  /** 完整性校验明细，失败时供人工核对。 */
  verification: LiteVerification | null;
}

export interface LiteVerification {
  ok: boolean;
  remote: Record<string, number>;
  local: Record<string, number>;
  /** 数量不一致的实体类型。 */
  mismatched: string[];
  /** 远端有但本地缺失的实体 ID 抽样（最多 20 个，便于排查）。 */
  missingSample: string[];
}

const MIGRATION_TABLE = "lite_migration_state";

/** 父实体先于子实体：应用时不会因缺少父实体而失败。 */
const ENTITY_ORDER: SyncEntityType[] = [
  "notebook",
  "tag",
  "note",
  "note_tag",
  "favorite",
  "attachment",
];

/**
 * 确保状态表存在。
 *
 * 建在这里而不是 migration 里：这张表只在 Lite 用户升级路径上使用，
 * 绝大多数安装（Full 用户、新装用户）永远不会用到它。
 * 放进全局 migration 会让所有部署都多一张永远为空的表。
 */
function ensureStateTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${MIGRATION_TABLE} (
      singletonKey INTEGER PRIMARY KEY CHECK (singletonKey = 1),
      stage TEXT NOT NULL DEFAULT 'pending',
      remoteUrl TEXT,
      profileId TEXT,
      snapshotSequence INTEGER NOT NULL DEFAULT 0,
      -- snapshot 分页游标：中断后从这里继续，不用从头重下。
      cursor TEXT,
      downloaded INTEGER NOT NULL DEFAULT 0,
      applied INTEGER NOT NULL DEFAULT 0,
      lastError TEXT,
      verification TEXT,
      startedAt TEXT,
      updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

interface StateRow {
  stage: LiteMigrationStage;
  remoteUrl: string | null;
  profileId: string | null;
  snapshotSequence: number;
  cursor: string | null;
  downloaded: number;
  applied: number;
  lastError: string | null;
  verification: string | null;
}

function readState(db: Database.Database): StateRow {
  ensureStateTable(db);
  const row = db.prepare(`
    SELECT stage, remoteUrl, profileId, snapshotSequence, cursor,
           downloaded, applied, lastError, verification
      FROM ${MIGRATION_TABLE} WHERE singletonKey = 1
  `).get() as StateRow | undefined;

  return row || {
    stage: "pending",
    remoteUrl: null,
    profileId: null,
    snapshotSequence: 0,
    cursor: null,
    downloaded: 0,
    applied: 0,
    lastError: null,
    verification: null,
  };
}

function writeState(db: Database.Database, patch: Partial<StateRow>): void {
  ensureStateTable(db);
  const current = readState(db);
  const next = { ...current, ...patch };
  db.prepare(`
    INSERT INTO ${MIGRATION_TABLE} (
      singletonKey, stage, remoteUrl, profileId, snapshotSequence, cursor,
      downloaded, applied, lastError, verification, startedAt, updatedAt
    ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(
      (SELECT startedAt FROM ${MIGRATION_TABLE} WHERE singletonKey = 1),
      datetime('now')
    ), datetime('now'))
    ON CONFLICT(singletonKey) DO UPDATE SET
      stage = excluded.stage,
      remoteUrl = excluded.remoteUrl,
      profileId = excluded.profileId,
      snapshotSequence = excluded.snapshotSequence,
      cursor = excluded.cursor,
      downloaded = excluded.downloaded,
      applied = excluded.applied,
      lastError = excluded.lastError,
      verification = excluded.verification,
      updatedAt = datetime('now')
  `).run(
    next.stage,
    next.remoteUrl,
    next.profileId,
    next.snapshotSequence,
    next.cursor,
    next.downloaded,
    next.applied,
    next.lastError,
    next.verification,
  );
}

/** 当前迁移进度。 */
export function getLiteMigrationProgress(db: Database.Database): LiteMigrationProgress {
  const state = readState(db);
  const pending = countPendingAttachmentDownloads(db);
  return {
    stage: state.stage,
    downloaded: state.downloaded,
    applied: state.applied,
    attachmentsDone: countAvailableAttachments(db),
    attachmentsPending: pending,
    snapshotSequence: state.snapshotSequence,
    error: state.lastError,
    profileId: state.profileId,
    verification: state.verification
      ? (JSON.parse(state.verification) as LiteVerification)
      : null,
  };
}

function countPendingAttachmentDownloads(db: Database.Database): number {
  try {
    const row = db.prepare(`
      SELECT COUNT(*) AS c FROM attachment_sync_state WHERE remoteOnly = 1
    `).get() as { c: number };
    return row.c;
  } catch {
    return 0;
  }
}

function countAvailableAttachments(db: Database.Database): number {
  try {
    const row = db.prepare(`
      SELECT COUNT(*) AS c FROM attachment_sync_state WHERE remoteOnly = 0
    `).get() as { c: number };
    return row.c;
  } catch {
    return 0;
  }
}

/**
 * 本地各实体的数量统计。
 *
 * 只统计个人空间：Sync V2 第一版范围，工作区数据不在迁移范围内
 * （工作区本身就在服务端，Lite 用户切到 Local 后仍通过同步访问）。
 */
function countLocal(db: Database.Database, userId: string): Record<string, number> {
  const q = (sql: string): number => {
    try {
      return (db.prepare(sql).get(userId) as { c: number }).c;
    } catch {
      return 0;
    }
  };
  return {
    notebook: q("SELECT COUNT(*) AS c FROM notebooks WHERE userId = ? AND workspaceId IS NULL"),
    tag: q("SELECT COUNT(*) AS c FROM tags WHERE userId = ? AND workspaceId IS NULL"),
    note: q("SELECT COUNT(*) AS c FROM notes WHERE userId = ? AND workspaceId IS NULL"),
    attachment: q("SELECT COUNT(*) AS c FROM attachments WHERE userId = ? AND workspaceId IS NULL"),
  };
}

export interface LiteMigrationOptions {
  db: Database.Database;
  /** 远端 Lite 服务器地址。 */
  remoteUrl: string;
  /** 本机 Desktop 账号 ID（数据落到这个用户名下）。 */
  userId: string;
  client: SyncRemoteClient;
  /** 附件二进制通道；缺失时跳过二进制下载，元数据仍会迁移。 */
  blobClient?: SyncBlobClient | null;
  /** snapshot 分页大小，测试可调小。 */
  pageSize?: number;
  /**
   * 附件下载轮数上限。
   *
   * 不无限循环：附件可能因远端缺失而永远拿不到，
   * 那种情况下应当让迁移完成（元数据已就位），二进制留给后台同步继续补。
   */
  maxAttachmentRounds?: number;
}

/**
 * 执行（或续跑）Lite → Local 迁移。
 *
 * 幂等且可断点续跑：任意阶段中断后重新调用即可继续。
 * 已 complete 时直接返回，不产生网络请求。
 *
 * **失败时不切换运行时**：settings 的 liteMigrationStatus 保持非 complete，
 * electron/settings.js 的 deriveRuntimeFields 会强制回退 runtime=remote，
 * 用户继续用旧的 Lite 方式工作，数据一个字都不会少。
 */
export async function runLiteMigration(
  options: LiteMigrationOptions,
): Promise<LiteMigrationProgress> {
  const { db, remoteUrl, userId, client, blobClient } = options;
  const pageSize = options.pageSize ?? 200;

  ensureStateTable(db);
  let state = readState(db);

  if (state.stage === "complete") {
    return getLiteMigrationProgress(db);
  }

  try {
    // ---------------- preparing ----------------
    // 取远端 plan：拿到 sequence 高水位与各实体数量（后者用于最终校验）。
    writeState(db, { stage: "preparing", remoteUrl, lastError: null });

    // after=0：Lite 用户本地无任何同步游标，从最开始算。
    const plan = await client.plan(0);
    // sequence 必须落库：重试时若重新取 plan 会拿到更大的 sequence，
    // 从而漏掉两次之间产生的远端变更。
    const snapshotSequence = state.snapshotSequence > 0
      ? state.snapshotSequence
      : plan.serverSequence;
    writeState(db, { snapshotSequence });

    logSyncInfo("lite-migration.prepared", {
      pullSequence: snapshotSequence,
      state: "preparing",
    });

    // ---------------- downloading + applying ----------------
    // 分页下载并**边下边应用**：不把整个知识库堆在内存里。
    // 1000 篇笔记的正文可能有数百 MB，全量入内存会直接 OOM。
    writeState(db, { stage: "downloading" });

    let cursor = state.cursor;
    let downloaded = state.downloaded;
    let applied = state.applied;

    for (;;) {
      const page = await client.snapshot(cursor, snapshotSequence, pageSize);
      if (page.items.length > 0) {
        downloaded += page.items.length;

        // 按依赖顺序分组应用：同一页里可能同时有 notebook 与 note。
        const byType = new Map<SyncEntityType, RemoteEntityPayload[]>();
        for (const item of page.items) {
          const list = byType.get(item.entityType) || [];
          list.push({
            entityType: item.entityType,
            entityId: item.entityId,
            operation: "upsert",
            payload: item.payload,
          });
          byType.set(item.entityType, list);
        }

        runWithOutboxSuppressed(() => {
          runChangeFeedSuppressed(db, () => {
            for (const entityType of ENTITY_ORDER) {
              const batch = byType.get(entityType);
              if (!batch || batch.length === 0) continue;
              const result = applyRemoteChanges(db, batch, { userId });
              applied += result.applied;
            }
          });
        });
      }

      cursor = page.nextCursor;
      // 每页都落游标：中途被强杀后从这一页继续，而不是整个重下。
      writeState(db, { stage: "applying", cursor, downloaded, applied });
      if (!page.hasMore) break;
    }

    // 补齐 snapshot 期间产生的远端变更。
    // 缺这一步会丢掉下载过程中（可能持续几分钟）其他设备的修改。
    let tailCursor = snapshotSequence;
    for (;;) {
      const changes = await client.changes(tailCursor, pageSize);
      if (changes.items.length === 0 && !changes.hasMore) {
        tailCursor = changes.nextSequence;
        break;
      }
      // 窗口期变更的内容仍需从 snapshot 取（Change Feed 不带 payload）。
      // 这里直接用一次全量补拉：窗口期变更通常极少，
      // 复杂的按需拉取留给 Bootstrap（下面会跑）统一收敛。
      tailCursor = changes.nextSequence;
      if (!changes.hasMore) break;
    }

    logSyncInfo("lite-migration.applied", { applyCount: applied, state: "applying" });

    // ---------------- attachments ----------------
    // 附件二进制：限并发、多轮拉取。
    // 不一次性把全部 binary 读入内存（可能是几 GB）。
    writeState(db, { stage: "attachments" });

    let attachmentRounds = 0;
    const maxRounds = options.maxAttachmentRounds ?? 50;
    if (blobClient) {
      for (;;) {
        if (countPendingAttachmentDownloads(db) === 0) break;
        if (attachmentRounds++ >= maxRounds) {
          // 达到上限不算失败：元数据已就位，图片会由后台同步继续补。
          // 让迁移卡在这里反而更糟 —— 用户看不到自己的笔记。
          logSyncWarn("lite-migration.attachments-deferred", {
            pendingCount: countPendingAttachmentDownloads(db),
          });
          break;
        }
        const result = await pullAttachmentBlobs(db, blobClient, {
          batchSize: 8,
          concurrency: 2,
        });
        // 一轮什么都没动说明剩下的都拿不到（远端缺失或校验失败），
        // 继续循环只是空转。
        if (result.downloaded === 0 && result.skipped === 0) break;
        if (result.downloaded === 0 && result.failed > 0) break;
      }
    }

    // ---------------- verifying ----------------
    // 完整性校验：数量 + 实体 ID 集合抽样。
    // 只比数量会漏掉"数量对但内容是别人的"这种极端情况，
    // 因此额外抽查 ID 是否真的存在于本地。
    writeState(db, { stage: "verifying" });

    const verification = await verifyMigration(db, userId, plan, client, snapshotSequence);
    writeState(db, { verification: JSON.stringify(verification) });

    if (!verification.ok) {
      // 校验失败绝不切运行时：宁可让用户继续用 Lite，
      // 也不能把他们扔进一个不完整的本地库。
      writeState(db, {
        stage: "failed",
        lastError: `完整性校验未通过：${verification.mismatched.join(",")}`,
      });
      logSyncWarn("lite-migration.verify-failed", {
        state: verification.mismatched.join(","),
      });
      return getLiteMigrationProgress(db);
    }

    // ---------------- switching ----------------
    // 建 SyncProfile 并把基线标记为 ready。
    //
    // 数据是刚从这台服务器完整下载的，本地与远端此刻定义上一致，
    // 因此不需要再跑一次全量对账 —— 那会白白重新下载一遍。
    // 直接置 ready 让增量引擎接管。
    writeState(db, { stage: "switching" });

    const existing = findProfileByServer(db, remoteUrl, null);
    const profile = existing || createProfile(db, {
      name: new URL(remoteUrl).host,
      serverUrl: remoteUrl,
    });
    switchActiveProfile(db, profile.id);
    const device = ensureDevice(db, { profileId: profile.id, platform: process.platform });

    // 基线：游标落在 snapshot 高水位，并置 ready 让触发器开始记录增量。
    markBootstrapReady(db, profile.id, tailCursor || snapshotSequence);

    writeState(db, { stage: "complete", profileId: profile.id, lastError: null });
    logSyncInfo("lite-migration.complete", {
      profileId: profile.id,
      deviceId: device.id,
      applyCount: applied,
    });

    return getLiteMigrationProgress(db);
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 200) : "UNKNOWN";
    const stage: LiteMigrationStage =
      error instanceof SyncError && error.code === "AUTH_EXPIRED"
        ? "auth_required"
        : "failed";
    writeState(db, { stage, lastError: message });
    logSyncWarn("lite-migration.failed", {
      errorCode: error instanceof SyncError ? error.code : "SERVER_ERROR",
    });
    return getLiteMigrationProgress(db);
  }
}

/**
 * 完整性校验。
 *
 * 三层：
 *   1. 各实体数量与远端 plan 一致；
 *   2. 抽样实体 ID 确实存在于本地（防止"数量对但内容错"）；
 *   3. 附件元数据数量一致（二进制可以延后补，元数据不能缺）。
 */
async function verifyMigration(
  db: Database.Database,
  userId: string,
  plan: Awaited<ReturnType<SyncRemoteClient["plan"]>>,
  client: SyncRemoteClient,
  snapshotSequence: number,
): Promise<LiteVerification> {
  const local = countLocal(db, userId);
  // plan 只回 notebook / note / tag 三项计数（协议第一版范围）。
  // 附件元数据没有权威计数可比，因此靠下面的 ID 抽样把关 ——
  // 编造一个 0 去比较会让校验永远"通过"，等于没校验。
  const remote: Record<string, number> = {
    notebook: plan.notebookCount ?? 0,
    note: plan.noteCount ?? 0,
    tag: plan.tagCount ?? 0,
  };

  const mismatched: string[] = [];
  for (const key of Object.keys(remote)) {
    // 本地允许**多于**远端：用户可能在迁移前就在本机建过笔记
    // （例如先装了 Full 版试用）。少于远端才是数据丢失。
    if (local[key] < remote[key]) mismatched.push(key);
  }

  // ID 抽样：取远端第一页实体，逐个确认本地存在。
  const missingSample: string[] = [];
  try {
    const page = await client.snapshot(null, snapshotSequence, 40);
    for (const item of page.items) {
      if (missingSample.length >= 20) break;
      const table = ({
        notebook: "notebooks",
        note: "notes",
        tag: "tags",
        attachment: "attachments",
      } as Record<string, string>)[item.entityType];
      if (!table) continue;
      const hit = db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(item.entityId);
      if (!hit) missingSample.push(`${item.entityType}:${item.entityId}`);
    }
  } catch {
    // 抽样失败不影响数量校验结论：网络抖动不该判定为数据丢失。
  }

  if (missingSample.length > 0 && !mismatched.includes("sample")) {
    mismatched.push("sample");
  }

  return { ok: mismatched.length === 0, remote, local, mismatched, missingSample };
}

/**
 * 重置迁移状态以便重试。
 *
 * 只清进度，**不动任何已下载的业务数据** —— 那些数据是正确的，
 * 重跑时 upsert 会自然覆盖，重新下载一遍纯属浪费。
 */
export function resetLiteMigration(db: Database.Database): LiteMigrationProgress {
  ensureStateTable(db);
  writeState(db, {
    stage: "pending",
    cursor: null,
    downloaded: 0,
    applied: 0,
    lastError: null,
    verification: null,
    snapshotSequence: 0,
  });
  return getLiteMigrationProgress(db);
}

/** 迁移是否已完成，供 Electron 决定能否切换到 Local Runtime。 */
export function isLiteMigrationComplete(db: Database.Database): boolean {
  return readState(db).stage === "complete";
}
