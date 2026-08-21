/**
 * Bootstrap / Reconcile：首次开启同步时的基线建立（阶段 D）。
 *
 * ## 核心原则
 *
 * 首次同步不是"重放历史操作"，而是"对账当前状态"。
 *
 * 三种场景：
 *   Local 有 / Remote 空  → 本地当前状态上传
 *   Local 空 / Remote 有  → Remote Snapshot 下载
 *   两边都有              → 按 Stable Entity ID 合并
 *
 * 合并规则（禁止标题匹配、禁止 LWW）：
 *   ID 只在本地      → 上传
 *   ID 只在远端      → 下载
 *   ID 相同 + 内容同 → 已一致，跳过
 *   ID 相同 + 内容异 → **进 sync_conflicts**，两个版本都保留
 *
 * ## 一致性：sequence high-water
 *
 *   plan → serverSequence = N
 *   snapshot(at N) 分页下载并应用
 *   changes(after N) 补齐窗口期增量
 *   → 收敛
 *
 * 少了最后一步就会丢掉 snapshot 下载期间服务端产生的变更。
 *
 * ## Resumable
 *
 * 进度全部落库（bootstrapStatus / bootstrapCursor / bootstrapSequence），
 * 任意阶段被强杀后重启可从当前阶段继续。已应用实体由 upsert 语义幂等。
 *
 * ## 本地编辑不被阻塞
 *
 * bootstrapStatus 未到 ready 时 v87 的触发器不写 Outbox，
 * 因此期间的本地修改只落本地库；pushing 阶段扫描的是当前最终状态，
 * 天然把这些修改一并上传。不需要"禁止用户编辑几分钟"。
 */

import type Database from "better-sqlite3";

import { SYNC_PERSONAL_SCOPE_KEY, SYNC_SNAPSHOT_PAGE_SIZE } from "./constants";
import { SyncError } from "./errors";
import { logSyncInfo, logSyncWarn } from "./log";
import { getDb } from "../db/schema";
import { recordConflict } from "./conflict";
import { advanceSyncState } from "./profile";
import { runWithOutboxSuppressed } from "./context";
import { runChangeFeedSuppressed } from "./suppression";
import { applyRemoteChanges } from "./applyLocal";
import type { RemoteEntityPayload } from "./applyLocal";
import type { SyncRemoteClient } from "./remote";
import type { SyncEntityType } from "./types";

export type BootstrapStatus =
  | "pending"
  | "preparing"
  | "pulling"
  | "reconciling"
  | "pushing"
  | "verifying"
  | "ready"
  | "failed";

export interface BootstrapProgress {
  status: BootstrapStatus;
  /** snapshot 时刻的服务端 high-water sequence。 */
  sequence: number | null;
  cursor: string | null;
  error: string | null;
  /** 本轮下载并应用的实体数。 */
  pulled: number;
  /** 本轮上传的实体数。 */
  pushed: number;
  /** 进入冲突台账的实体数。 */
  conflicts: number;
}

/**
 * 第一版同步实体的推送顺序。
 *
 * 父实体必须先于子实体：先 notebook 再 note，否则服务端会因缺少
 * 父实体而拒绝；note_tag / favorite 依赖 note 与 tag 都已存在。
 */
const BOOTSTRAP_ENTITY_ORDER: SyncEntityType[] = [
  "notebook",
  "tag",
  "note",
  "note_tag",
  "favorite",
  "attachment",
];

/** 每批上传的实体数，避免一次把整个知识库塞进一个请求。 */
const PUSH_BATCH_SIZE = 50;

interface ProfileBootstrapRow {
  id: string;
  bootstrapStatus: BootstrapStatus;
  bootstrapCursor: string | null;
  bootstrapSequence: number | null;
  bootstrapError: string | null;
}

function readProfile(db: Database.Database, profileId: string): ProfileBootstrapRow {
  const row = db.prepare(`
    SELECT id, bootstrapStatus, bootstrapCursor, bootstrapSequence, bootstrapError
    FROM sync_profiles WHERE id = ?
  `).get(profileId) as ProfileBootstrapRow | undefined;
  if (!row) throw new SyncError("INVALID_PAYLOAD", `Profile ${profileId} 不存在`);
  return row;
}

function setStatus(
  db: Database.Database,
  profileId: string,
  status: BootstrapStatus,
  extra: { cursor?: string | null; sequence?: number | null; error?: string | null } = {},
): void {
  const sets = ["bootstrapStatus = ?", "updatedAt = datetime('now')"];
  const args: unknown[] = [status];
  if ("cursor" in extra) { sets.push("bootstrapCursor = ?"); args.push(extra.cursor ?? null); }
  if ("sequence" in extra) { sets.push("bootstrapSequence = ?"); args.push(extra.sequence ?? null); }
  if ("error" in extra) { sets.push("bootstrapError = ?"); args.push(extra.error ?? null); }
  if (status === "ready") sets.push("bootstrapReadyAt = datetime('now')");
  args.push(profileId);
  db.prepare(`UPDATE sync_profiles SET ${sets.join(", ")} WHERE id = ?`).run(args);
}

/**
 * 把所有 Profile 标记为需要重新对账（阶段 N）。
 *
 * 用于恢复备份之后：本地内容退回到过去，但服务端序号仍在前进，
 * 沿用旧游标会让引擎误以为"这段时间的远端变更都已应用"，
 * 从而永久丢失其他设备在这期间的全部修改。
 *
 * 只重置对账进度与游标，**不动任何业务数据、不动 Outbox、不动冲突台账** ——
 * 恢复出来的笔记是用户明确要的，未推送的修改也必须保留。
 *
 * 用独立函数而非直接调 resetBootstrap：这里要处理"所有 Profile"，
 * 而且必须能在没有 sync 表的老库上安全降级（备份可能来自更早版本）。
 */
export function markSyncNeedsReconcile(db: Database.Database = getDb()): number {
  // 表可能不存在（备份来自 v88 之前）：静默跳过而不是抛错，
  // 否则恢复流程会因为一个可选功能而失败。
  const hasTable = db.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sync_profiles'
  `).get();
  if (!hasTable) return 0;

  const run = db.transaction(() => {
    const result = db.prepare(`
      UPDATE sync_profiles
         SET bootstrapStatus = 'pending',
             bootstrapCursor = NULL,
             bootstrapSequence = NULL,
             bootstrapReadyAt = NULL,
             bootstrapError = '恢复备份后需要重新对账',
             updatedAt = datetime('now')
    `).run();

    // 游标归零：下次同步从头对账。
    // 不删除 sync_state 行，保留 lastSyncAt 等诊断信息。
    try {
      db.prepare(`
        UPDATE sync_state
           SET lastSequence = 0,
               lastError = '恢复备份后需要重新对账'
      `).run();
    } catch {
      /* sync_state 可能不存在于更老的备份 */
    }

    return result.changes;
  });

  const changed = run();
  if (changed > 0) {
    logSyncWarn("bootstrap.needs-reconcile", { pendingCount: changed });
  }
  return changed;
}

/**
 * 直接把 Profile 标记为基线就绪并落定游标。
 *
 * 供 Lite 迁移使用：那条路径刚把远端数据完整下载到本地，
 * 两端此刻定义上一致，再跑一次全量对账等于重新下载一遍。
 *
 * 普通场景不要用这个 —— 必须走 runBootstrap 的完整对账，
 * 否则会跳过冲突检测。
 */
export function markBootstrapReady(
  db: Database.Database,
  profileId: string,
  sequence: number,
): void {
  const run = db.transaction(() => {
    setStatus(db, profileId, "ready", { cursor: null, sequence, error: null });
    // 同时推进同步游标：否则增量引擎会从 0 开始重新拉取全部变更。
    advanceSyncState(db, profileId, sequence);
  });
  run();
}

// ---------------------------------------------------------------------------
// 本地状态快照（用于对账与上传）
// ---------------------------------------------------------------------------

/**
 * 读取本地个人空间的当前状态。
 *
 * 只读个人空间（workspaceId IS NULL）—— 与 Sync V2 第一版范围一致。
 * 分实体类型返回，便于按依赖顺序上传。
 */
export function readLocalState(
  db: Database.Database,
  userId: string,
  entityType: SyncEntityType,
): RemoteEntityPayload[] {
  switch (entityType) {
    case "notebook":
      return (db.prepare(`
        SELECT id, parentId, name, description, icon, color, sortOrder,
               isExpanded, isDeleted, deletedAt, createdAt
        FROM notebooks WHERE userId = ? AND workspaceId IS NULL
        ORDER BY createdAt ASC
      `).all(userId) as Array<Record<string, unknown>>).map((r) => ({
        entityType: "notebook" as const,
        operation: "upsert" as const,
        entityId: String(r.id),
        payload: r,
      }));

    case "tag":
      return (db.prepare(`
        SELECT id, name, color, createdAt
        FROM tags WHERE userId = ? AND workspaceId IS NULL
        ORDER BY createdAt ASC
      `).all(userId) as Array<Record<string, unknown>>).map((r) => ({
        entityType: "tag" as const,
        operation: "upsert" as const,
        entityId: String(r.id),
        payload: r,
      }));

    case "note":
      return (db.prepare(`
        SELECT id, notebookId, title, content, contentText, contentFormat,
               isPinned, isFavorite, isLocked, isArchived, isTrashed,
               trashedAt, sortOrder, version, createdAt
        FROM notes WHERE userId = ? AND workspaceId IS NULL
        ORDER BY createdAt ASC
      `).all(userId) as Array<Record<string, unknown>>).map((r) => ({
        entityType: "note" as const,
        operation: "upsert" as const,
        entityId: String(r.id),
        payload: r,
      }));

    case "note_tag":
      // 关系型：复合 ID，与 apply.ts applyNoteTag 的解析一致。
      return (db.prepare(`
        SELECT nt.noteId, nt.tagId FROM note_tags nt
        JOIN notes n ON n.id = nt.noteId
        WHERE n.userId = ? AND n.workspaceId IS NULL
      `).all(userId) as Array<{ noteId: string; tagId: string }>).map((r) => ({
        entityType: "note_tag" as const,
        operation: "upsert" as const,
        entityId: `${r.noteId}:${r.tagId}`,
        payload: { noteId: r.noteId, tagId: r.tagId },
      }));

    case "favorite":
      return (db.prepare(`
        SELECT userId, noteId FROM favorites
        WHERE userId = ? AND workspaceId IS NULL
      `).all(userId) as Array<{ userId: string; noteId: string }>).map((r) => ({
        entityType: "favorite" as const,
        operation: "upsert" as const,
        entityId: `${r.userId}:${r.noteId}`,
        payload: { noteId: r.noteId },
      }));

    case "attachment":
      // 只上传元数据，绝不含 path（服务器本机路径对其他设备无意义）。
      return (db.prepare(`
        SELECT id, noteId, filename, mimeType, size, hash
        FROM attachments WHERE userId = ? AND workspaceId IS NULL
      `).all(userId) as Array<Record<string, unknown>>).map((r) => ({
        entityType: "attachment" as const,
        operation: "upsert" as const,
        entityId: String(r.id),
        payload: r,
      }));

    default:
      return [];
  }
}

/** 本地个人空间是否为空 —— 决定走"下载"还是"合并"。 */
export function isLocalEmpty(db: Database.Database, userId: string): boolean {
  for (const type of BOOTSTRAP_ENTITY_ORDER) {
    if (readLocalState(db, userId, type).length > 0) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// 对账
// ---------------------------------------------------------------------------

/**
 * 判断两个 payload 是否语义等价。
 *
 * 只比较参与同步的字段，忽略 updatedAt 这类必然不同的时间戳。
 * 相等则说明两端已一致，无需上传也无需判冲突。
 */
function payloadEquals(
  a: Record<string, unknown> | undefined,
  b: Record<string, unknown> | undefined,
  ignore: string[] = ["updatedAt", "version"],
): boolean {
  if (!a || !b) return false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (ignore.includes(key)) continue;
    const va = a[key];
    const vb = b[key];
    // null 与 undefined 视为等价：不同来源对"空"的表示可能不同。
    if (va == null && vb == null) continue;
    if (String(va) !== String(vb)) return false;
  }
  return true;
}

export interface ReconcilePlan {
  /** 需要上传到远端的实体。 */
  toPush: RemoteEntityPayload[];
  /** 需要写入本地的远端实体。 */
  toApply: RemoteEntityPayload[];
  /** 两端同 ID 但内容不同 —— 进冲突台账，绝不 LWW。 */
  conflicts: Array<{
    local: RemoteEntityPayload;
    remote: RemoteEntityPayload;
  }>;
}

/**
 * 按 Stable Entity ID 对账。
 *
 * **禁止按标题匹配**：Local ID 与 Remote ID 不同就是两个实体，
 * 哪怕标题完全一样。两者并存是正确结果 —— 用户在两台设备上
 * 各自新建了一篇同名笔记，本来就是两篇。
 */
export function reconcile(
  localItems: RemoteEntityPayload[],
  remoteItems: RemoteEntityPayload[],
): ReconcilePlan {
  const plan: ReconcilePlan = { toPush: [], toApply: [], conflicts: [] };
  const remoteById = new Map(remoteItems.map((r) => [r.entityId, r]));
  const localIds = new Set(localItems.map((l) => l.entityId));

  for (const local of localItems) {
    const remote = remoteById.get(local.entityId);
    if (!remote) {
      // 只在本地存在 → 上传
      plan.toPush.push(local);
      continue;
    }
    if (payloadEquals(local.payload, remote.payload)) {
      // 两端一致，什么都不用做
      continue;
    }
    // 关系型 / 集合型实体没有独立版本，同 ID 即同内容（ID 本身就编码了全部信息），
    // 走到这里说明只是字段表示差异，按远端为准即可，不构成用户可感知的冲突。
    if (local.entityType === "note_tag" || local.entityType === "favorite") {
      continue;
    }
    // 同 ID 内容不同 → 冲突。两个版本都保留，绝不静默覆盖任一方。
    plan.conflicts.push({ local, remote });
  }

  for (const remote of remoteItems) {
    if (!localIds.has(remote.entityId)) {
      // 只在远端存在 → 下载
      plan.toApply.push(remote);
    }
  }

  return plan;
}

// ---------------------------------------------------------------------------
// Bootstrap 主流程
// ---------------------------------------------------------------------------

export interface BootstrapOptions {
  db: Database.Database;
  profileId: string;
  deviceId: string;
  userId: string;
  client: SyncRemoteClient;
  /** 每页 snapshot 条数，测试可调小以覆盖分页逻辑。 */
  pageSize?: number;
}

/**
 * 执行（或续跑）Bootstrap。
 *
 * 幂等且 resumable：可以反复调用。已 ready 时直接返回，不做任何网络请求。
 *
 * 失败时置为 failed 并记录原因，**不改动任何本地业务数据** ——
 * 用户的笔记在整个过程中始终完好，最差情况只是同步没建立起来。
 */
export async function runBootstrap(
  options: BootstrapOptions,
): Promise<BootstrapProgress> {
  const { db, profileId, deviceId, userId, client } = options;
  const pageSize = options.pageSize ?? SYNC_SNAPSHOT_PAGE_SIZE;

  let profile = readProfile(db, profileId);
  if (profile.bootstrapStatus === "ready") {
    return progressOf(db, profileId, { pulled: 0, pushed: 0, conflicts: 0 });
  }

  let pulled = 0;
  let pushed = 0;
  let conflictCount = 0;

  try {
    // --- preparing：取服务端 high-water sequence ---
    if (profile.bootstrapStatus === "pending" || profile.bootstrapStatus === "failed") {
      setStatus(db, profileId, "preparing", { error: null, cursor: null });
      db.prepare(
        "UPDATE sync_profiles SET bootstrapStartedAt = COALESCE(bootstrapStartedAt, datetime('now')) WHERE id = ?",
      ).run(profileId);
      profile = readProfile(db, profileId);
    }

    if (profile.bootstrapSequence == null) {
      const plan = await client.plan(0);
      setStatus(db, profileId, "pulling", { sequence: plan.serverSequence });
      logSyncInfo("bootstrap.prepared", {
        profileId,
        deviceId,
        pullSequence: plan.serverSequence,
      });
      profile = readProfile(db, profileId);
    } else if (profile.bootstrapStatus === "preparing") {
      setStatus(db, profileId, "pulling");
      profile = readProfile(db, profileId);
    }

    const snapshotSequence = profile.bootstrapSequence ?? 0;

    // --- pulling：分页下载 snapshot ---
    //
    // 全量收集后再对账，而不是边下边应用：对账需要知道"远端有哪些 ID"，
    // 边下边写会让"只在本地存在"的判定失准。
    const remoteItems: RemoteEntityPayload[] = [];
    if (profile.bootstrapStatus === "pulling" || profile.bootstrapStatus === "reconciling") {
      let cursor = profile.bootstrapCursor;
      for (;;) {
        const page = await client.snapshot(cursor, snapshotSequence, pageSize);
        for (const item of page.items) {
          remoteItems.push({
            entityType: item.entityType,
            entityId: item.entityId,
            // snapshot 只包含"当前存在"的实体，因此一律 upsert。
            operation: "upsert",
            payload: item.payload,
          });
        }
        cursor = page.nextCursor;
        // 游标落库：中途被强杀后可从这里续传。
        setStatus(db, profileId, "pulling", { cursor });
        if (!page.hasMore) break;
      }
      setStatus(db, profileId, "reconciling", { cursor: null });
      profile = readProfile(db, profileId);
    }

    // --- reconciling：按 Stable Entity ID 对账 ---
    const localEmpty = isLocalEmpty(db, userId);
    const remoteEmpty = remoteItems.length === 0;

    logSyncInfo("bootstrap.reconciling", {
      profileId,
      deviceId,
      applyCount: remoteItems.length,
    });

    const toPushAll: RemoteEntityPayload[] = [];

    for (const entityType of BOOTSTRAP_ENTITY_ORDER) {
      const localItems = readLocalState(db, userId, entityType);
      const remoteOfType = remoteItems.filter((r) => r.entityType === entityType);

      if (localEmpty) {
        // Local 空：全部下载，无需对账。
        continue;
      }
      if (remoteEmpty) {
        // Remote 空：全部上传。
        toPushAll.push(...localItems);
        continue;
      }

      const plan = reconcile(localItems, remoteOfType);
      toPushAll.push(...plan.toPush);

      // 冲突入台账：两个版本都保留，用户之后在冲突中心决定。
      for (const { local, remote } of plan.conflicts) {
        recordConflict(db, {
          profileId,
          entityType: local.entityType,
          entityId: local.entityId,
          localVersion: Number(local.payload?.version) || null,
          remoteVersion: Number(remote.payload?.version) || null,
          localPayload: local.payload ?? null,
          remotePayload: remote.payload ?? null,
          basePayload: null,
        });
        conflictCount += 1;
      }
    }

    // 应用远端独有的实体（含 Local 空的全量下载场景）。
    // 双层抑制：Node 侧防 enqueue，SQLite 侧防 Change Feed —— 缺一层就回环。
    const toApply = localEmpty
      ? remoteItems
      : BOOTSTRAP_ENTITY_ORDER.flatMap((type) => {
        const localItems = readLocalState(db, userId, type);
        const remoteOfType = remoteItems.filter((r) => r.entityType === type);
        return remoteEmpty ? [] : reconcile(localItems, remoteOfType).toApply;
      });

    if (toApply.length > 0) {
      runWithOutboxSuppressed(() => {
        runChangeFeedSuppressed(db, () => {
          // 按依赖顺序应用：父实体先于子实体。
          for (const entityType of BOOTSTRAP_ENTITY_ORDER) {
            const batch = toApply.filter((i) => i.entityType === entityType);
            if (batch.length === 0) continue;
            const result = applyRemoteChanges(db, batch, { userId });
            pulled += result.applied;
          }
        });
      });
    }

    setStatus(db, profileId, "pushing");

    // --- pushing：上传本地独有的实体 ---
    //
    // 直接调 client.push 而不走 Outbox：Bootstrap 期间触发器不写 Outbox
    // （闸门要求 ready），这里上传的是"当前最终状态"而非操作流。
    if (toPushAll.length > 0) {
      for (const entityType of BOOTSTRAP_ENTITY_ORDER) {
        const items = toPushAll.filter((i) => i.entityType === entityType);
        for (let i = 0; i < items.length; i += PUSH_BATCH_SIZE) {
          const batch = items.slice(i, i + PUSH_BATCH_SIZE);
          const response = await client.push(
            deviceId,
            batch.map((item) => ({
              mutationId: `bootstrap-${profileId}-${item.entityType}-${item.entityId}`,
              entityType: item.entityType,
              entityId: item.entityId,
              operation: "upsert" as const,
              // 不带 baseVersion：这是首次建立基线，服务端上不存在该实体。
              // 若服务端已存在（对账阶段漏判）会返回 VERSION_CONFLICT，
              // 下面按冲突记录而不是覆盖。
              payload: item.payload,
            })),
          );
          for (const r of response.results) {
            if (r.status === "applied") {
              pushed += 1;
            } else if (r.status === "conflict") {
              const item = batch.find(
                (b) => `bootstrap-${profileId}-${b.entityType}-${b.entityId}` === r.mutationId,
              );
              if (item) {
                recordConflict(db, {
                  profileId,
                  entityType: item.entityType,
                  entityId: item.entityId,
                  localVersion: Number(item.payload?.version) || null,
                  remoteVersion: r.serverVersion ?? null,
                  localPayload: item.payload ?? null,
                  // 远端内容留待下一轮 Pull 补齐，此处不猜。
                  remotePayload: null,
                  basePayload: null,
                });
                conflictCount += 1;
              }
            }
            // 其他失败保留：下一轮 Bootstrap 重试即可，不丢数据。
          }
        }
      }
    }

    setStatus(db, profileId, "verifying");

    // --- verifying：补齐 snapshot 窗口期的服务端增量 ---
    //
    // 这一步不能省：snapshot 是 sequence N 时刻的快照，
    // 下载与上传期间服务端可能又产生了变更。
    let cursor = snapshotSequence;
    // Change Feed 只回"哪些实体变了"，不含正文（SyncChangeItem 无 payload）。
    // 因此先收集变更清单，再按需从 snapshot 拉取完整内容 —— 与增量引擎同一策略。
    const pendingDeletes: RemoteEntityPayload[] = [];
    const wantedUpserts = new Map<string, { entityType: SyncEntityType; entityId: string }>();

    for (;;) {
      const changes = await client.changes(cursor, pageSize);
      for (const item of changes.items) {
        const key = `${item.entityType}\u0000${item.entityId}`;
        if (item.operation === "delete") {
          // 删除不需要内容，直接应用；同时撤销可能已登记的 upsert 意图
          // （同一实体先改后删，最终态是删除）。
          wantedUpserts.delete(key);
          pendingDeletes.push({
            entityType: item.entityType,
            entityId: item.entityId,
            operation: "delete",
          });
        } else {
          wantedUpserts.set(key, { entityType: item.entityType, entityId: item.entityId });
        }
      }
      cursor = changes.nextSequence;
      if (!changes.hasMore) break;
    }

    // 从 snapshot 补齐 upsert 的完整内容，拿齐即提前终止，避免整库扫描。
    const windowUpserts: RemoteEntityPayload[] = [];
    if (wantedUpserts.size > 0) {
      let snapCursor: string | null = null;
      for (;;) {
        const page = await client.snapshot(snapCursor, cursor, pageSize);
        for (const entry of page.items) {
          const key = `${entry.entityType}\u0000${entry.entityId}`;
          if (!wantedUpserts.has(key)) continue;
          windowUpserts.push({
            entityType: entry.entityType,
            entityId: entry.entityId,
            operation: "upsert",
            payload: entry.payload,
          });
          wantedUpserts.delete(key);
        }
        snapCursor = page.nextCursor;
        if (!page.hasMore || wantedUpserts.size === 0) break;
      }
    }

    const windowItems = [...windowUpserts, ...pendingDeletes];
    if (windowItems.length > 0) {
      runWithOutboxSuppressed(() => {
        runChangeFeedSuppressed(db, () => {
          // 仍按依赖顺序：父实体先于子实体。
          for (const entityType of BOOTSTRAP_ENTITY_ORDER) {
            const batch = windowItems.filter((i) => i.entityType === entityType);
            if (batch.length === 0) continue;
            const result = applyRemoteChanges(db, batch, { userId });
            pulled += result.applied;
          }
        });
      });
    }

    // 游标落到收敛点，之后由增量引擎接手。
    advanceSyncState(db, profileId, cursor, SYNC_PERSONAL_SCOPE_KEY);
    await client.ack(deviceId, cursor);

    // --- ready：基线建立完成，触发器开始写 Outbox，增量引擎可启动 ---
    setStatus(db, profileId, "ready", { cursor: null, error: null });
    logSyncInfo("bootstrap.ready", {
      profileId,
      deviceId,
      pullSequence: cursor,
      applyCount: pulled,
      pushCount: pushed,
      conflictCount,
    });
  } catch (error) {
    const code = error instanceof SyncError ? error.code : "SERVER_ERROR";
    setStatus(db, profileId, "failed", { error: code });
    logSyncWarn("bootstrap.failed", { profileId, deviceId, errorCode: code });
    // 重新抛出让调用方决定是否提示用户；本地数据未受任何影响。
    throw error;
  }

  return progressOf(db, profileId, { pulled, pushed, conflicts: conflictCount });
}

function progressOf(
  db: Database.Database,
  profileId: string,
  counts: { pulled: number; pushed: number; conflicts: number },
): BootstrapProgress {
  const row = readProfile(db, profileId);
  return {
    status: row.bootstrapStatus,
    sequence: row.bootstrapSequence,
    cursor: row.bootstrapCursor,
    error: row.bootstrapError,
    pulled: counts.pulled,
    pushed: counts.pushed,
    conflicts: counts.conflicts,
  };
}

/** 读取 Bootstrap 进度，供设置页展示阶段与失败原因。 */
export function getBootstrapProgress(
  db: Database.Database,
  profileId: string,
): BootstrapProgress {
  return progressOf(db, profileId, { pulled: 0, pushed: 0, conflicts: 0 });
}

/** 是否已完成基线建立 —— 增量引擎的启动前置条件。 */
export function isBootstrapReady(db: Database.Database, profileId: string): boolean {
  const row = db.prepare(
    "SELECT bootstrapStatus FROM sync_profiles WHERE id = ?",
  ).get(profileId) as { bootstrapStatus?: string } | undefined;
  return row?.bootstrapStatus === "ready";
}

/**
 * 重置 Bootstrap 以便重新对账。
 *
 * 用于恢复备份之后（旧 cursor 不再可信）或用户手动重试。
 * 只清 Bootstrap 进度，**不动任何本地业务数据、不动 Outbox、不动冲突台账**。
 */
export function resetBootstrap(db: Database.Database, profileId: string): void {
  db.prepare(`
    UPDATE sync_profiles
    SET bootstrapStatus = 'pending',
        bootstrapCursor = NULL,
        bootstrapSequence = NULL,
        bootstrapError = NULL,
        bootstrapReadyAt = NULL,
        updatedAt = datetime('now')
    WHERE id = ?
  `).run(profileId);
}
