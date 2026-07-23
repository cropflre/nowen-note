import { getDb } from "../db/schema.js";

const STALE_PROCESSING_MINUTES = 10;
const MAINTENANCE_INTERVAL_MS = 30_000;
let maintenanceTimer: NodeJS.Timeout | null = null;

export interface EmbeddingQueueRecoveryResult {
  notes: number;
  attachments: number;
}

/**
 * 新进程启动时，旧进程留下的 processing 不可能仍被合法 worker 持有。
 * 因此启动阶段可以无条件、原子地退回 pending，且不增加 provider 失败重试次数。
 */
export function recoverInterruptedEmbeddingJobs(): EmbeddingQueueRecoveryResult {
  const db = getDb();
  let notes = 0;
  let attachments = 0;
  const transaction = db.transaction(() => {
    notes = db.prepare(`
      UPDATE embedding_queue
      SET status = 'pending',
          lastError = 'recovered: backend restarted during processing',
          updatedAt = datetime('now')
      WHERE status = 'processing'
    `).run().changes;

    attachments = db.prepare(`
      UPDATE attachment_embedding_queue
      SET status = 'pending',
          lastError = 'recovered: backend restarted during processing',
          updatedAt = datetime('now')
      WHERE status = 'processing'
    `).run().changes;
  });
  transaction();
  return { notes, attachments };
}

/**
 * 正常 embedding HTTP 请求有 30 秒超时。这里使用 10 分钟租约，只回收明显失联的任务，
 * 避免大型附件仍在解析时被另一个轮询重复领取。
 */
export function recoverStaleEmbeddingJobs(): EmbeddingQueueRecoveryResult {
  const db = getDb();
  const threshold = `-${STALE_PROCESSING_MINUTES} minutes`;
  let notes = 0;
  let attachments = 0;
  const transaction = db.transaction(() => {
    notes = db.prepare(`
      UPDATE embedding_queue
      SET status = 'pending',
          lastError = 'recovered: processing lease expired',
          updatedAt = datetime('now')
      WHERE status = 'processing'
        AND datetime(updatedAt) <= datetime('now', ?)
    `).run(threshold).changes;

    attachments = db.prepare(`
      UPDATE attachment_embedding_queue
      SET status = 'pending',
          lastError = 'recovered: processing lease expired',
          updatedAt = datetime('now')
      WHERE status = 'processing'
        AND datetime(updatedAt) <= datetime('now', ?)
    `).run(threshold).changes;
  });
  transaction();
  return { notes, attachments };
}

/**
 * 旧 worker 在“本轮没有笔记任务”时会提前返回，导致纯附件队列饥饿。
 * 当附件待处理、但笔记队列完全空闲时，把该附件所属笔记重新入队一次；worker 下一轮
 * 会先处理这条笔记，随后继续执行附件分支。该操作幂等，且每次最多唤醒一条笔记。
 */
export function wakeAttachmentOnlyQueue(): number {
  const db = getDb();
  const busy = db.prepare(`
    SELECT 1
    FROM embedding_queue
    WHERE status IN ('pending', 'processing')
    LIMIT 1
  `).get();
  if (busy) return 0;

  const candidate = db.prepare(`
    SELECT q.noteId
    FROM attachment_embedding_queue q
    JOIN notes n ON n.id = q.noteId
    WHERE q.status = 'pending'
      AND n.isTrashed = 0
    ORDER BY q.enqueuedAt ASC
    LIMIT 1
  `).get() as { noteId: string } | undefined;
  if (!candidate) return 0;

  return db.prepare(`
    INSERT INTO embedding_queue
      (noteId, userId, workspaceId, status, retries, enqueuedAt, updatedAt)
    SELECT id, userId, workspaceId, 'pending', 0, datetime('now'), datetime('now')
    FROM notes
    WHERE id = ? AND isTrashed = 0
    ON CONFLICT(noteId) DO UPDATE SET
      userId = excluded.userId,
      workspaceId = excluded.workspaceId,
      status = 'pending',
      retries = 0,
      lastError = 'wakeup: pending attachment queue',
      updatedAt = datetime('now')
  `).run(candidate.noteId).changes;
}

export function runEmbeddingQueueMaintenance(): void {
  try {
    const recovered = recoverStaleEmbeddingJobs();
    const awakened = wakeAttachmentOnlyQueue();
    if (recovered.notes || recovered.attachments || awakened) {
      console.warn(
        `[embedding-queue] maintenance recovered notes=${recovered.notes}, attachments=${recovered.attachments}, awakened=${awakened}`,
      );
    }
  } catch (error) {
    console.warn("[embedding-queue] maintenance failed:", error);
  }
}

export function installEmbeddingQueueHardening(): void {
  if (maintenanceTimer) return;
  const recovered = recoverInterruptedEmbeddingJobs();
  const awakened = wakeAttachmentOnlyQueue();
  if (recovered.notes || recovered.attachments || awakened) {
    console.warn(
      `[embedding-queue] startup recovered notes=${recovered.notes}, attachments=${recovered.attachments}, awakened=${awakened}`,
    );
  }
  maintenanceTimer = setInterval(runEmbeddingQueueMaintenance, MAINTENANCE_INTERVAL_MS);
  maintenanceTimer.unref?.();
}

export function stopEmbeddingQueueHardening(): void {
  if (!maintenanceTimer) return;
  clearInterval(maintenanceTimer);
  maintenanceTimer = null;
}

if (process.env.NODE_ENV !== "test") {
  installEmbeddingQueueHardening();
}
