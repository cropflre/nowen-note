import type Database from "better-sqlite3";
import { SYNC_TABLES } from "./constants";
import type { SyncOutboxRow } from "./types";
import type { PushMutationPayload } from "./remote";
import { runWithOutboxSuppressed } from "./context";
import { runChangeFeedSuppressed } from "./suppression";

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

    // A terminal note deletion must not erase the explicitly queued trash stage.
    if (row.entityType === "note" && (row.operation === "delete" || existing.operation === "delete")) continue;

    // 被合并的一方要记账：推送成功后这些条目也必须出队，
    // 否则它们会永远留在 Outbox 里反复重试。
    existing.supersededIds.push(existing.mutationId);
    existing.mutationId = row.mutationId;
    existing.operation = row.operation;
    existing.payload = parsePayload(row.payload);
    // baseVersion 保持最早那条：它才代表"这串修改的共同祖先"。
    // An absent first base means creation. Later local revisions must not turn
    // that creation into an update of a server entity that does not exist yet.
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

/** 推送确认把本机笔记版本号改成了服务端版本号（正文不变）。 */
export interface NoteVersionRebase {
  noteId: string;
  fromVersion: number;
  toVersion: number;
}

/**
 * Called in the acknowledgement transaction, after the sent rows leave Outbox.
 *
 * 合并推送时本机连续保存了 N 次（本机版本 +N），服务端只 +1，确认后本机版本号会
 * 改成服务端版本号；Markdown 由 Yjs 落盘、5 分钟内不涨版本，确认后版本号反而会变大。
 * 返回这次改号，调用方在事务提交后通知本机编辑器与 Yjs 房间沿用新版本号，
 * 否则它们手里的旧版本号会让下一次保存被判为冲突或被丢弃。
 */
export function acknowledgeNotePush(
  db: Database.Database,
  mutation: CoalescedMutation,
  version: number | undefined,
  profileId: string,
  scopeKey: string,
  userId: string,
  workspaceId: string | null,
): NoteVersionRebase | null {
  if (mutation.entityType !== "note" || mutation.operation !== "upsert"
    || typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) return null;

  // Later batches and edits made while awaiting Push are descendants of this
  // confirmed write. Their next Push must use the server's version as its base.
  const remaining = db.prepare(`
    UPDATE sync_outbox SET baseVersion = ?
    WHERE profileId = ? AND scopeKey = ? AND entityType = 'note' AND entityId = ?
      AND status IN ('pending', 'failed')
  `).run(version, profileId, scopeKey, mutation.entityId);
  if (remaining.changes > 0) return null; // Keep the editor's version while local edits remain.

  const current = db.prepare(`SELECT version FROM notes
    WHERE id = ? AND workspaceId IS ? AND (? IS NOT NULL OR userId = ?)`)
    .get(mutation.entityId, workspaceId, workspaceId, userId) as { version: number } | undefined;
  if (!current || current.version === version) return null;

  // Version acknowledgement is remote state, not a new user edit.
  runWithOutboxSuppressed(() => runChangeFeedSuppressed(db, () => {
    db.prepare(`UPDATE notes SET version = ?
      WHERE id = ? AND workspaceId IS ? AND (? IS NOT NULL OR userId = ?)`)
      .run(version, mutation.entityId, workspaceId, workspaceId, userId);
  }));
  return { noteId: mutation.entityId, fromVersion: current.version, toVersion: version };
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
