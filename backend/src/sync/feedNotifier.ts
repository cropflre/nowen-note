import type Database from "better-sqlite3";
import type { MiddlewareHandler } from "hono";
import { getDb, isDbMaintenanceInProgress } from "../db/schema";
import { hasSyncBroadcaster, notifySyncChanged } from "./notify";

/**
 * Change Feed 统一唤醒入口。
 *
 * sync_changes_v2 由 DB 触发器写入，覆盖 REST、Yjs 落盘、导入和维护任务，
 * 但历史上只有 Sync V2 Push 与知识树路由会发出 sync.changed。普通笔记 REST
 * 保存只广播 note:updated，Native 客户端因此要等 30 秒补偿 Pull。
 *
 * 这里用一个进程内水位线把"已提交但尚未通知"的 feed 行统一唤醒：
 * - 每次写请求结束后立即冲刷（低延迟）；
 * - 后台定时冲刷兜住非 HTTP 写入者（Yjs 落盘、导入任务）。
 * 通知只携带 sequence，权威数据仍由客户端经 /changes 拉取。
 */

let watermark: number | null = null;

function currentMaxSequence(db: Database.Database): number {
  const row = db.prepare("SELECT MAX(sequence) AS sequence FROM sync_changes_v2").get() as { sequence: number | null } | undefined;
  return Number(row?.sequence || 0);
}

/** 在首次写入前确定水位线，避免把启动前的历史 feed 当作新变更重复广播。 */
export function primeSyncChangeWatermark(db: Database.Database): void {
  if (watermark === null) watermark = currentMaxSequence(db);
}

/**
 * 通知水位线之后所有已提交的 feed 行所属作用域。
 *
 * 处于事务中时不冲刷：better-sqlite3 单连接能读到未提交行，过早通知会让
 * 客户端在回滚前拉取。稍后的请求或定时器会再次冲刷。
 */
export function flushSyncChangeNotices(db: Database.Database): number {
  if (!hasSyncBroadcaster() || !db.open || db.inTransaction) return 0;
  if (watermark === null) { watermark = currentMaxSequence(db); return 0; }
  const rows = db.prepare(`
    SELECT userId, workspaceId, MAX(sequence) AS sequence FROM sync_changes_v2
    WHERE sequence > ? GROUP BY userId, workspaceId
  `).all(watermark) as Array<{ userId: string; workspaceId: string | null; sequence: number }>;
  if (!rows.length) return 0;
  watermark = Math.max(watermark, ...rows.map((row) => Number(row.sequence)));
  const sent = new Set<string>();
  for (const row of rows) {
    // 工作区通知按作用域发给全部成员；个人空间按用户发送。
    const key = row.workspaceId ? `workspace:${row.workspaceId}` : `personal:${row.userId}`;
    if (sent.has(key)) continue;
    sent.add(key);
    try {
      notifySyncChanged(db, row.userId, row.workspaceId ? key : "personal");
    } catch {
      // 唤醒失败不影响正确性：客户端补偿 Pull 会追上。
    }
  }
  return sent.size;
}

/** 写请求结束后唤醒订阅设备。权限过滤仍由 /changes 负责。 */
export const syncChangeNoticeMiddleware: MiddlewareHandler = async (c, next) => {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(c.req.method) || !hasSyncBroadcaster()) return next();
  if (!isDbMaintenanceInProgress()) {
    try {
      primeSyncChangeWatermark(getDb());
    } catch {
      // 预热失败不阻断主请求
    }
  }
  try {
    await next();
  } finally {
    // 备份恢复等维护操作会关闭并重建数据库连接；善后通知必须重新取当前活跃连接，
    // 且任何失败都不得覆盖已经成功的业务 HTTP 响应。
    if (!isDbMaintenanceInProgress()) {
      try {
        const currentDb = getDb();
        flushSyncChangeNotices(currentDb);
      } catch (error) {
        console.warn("[sync-v2] flushSyncChangeNotices skipped:", error instanceof Error ? error.name : "UnknownError");
      }
    }
  }
};

/** 后台兜底：覆盖不经过 HTTP 的写入路径。返回停止函数。 */
export function startSyncChangeNoticeFlusher(db: Database.Database, intervalMs = 1000): () => void {
  primeSyncChangeWatermark(db);
  const timer = setInterval(() => {
    if (isDbMaintenanceInProgress()) return;
    try { flushSyncChangeNotices(getDb()); } catch { /* 下一轮重试 */ }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** 换库（如备份恢复）后重置进程内水位线，避免沿用旧库高水位。 */
export function resetSyncChangeWatermark(): void {
  watermark = null;
}

/** 仅供测试重置模块状态。 */
export function resetSyncChangeWatermarkForTests(): void {
  resetSyncChangeWatermark();
}
