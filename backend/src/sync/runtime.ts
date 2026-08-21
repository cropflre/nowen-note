/**
 * Sync Engine 运行时管理器。
 *
 * 职责：把"数据库里的 SyncProfile 状态"翻译成"进程里活着的引擎实例"。
 *
 * 为什么需要这一层而不是在 index.ts 直接 new SyncEngine：
 * - 引擎生命周期由用户行为驱动（连接服务器 / 关闭同步 / 切换服务器），
 *   这些动作发生在 HTTP 路由里，而路由拿不到启动时创建的局部变量；
 * - 凭据可能晚于启动才写入（用户启动后才去设置页连接服务器），
 *   启动时一次性创建的实例无法覆盖这种情况；
 * - 切换服务器必须**先停旧引擎再起新引擎**，否则两个引擎会同时
 *   往不同服务器推同一批 Outbox。
 *
 * 单例语义：同一进程同一时刻最多一个活跃引擎。这与产品约束一致 ——
 * 用户只能启用一个 SyncProfile。
 */

import type Database from "better-sqlite3";

import { SyncEngine } from "./engine";
import type { SyncEngineStatus } from "./engine";
import { isLocalFirstSyncV2Enabled } from "./flag";
import { logSyncInfo, logSyncWarn } from "./log";
import { ensureDevice } from "./device";
import { getActiveProfile } from "./profile";
import { createRemoteClientForProfile } from "./credentials";
import { promoteLocalAttachments } from "./attachments";

interface ActiveEngine {
  engine: SyncEngine;
  profileId: string;
  deviceId: string;
}

let active: ActiveEngine | null = null;

/** 当前活跃引擎；未启用同步时为 null。 */
export function getActiveEngine(): SyncEngine | null {
  return active?.engine ?? null;
}

/** 当前活跃引擎绑定的 Profile / Device，供诊断接口展示。 */
export function getActiveEngineInfo(): { profileId: string; deviceId: string } | null {
  if (!active) return null;
  return { profileId: active.profileId, deviceId: active.deviceId };
}

/**
 * 停止并释放当前引擎。
 *
 * 只停调度，**不动任何本地数据**。未推送的 Outbox 原样保留，
 * 下次启用同步时继续推送。
 */
export function stopSyncEngine(): void {
  if (!active) return;
  const { engine, profileId, deviceId } = active;
  active = null;
  try {
    engine.stop();
  } catch (error) {
    logSyncWarn("runtime.stop-failed", {
      profileId,
      deviceId,
      errorCode: (error as Error)?.name || "UNKNOWN",
    });
  }
  logSyncInfo("runtime.stopped", { profileId, deviceId });
}

/**
 * 依据数据库当前状态同步引擎实例。
 *
 * 这是唯一的接线入口：启动时调一次，用户改动同步设置后再调一次。
 * 幂等 —— 重复调用不会产生第二个引擎。
 *
 * 不启动的四种情况（都属正常，不是错误）：
 * 1. Feature Flag 关闭；
 * 2. 没有任何启用的 Profile（用户选择"仅此设备"）；
 * 3. 尚未授权（凭据缺失）；
 * 4. userId 未知（Desktop 本地账号尚未就绪）。
 */
export function reconcileSyncEngine(
  db: Database.Database,
  options: { userId?: string | null; intervalMs?: number } = {},
): SyncEngine | null {
  if (!isLocalFirstSyncV2Enabled()) {
    stopSyncEngine();
    return null;
  }

  // getActiveProfile 依赖 v88 的 partial unique index 保证唯一性，
  // 不再需要在应用层扫描全部 Profile 找"第一个 enabled"。
  const enabled = getActiveProfile(db);

  // 用户关闭了同步，或切走了 Profile：停掉现有引擎。
  if (!enabled) {
    stopSyncEngine();
    return null;
  }

  // 已经在跑同一个 Profile：无需重建，保住它的内存状态与退避节奏。
  if (active && active.profileId === enabled.id) {
    return active.engine;
  }

  // Profile 变了（切换服务器）：必须先停旧的，否则会双写。
  stopSyncEngine();

  const client = createRemoteClientForProfile(enabled.id, enabled.serverUrl);
  if (!client) {
    // 尚未授权。这不是错误：用户可能刚填了地址还没登录。
    logSyncInfo("runtime.awaiting-credentials", { profileId: enabled.id });
    return null;
  }

  const userId = options.userId || resolveLocalUserId(db);
  if (!userId) {
    logSyncWarn("runtime.no-user", { profileId: enabled.id });
    return null;
  }

  const device = ensureDevice(db, {
    profileId: enabled.id,
    platform: process.platform,
  });

  // 把"关闭同步期间新增的附件"（status='local'）提升为待上传。
  // 不做这一步，用户开启同步前插入的图片永远不会上传，
  // 其他设备上会全是破图 —— 而且笔记正文同步成功，问题极难定位。
  try {
    const promoted = promoteLocalAttachments(db, enabled.id);
    if (promoted > 0) {
      logSyncInfo("runtime.promoted-attachments", {
        profileId: enabled.id,
        pendingCount: promoted,
      });
    }
  } catch (error) {
    // 提升失败不该阻止同步启动：笔记同步比附件补传更要紧。
    logSyncWarn("runtime.promote-attachments-failed", {
      profileId: enabled.id,
      errorCode: (error as Error)?.name || "UNKNOWN",
    });
  }

  const engine = new SyncEngine({
    db,
    profileId: enabled.id,
    deviceId: device.id,
    userId,
    client,
    intervalMs: options.intervalMs,
  });

  active = { engine, profileId: enabled.id, deviceId: device.id };
  engine.start();
  logSyncInfo("runtime.started", { profileId: enabled.id, deviceId: device.id });
  return engine;
}

/**
 * 推断本地用户 ID。
 *
 * Desktop 是单用户场景：Embedded Backend 里只有 ensureLocalAccount 建的那个账号。
 * 取最早创建的用户即可，避免调用方到处传 userId。
 */
function resolveLocalUserId(db: Database.Database): string | null {
  try {
    const row = db.prepare(
      "SELECT id FROM users ORDER BY createdAt ASC LIMIT 1",
    ).get() as { id?: string } | undefined;
    return row?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * 立即触发一轮同步。
 *
 * 用于："保存后尽快同步"、"用户点了立即同步"、"WebSocket 收到 sync.changed"。
 * 引擎未运行时返回 null，调用方不应把它当成失败 —— 本地保存早已成功。
 */
export async function triggerSyncNow(): Promise<SyncEngineStatus | null> {
  const engine = getActiveEngine();
  if (!engine) return null;
  return engine.syncOnce();
}

/** 网络恢复时立刻补一轮，不必等周期到点。 */
export function notifyNetworkOnline(): void {
  getActiveEngine()?.notifyNetworkOnline();
}
