import type Database from "better-sqlite3";
import { syncRetryDelayMs } from "./constants";
import { logSyncInfo, logSyncWarn } from "./log";

/**
 * 附件 Local-first 同步（Phase 9）。
 *
 * 核心规则：**本地存在即可用**。
 *
 * 附件的元数据走 Sync V2（作为 attachment 实体），
 * 二进制走独立的上传/下载通道。两者分离的原因：
 * - 把二进制塞进 mutation 会让 push 请求体不可控；
 * - 上传失败不该阻塞元数据同步，更不该阻塞本地阅读。
 *
 * 状态流转：
 *   local ──(开启同步)──> pending ──> uploading ──> synced
 *                            ↑            │
 *                            └── failed ──┘（保留重试，绝不丢弃）
 */

export type AttachmentSyncStatus =
  | "local"
  | "pending"
  | "uploading"
  | "synced"
  | "failed";

export interface AttachmentSyncRow {
  attachmentId: string;
  profileId: string | null;
  status: AttachmentSyncStatus;
  remoteOnly: 0 | 1;
  retryCount: number;
  lastAttemptAt: string | null;
  lastError: string | null;
  updatedAt: string;
}

/**
 * 登记一个新建的本地附件。
 *
 * 必须与附件落盘在同一事务内调用：否则会出现"文件已存在但同步状态缺失"，
 * 那个附件将永远不会被上传，用户在其他设备上看到破图。
 *
 * 未开启同步时状态为 local；开启同步后由 promoteLocalAttachments
 * 统一转成 pending，这样关闭同步期间产生的附件不会丢。
 */
export function registerLocalAttachment(
  db: Database.Database,
  attachmentId: string,
  profileId: string | null,
): void {
  db.prepare(`
    INSERT INTO attachment_sync_state (attachmentId, profileId, status, remoteOnly, updatedAt)
    VALUES (?, ?, ?, 0, datetime('now'))
    ON CONFLICT(attachmentId) DO UPDATE SET
      profileId = COALESCE(excluded.profileId, attachment_sync_state.profileId),
      -- 只把 local 提升为 pending，其余状态一律不动。
      --
      -- 为什么需要这条提升：v84 的触发器会在 INSERT INTO attachments 时先建好
      -- 状态行，此时若尚无 active profile 则为 local。之后调用方带着 profileId
      -- 再次登记（例如附件路由在事务内显式登记、或刚开启同步）时，
      -- 如果不提升状态，这个附件会永远停在 local 而从不进入上传队列 ——
      -- 表现为其他设备上永久破图，且没有任何错误提示。
      --
      -- 为什么只提升 local：
      --   synced   已上传完成，重置会导致无意义的重复上传；
      --   uploading 正在传输中，改状态会让本轮结果写回时状态错乱；
      --   failed   已有 retryCount 记录，重置会丢失重试历史；
      --   remoteOnly=1 的行是"远端已有待下载"，误判成待上传会把空文件推回服务器。
      status = CASE
        WHEN attachment_sync_state.status = 'local'
          AND attachment_sync_state.remoteOnly = 0
          AND excluded.profileId IS NOT NULL
        THEN 'pending'
        ELSE attachment_sync_state.status
      END,
      updatedAt = datetime('now')
  `).run(attachmentId, profileId, profileId ? "pending" : "local");
}

/**
 * 登记一个"远端已有、本地还没下载"的附件。
 *
 * Pull 到 attachment 元数据时调用。remoteOnly=1 让 UI 能显示
 * "正在获取图片"而不是破图，也让下载队列知道该抓哪些文件。
 */
export function registerRemoteAttachment(
  db: Database.Database,
  attachmentId: string,
  profileId: string | null,
): void {
  db.prepare(`
    INSERT INTO attachment_sync_state (attachmentId, profileId, status, remoteOnly, updatedAt)
    VALUES (?, ?, 'synced', 1, datetime('now'))
    ON CONFLICT(attachmentId) DO UPDATE SET
      remoteOnly = 1,
      updatedAt = datetime('now')
  `).run(attachmentId, profileId);
}

/** 二进制下载完成：不再是 remoteOnly。 */
export function markAttachmentDownloaded(
  db: Database.Database,
  attachmentId: string,
): void {
  db.prepare(`
    UPDATE attachment_sync_state
    SET remoteOnly = 0, status = 'synced', lastError = NULL, updatedAt = datetime('now')
    WHERE attachmentId = ?
  `).run(attachmentId);
}

/**
 * 开启同步时把历史 local 附件转入待上传。
 *
 * 关闭同步期间用户可能插入了大量图片，它们的状态是 local。
 * 若不做这一步，这些附件永远不会上传，其他设备上全是破图。
 */
export function promoteLocalAttachments(
  db: Database.Database,
  profileId: string,
): number {
  const result = db.prepare(`
    UPDATE attachment_sync_state
    SET status = 'pending', profileId = ?, updatedAt = datetime('now')
    WHERE status = 'local'
  `).run(profileId);
  if (result.changes > 0) {
    logSyncInfo("attachment.promoted", {
      profileId,
      pendingCount: result.changes,
    });
  }
  return result.changes;
}

/**
 * 取出待上传附件。
 *
 * failed 一并取出——它不是终态，只是暂时推不上去。
 * 按 retryCount 升序，让新失败的优先重试，避免一个长期失败的大文件
 * 一直占住队头把后面的小图片饿死。
 */
export function listPendingUploads(
  db: Database.Database,
  limit: number,
): AttachmentSyncRow[] {
  return db.prepare(`
    SELECT * FROM attachment_sync_state
    WHERE status IN ('pending', 'failed') AND remoteOnly = 0
    ORDER BY retryCount ASC, updatedAt ASC
    LIMIT ?
  `).all(limit) as AttachmentSyncRow[];
}

/** 取出待下载附件（远端已有、本地缺二进制）。 */
export function listPendingDownloads(
  db: Database.Database,
  limit: number,
): AttachmentSyncRow[] {
  return db.prepare(`
    SELECT * FROM attachment_sync_state
    WHERE remoteOnly = 1
    ORDER BY retryCount ASC, updatedAt ASC
    LIMIT ?
  `).all(limit) as AttachmentSyncRow[];
}

export function markUploading(db: Database.Database, attachmentId: string): void {
  db.prepare(`
    UPDATE attachment_sync_state
    SET status = 'uploading', lastAttemptAt = datetime('now'), updatedAt = datetime('now')
    WHERE attachmentId = ?
  `).run(attachmentId);
}

export function markUploaded(db: Database.Database, attachmentId: string): void {
  db.prepare(`
    UPDATE attachment_sync_state
    SET status = 'synced', lastError = NULL, updatedAt = datetime('now')
    WHERE attachmentId = ?
  `).run(attachmentId);
}

/**
 * 上传失败。
 *
 * 与 Outbox 同理：retryCount 只增，**永不因次数用尽而删除**。
 * 附件二进制只存在于本机时，删除记录等于永久丢失用户的图片。
 */
export function markUploadFailed(
  db: Database.Database,
  attachmentId: string,
  errorCode: string,
): void {
  db.prepare(`
    UPDATE attachment_sync_state
    SET status = 'failed',
        retryCount = retryCount + 1,
        lastAttemptAt = datetime('now'),
        lastError = ?,
        updatedAt = datetime('now')
    WHERE attachmentId = ?
  `).run(errorCode, attachmentId);
}

/**
 * 崩溃恢复：把 uploading 退回 pending。
 *
 * 进程被强杀时正在上传的附件会永久停留在 uploading，
 * 之后再也不会被 listPendingUploads 取出。启动时必须复位。
 */
export function recoverStuckUploads(db: Database.Database): number {
  const result = db.prepare(`
    UPDATE attachment_sync_state
    SET status = 'pending', updatedAt = datetime('now')
    WHERE status = 'uploading'
  `).run();
  if (result.changes > 0) {
    logSyncWarn("attachment.recovered-uploading", { pendingCount: result.changes });
  }
  return result.changes;
}

/** 下次重试的建议等待时间，与 Outbox 共用同一套退避节奏。 */
export function nextUploadDelayMs(row: AttachmentSyncRow): number {
  return syncRetryDelayMs(row.retryCount);
}

export interface AttachmentSyncSummary {
  local: number;
  pending: number;
  uploading: number;
  synced: number;
  failed: number;
  remoteOnly: number;
}

/** 供设置页展示附件同步概况。 */
export function summarizeAttachmentSync(db: Database.Database): AttachmentSyncSummary {
  const rows = db.prepare(`
    SELECT status, COUNT(*) AS count FROM attachment_sync_state GROUP BY status
  `).all() as Array<{ status: AttachmentSyncStatus; count: number }>;

  const summary: AttachmentSyncSummary = {
    local: 0, pending: 0, uploading: 0, synced: 0, failed: 0, remoteOnly: 0,
  };
  for (const row of rows) summary[row.status] = row.count;

  const remote = db.prepare(
    "SELECT COUNT(*) AS count FROM attachment_sync_state WHERE remoteOnly = 1",
  ).get() as { count: number };
  summary.remoteOnly = remote.count;
  return summary;
}

/**
 * 附件在本地是否可读。
 *
 * remoteOnly=1 表示二进制还没下载完，UI 应显示占位而非破图；
 * 其余状态（含 failed）都意味着本地文件已在，可以正常打开——
 * 这正是 Local-first 的关键：上传失败不影响阅读。
 */
export function isLocallyReadable(row: AttachmentSyncRow | undefined): boolean {
  if (!row) return true; // 没有同步记录说明是纯本地附件，直接可读
  return row.remoteOnly === 0;
}
