import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { SYNC_TABLES } from "./constants";
import { isOutboxSuppressed } from "./context";
import type {
  SyncEntityType,
  SyncOperation,
  SyncOutboxRow,
} from "./types";

/**
 * Sync Outbox 写入层。
 *
 * 唯一的硬性约束：业务修改与 mutation 入队必须在同一个事务里提交。
 * 违反它就会出现这种状态——
 *
 *   UPDATE notes; COMMIT;   ← 用户看到"已保存"
 *   （此处崩溃）
 *   INSERT sync_outbox;     ← 永远没执行
 *
 * 结果是本地内容已改，但这条修改永远不会同步到其他设备，
 * 且没有任何迹象提示用户。因此本模块只提供"接收既有事务"的 API，
 * 不自己开事务，强制调用方把它嵌进业务事务内部。
 */

export interface EnqueueMutationInput {
  entityType: SyncEntityType;
  entityId: string;
  operation: SyncOperation;
  deviceId: string;
  /**
   * 必填：mutation 必须明确归属于某个同步关系。
   *
   * "仅此设备"模式下**不产生任何 Outbox 条目** —— 本地 CRUD 写完本地库就结束。
   * 首次开启同步不是 replay 历史操作流，而是由 Bootstrap/Reconcile 按
   * 当前最终状态建立基线，之后才产生增量 mutation。
   */
  profileId: string;
  /** 冲突检测依据；delete 与关系型实体可省略。 */
  baseVersion?: number | null;
  /** 结构化载荷，内部序列化为 JSON；delete 可省略。 */
  payload?: Record<string, unknown> | null;
  /** 允许调用方注入以便测试；默认生成 UUID。 */
  mutationId?: string;
}

/**
 * 在**调用方已开启的事务内**追加一条 mutation。
 *
 * 返回 null 表示当前处于 apply remote changes 上下文，本次变更来自远端，
 * 不应回流到 Outbox（否则形成 Pull → Apply → Push 无限循环）。
 */
export function enqueueMutation(
  db: Database.Database,
  input: EnqueueMutationInput,
): string | null {
  // 防回环：远端变更不产生新的本地 mutation。
  if (isOutboxSuppressed()) return null;

  if (!input.entityId) {
    throw new Error("[sync-v2] enqueueMutation 需要 entityId");
  }
  if (!input.deviceId) {
    throw new Error("[sync-v2] enqueueMutation 需要稳定的 deviceId");
  }
  if (!input.profileId) {
    // 早失败胜过写入一条无法投递的孤儿条目：
    // 没有 active profile 意味着用户处于"仅此设备"，此时不该有 mutation。
    throw new Error(
      "[sync-v2] enqueueMutation 需要 profileId；仅此设备模式不应产生 Outbox 条目",
    );
  }

  const mutationId = input.mutationId || randomUUID();
  const payload = input.payload == null ? null : JSON.stringify(input.payload);

  db.prepare(`
    INSERT INTO ${SYNC_TABLES.outbox} (
      id, mutationId, profileId, deviceId, entityType, entityId,
      operation, baseVersion, payload, status, retryCount, createdAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, datetime('now'))
  `).run(
    randomUUID(),
    mutationId,
    input.profileId,
    input.deviceId,
    input.entityType,
    input.entityId,
    input.operation,
    input.baseVersion ?? null,
    payload,
  );

  return mutationId;
}

/**
 * 把业务写入与 mutation 入队包成一个原子事务。
 *
 * 这是业务代码应当使用的入口：只要走这里，就不存在
 * "内容已改但 mutation 没入队" 的中间状态。
 * better-sqlite3 的 transaction 在回调抛出时自动回滚。
 */
export function withMutation<T>(
  db: Database.Database,
  input: EnqueueMutationInput,
  write: () => T,
): T {
  const run = db.transaction(() => {
    const result = write();
    enqueueMutation(db, input);
    return result;
  });
  return run();
}

/**
 * 按创建顺序取待发送条目。
 *
 * 顺序很重要：先建 notebook 再建其中的 note，乱序会让服务端因缺少父实体而拒绝。
 * failed 条目一并取出，因为它们不是终态，只是暂时推不上去。
 *
 * profileId 严格过滤：Profile A 的 mutation 绝不能被推向 Profile B 的服务器。
 * 早期实现有 `OR profileId IS NULL` 的补传分支，会把"仅此设备"期间的
 * 历史操作在开启同步后全部 replay —— 那不是正确模型（见 v88 迁移说明）。
 */
export function listPendingMutations(
  db: Database.Database,
  limit: number,
  profileId?: string | null,
): SyncOutboxRow[] {
  if (profileId === undefined || profileId === null) {
    // 不限定 Profile：仅供诊断与统计使用，Push 路径必须传 profileId。
    return db.prepare(`
      SELECT * FROM ${SYNC_TABLES.outbox}
      WHERE status IN ('pending', 'failed')
      ORDER BY createdAt ASC, rowid ASC
      LIMIT ?
    `).all(limit) as SyncOutboxRow[];
  }

  return db.prepare(`
    SELECT * FROM ${SYNC_TABLES.outbox}
    WHERE status IN ('pending', 'failed')
      AND profileId = ?
    ORDER BY createdAt ASC, rowid ASC
    LIMIT ?
  `).all(profileId, limit) as SyncOutboxRow[];
}

/** 统计待同步条目，供设置页诊断信息展示。 */
export function countPendingMutations(db: Database.Database): number {
  const row = db.prepare(`
    SELECT COUNT(*) AS count FROM ${SYNC_TABLES.outbox}
    WHERE status IN ('pending', 'failed')
  `).get() as { count: number } | undefined;
  return Number(row?.count || 0);
}

/** 推送成功后移除条目。这是**唯一**允许删除 Outbox 条目的路径。 */
export function markMutationSynced(db: Database.Database, mutationId: string): void {
  db.prepare(`DELETE FROM ${SYNC_TABLES.outbox} WHERE mutationId = ?`).run(mutationId);
}

/**
 * 记录一次失败。
 *
 * 注意 retryCount 只增不减，且**永远不会**因为达到阈值而删除条目——
 * 其中可能是用户唯一一份未上传的修改。退避节奏由 syncRetryDelayMs 决定，
 * 超过档位后固定在最大间隔，相当于"降频但不放弃"。
 */
export function markMutationFailed(
  db: Database.Database,
  mutationId: string,
  errorCode: string,
): void {
  db.prepare(`
    UPDATE ${SYNC_TABLES.outbox}
    SET status = 'failed',
        retryCount = retryCount + 1,
        lastAttemptAt = datetime('now'),
        lastError = ?
    WHERE mutationId = ?
  `).run(errorCode, mutationId);
}

/**
 * 崩溃恢复：把 inflight 条目退回 pending。
 *
 * 进程被强杀时，正在推送的条目会永久停留在 inflight，
 * 之后再也不会被取出。启动时必须无条件复位。
 * 重复推送是安全的——服务端按 mutationId 幂等。
 */
export function recoverInflightMutations(db: Database.Database): number {
  const result = db.prepare(`
    UPDATE ${SYNC_TABLES.outbox}
    SET status = 'pending'
    WHERE status = 'inflight'
  `).run();
  return result.changes;
}

/** 标记为正在推送，避免并发 Push 重复取到同一条目。 */
export function markMutationInflight(db: Database.Database, mutationId: string): void {
  db.prepare(`
    UPDATE ${SYNC_TABLES.outbox}
    SET status = 'inflight', lastAttemptAt = datetime('now')
    WHERE mutationId = ?
  `).run(mutationId);
}
