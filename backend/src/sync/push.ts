import type Database from "better-sqlite3";
import { SYNC_TABLES } from "./constants";
import type { SyncOutboxRow } from "./types";
import type { PushMutationPayload } from "./remote";

/**
 * Mutation Coalescing。
 *
 * 编辑器连续输入会产生大量 update。同一实体尚未同步时，中间态没有任何价值——
 * 其他设备只需要最终状态。合并能大幅减少请求量，但必须保证语义不被破坏：
 *
 *   update + update  → 保留最新 payload
 *   create + update  → create with latest payload（仍是"新建"）
 *   update + delete  → delete（中间的编辑不必上传）
 *   delete + upsert  → upsert（重新创建，不能被前面的 delete 吃掉）
 *
 * 关键取舍：**baseVersion 取最早那条**。
 * 因为冲突检测问的是"我这串修改是基于服务端哪个版本开始的"，
 * 取最新一条的 baseVersion 会让本地连续编辑自己跟自己比，
 * 从而漏掉与远端的真实冲突。
 */

export interface CoalescedMutation extends PushMutationPayload {
  /** 被合并掉的其他 mutationId，推送成功后一并出队。 */
  supersededIds: string[];
}

function parsePayload(raw: string | null): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 按 (entityType, entityId) 合并连续 mutation。
 *
 * 输入必须已按 createdAt 升序，输出保持"每个实体首次出现的位置"，
 * 这样 notebook 仍然排在其 note 之前，服务端不会因缺少父实体而拒绝。
 */
export function coalesceMutations(rows: SyncOutboxRow[]): CoalescedMutation[] {
  const byEntity = new Map<string, CoalescedMutation>();
  const order: string[] = [];

  for (const row of rows) {
    const key = `${row.entityType}\u0000${row.entityId}`;
    const existing = byEntity.get(key);

    if (!existing) {
      byEntity.set(key, {
        mutationId: row.mutationId,
        entityType: row.entityType,
        entityId: row.entityId,
        operation: row.operation,
        baseVersion: row.baseVersion ?? undefined,
        payload: parsePayload(row.payload),
        supersededIds: [],
      });
      order.push(key);
      continue;
    }

    // 被合并的一方要记账：推送成功后这些条目也必须出队，
    // 否则它们会永远留在 Outbox 里反复重试。
    existing.supersededIds.push(existing.mutationId);
    existing.mutationId = row.mutationId;
    existing.operation = row.operation;
    existing.payload = parsePayload(row.payload);
    // baseVersion 保持最早那条：它才代表"这串修改的共同祖先"。
    if (existing.baseVersion === undefined && row.baseVersion !== null) {
      existing.baseVersion = row.baseVersion;
    }
  }

  return order.map((key) => byEntity.get(key) as CoalescedMutation);
}

/**
 * 记录服务端已确认的 mutation，防止本地重复上传。
 *
 * 与 Outbox 出队分开：出队是本地队列管理，这里是"我们知道服务端处理过了"，
 * 后者在崩溃恢复后仍然有效。
 */
export function markLocalMutationApplied(
  db: Database.Database,
  mutationId: string,
  deviceId: string,
): void {
  db.prepare(`
    INSERT OR IGNORE INTO ${SYNC_TABLES.appliedMutations} (mutationId, deviceId, appliedAt)
    VALUES (?, ?, datetime('now'))
  `).run(mutationId, deviceId);
}

export function isLocalMutationApplied(
  db: Database.Database,
  mutationId: string,
): boolean {
  const row = db.prepare(
    `SELECT 1 AS hit FROM ${SYNC_TABLES.appliedMutations} WHERE mutationId = ?`,
  ).get(mutationId) as { hit: number } | undefined;
  return !!row;
}
