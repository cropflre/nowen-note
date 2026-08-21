import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { SYNC_TABLES } from "./constants";
import type { SyncDeviceRow } from "./types";

/**
 * 同步设备身份（阶段 B：Installation-scoped）。
 *
 * ## 语义
 *
 * deviceId 标识**一个 Nowen 安装实例**，不是"某个 Profile 下的设备"。
 * 同一台电脑连 Server A / Server B / Server C，deviceId 永远相同。
 *
 * 以下操作都不改变它：
 *   重启 · 切换服务器 · 重新登录 · 关闭再开启同步 · 恢复备份
 *
 * Profile 与 Device 之间是 **membership** 关系（sync_profile_devices），
 * 切换服务器只是增加/切换一条 membership。
 *
 * ## 为什么必须这样
 *
 * 旧实现按 profileId 查、查不到就 randomUUID()，导致同一台机器在不同
 * 服务器上被记成不同设备。后果：
 * - Push 幂等归属混乱：服务端无法判断"这条 mutation 是不是我自己发的"；
 * - 冲突来源判定失效：无法区分"另一台设备改的"与"本机上次改的"；
 * - 服务端设备列表膨胀，用户看到一堆幽灵设备。
 */

/** 首次创建安装身份时的可选描述信息。 */
export interface EnsureInstallationDeviceInput {
  deviceName?: string | null;
  platform?: string | null;
}

/**
 * 取得（必要时创建）本安装实例的设备身份。
 *
 * 单例：`sync_device_identity` 的 singletonKey 恒为 1，由 CHECK 约束
 * 从物理上排除第二行，因此不存在"生成了第二个身份"的可能。
 *
 * 迁移兼容：v88 已把 sync_devices 中最早创建的 deviceId 提升为安装身份，
 * 所以老用户的 deviceId 不会变。这里的兜底分支只在
 * "从未开启过同步的全新安装" 上触发。
 */
export function ensureInstallationDevice(
  db: Database.Database,
  input: EnsureInstallationDeviceInput = {},
): { deviceId: string; deviceName: string | null; platform: string | null } {
  const existing = db.prepare(`
    SELECT deviceId, deviceName, platform FROM sync_device_identity
    WHERE singletonKey = 1
  `).get() as
    | { deviceId: string; deviceName: string | null; platform: string | null }
    | undefined;

  if (existing) {
    // 名称/平台可能因系统改名或跨平台恢复而变化，但 deviceId 绝不变。
    const nextName = input.deviceName ?? existing.deviceName;
    const nextPlatform = input.platform ?? existing.platform;
    if (nextName !== existing.deviceName || nextPlatform !== existing.platform) {
      db.prepare(`
        UPDATE sync_device_identity SET deviceName = ?, platform = ?
        WHERE singletonKey = 1
      `).run(nextName, nextPlatform);
      return { deviceId: existing.deviceId, deviceName: nextName, platform: nextPlatform };
    }
    return existing;
  }

  // 兜底：复用旧表里最早的 deviceId（与 v88 迁移同一规则），
  // 避免升级路径之外的边角情况凭空生成新身份。
  const legacy = db.prepare(`
    SELECT id FROM ${SYNC_TABLES.devices} ORDER BY createdAt ASC, rowid ASC LIMIT 1
  `).get() as { id: string } | undefined;

  const deviceId = legacy?.id || randomUUID();
  db.prepare(`
    INSERT INTO sync_device_identity (singletonKey, deviceId, deviceName, platform)
    VALUES (1, ?, ?, ?)
  `).run(deviceId, input.deviceName ?? null, input.platform ?? null);

  return {
    deviceId,
    deviceName: input.deviceName ?? null,
    platform: input.platform ?? null,
  };
}

/** 读取安装身份；尚未建立时返回 null（不产生副作用）。 */
export function getInstallationDeviceId(db: Database.Database): string | null {
  const row = db.prepare(
    "SELECT deviceId FROM sync_device_identity WHERE singletonKey = 1",
  ).get() as { deviceId?: string } | undefined;
  return row?.deviceId ?? null;
}

export interface EnsureDeviceInput {
  profileId: string;
  deviceName?: string | null;
  platform?: string | null;
}

/**
 * 建立（必要时创建）某个 Profile 与本安装实例的 membership。
 *
 * 返回结构保持与旧 SyncDeviceRow 兼容，便于既有调用方与诊断接口。
 * 关键区别：`id` 现在是**安装级** deviceId —— 换服务器时它不变。
 */
export function ensureDevice(
  db: Database.Database,
  input: EnsureDeviceInput,
): SyncDeviceRow {
  const identity = ensureInstallationDevice(db, {
    deviceName: input.deviceName,
    platform: input.platform,
  });

  db.prepare(`
    INSERT INTO sync_profile_devices
      (profileId, deviceId, deviceName, platform, createdAt, lastSeenAt)
    VALUES (?, ?, ?, ?, datetime('now'), NULL)
    ON CONFLICT(profileId, deviceId) DO UPDATE SET
      deviceName = COALESCE(excluded.deviceName, sync_profile_devices.deviceName),
      platform = COALESCE(excluded.platform, sync_profile_devices.platform)
  `).run(
    input.profileId,
    identity.deviceId,
    input.deviceName ?? identity.deviceName,
    input.platform ?? identity.platform,
  );

  const row = db.prepare(`
    SELECT deviceId AS id, profileId, deviceName, platform, createdAt, lastSeenAt
    FROM sync_profile_devices
    WHERE profileId = ? AND deviceId = ?
  `).get(input.profileId, identity.deviceId) as SyncDeviceRow;

  return row;
}

/**
 * 记录一次成功通信时间，供设置页诊断展示。
 *
 * 更新全部 membership：deviceId 是安装级的，"本机刚刚通信过"
 * 这个事实对所有 Profile 都成立。
 */
export function touchDevice(db: Database.Database, deviceId: string): void {
  db.prepare(`
    UPDATE sync_profile_devices SET lastSeenAt = datetime('now')
    WHERE deviceId = ?
  `).run(deviceId);
}

/**
 * 按 deviceId 读取一条 membership（任意 Profile）。
 *
 * 主要供诊断与测试使用；业务判定应直接用 getInstallationDeviceId()。
 */
export function getDevice(
  db: Database.Database,
  deviceId: string,
): SyncDeviceRow | null {
  const row = db.prepare(`
    SELECT deviceId AS id, profileId, deviceName, platform, createdAt, lastSeenAt
    FROM sync_profile_devices
    WHERE deviceId = ?
    ORDER BY createdAt ASC
    LIMIT 1
  `).get(deviceId) as SyncDeviceRow | undefined;
  return row || null;
}

/** 某个 Profile 的全部设备 membership，供设置页展示"已同步的设备"。 */
export function listProfileDevices(
  db: Database.Database,
  profileId: string,
): SyncDeviceRow[] {
  return db.prepare(`
    SELECT deviceId AS id, profileId, deviceName, platform, createdAt, lastSeenAt
    FROM sync_profile_devices
    WHERE profileId = ?
    ORDER BY createdAt ASC
  `).all(profileId) as SyncDeviceRow[];
}
