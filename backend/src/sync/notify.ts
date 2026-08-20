import type Database from "better-sqlite3";
import { logSyncInfo } from "./log";

/**
 * Sync V2 实时通知（Phase 6）。
 *
 * 刻意**不**重新造一套 WebSocket 数据同步协议：
 * 消息里只带一个 sequence，客户端收到后照常走
 * GET /api/sync/v2/changes?after=<local cursor>。
 *
 * 这样做的价值在于容错：WebSocket 消息丢失、客户端断连期间的变更、
 * 消息乱序，全都由 Change Feed 的游标机制自然兜住。
 * 如果把数据塞进 WS 消息，一旦丢包就会永久缺失那条变更——
 * 而且没有任何机制能发现它缺了。
 *
 * 周期性 Pull 仍然保留作为最终兜底：即使 WS 完全不可用，同步照样收敛。
 */

export interface SyncChangedNotice {
  type: "sync.changed";
  sequence: number;
}

/** 由 realtime 服务注入，避免 sync 模块直接依赖 WebSocket 实现。 */
export type UserBroadcaster = (userId: string, message: unknown) => void;

let broadcaster: UserBroadcaster | null = null;

/**
 * 注册广播器。
 *
 * 用注入而非直接 import realtime：sync 模块要能在没有 WebSocket 的环境
 * （CLI、测试、迁移脚本）里正常工作，不该被实时层拖住。
 */
export function setSyncBroadcaster(fn: UserBroadcaster | null): void {
  broadcaster = fn;
}

/**
 * 通知某用户的其他设备："有新变更，来拉。"
 *
 * 不携带任何业务内容，因此无需担心权限过滤——
 * 客户端拿着自己的凭据去 /changes，服务端照常按 userId 隔离。
 */
export function notifySyncChanged(db: Database.Database, userId: string): void {
  if (!broadcaster) return;

  const row = db.prepare(
    "SELECT MAX(sequence) AS sequence FROM sync_changes_v2 WHERE userId = ?",
  ).get(userId) as { sequence: number | null } | undefined;
  const sequence = Number(row?.sequence || 0);
  if (sequence <= 0) return;

  const notice: SyncChangedNotice = { type: "sync.changed", sequence };
  try {
    broadcaster(userId, notice);
  } catch {
    // 通知失败不影响同步正确性：周期性 Pull 会补上。
    return;
  }

  logSyncInfo("realtime.notified", { pullSequence: sequence });
}
