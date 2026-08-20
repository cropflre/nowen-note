import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { SYNC_TABLES } from "./constants";
import type { SyncDeviceRow } from "./types";

/**
 * 同步设备身份。
 *
 * deviceId 必须长期稳定：它是 Push 幂等归属、冲突来源判定和服务端设备列表的依据。
 * 如果每次启动重新生成，服务端会把同一台机器当成无数台新设备，
 * 冲突诊断也会失去意义。因此这里始终"读取已有，缺失才创建"。
 */

export interface EnsureDeviceInput {
  profileId: string;
  deviceName?: string | null;
  platform?: string | null;
}

/**
 * 取得（必要时创建）某个 Profile 下的本机设备记录。
 *
 * 一个 Profile 在本机只应有一条设备记录：同一台机器对同一服务器就是一个设备。
 * 因此这里按 profileId 查询而非按 deviceId，避免调用方不慎生成第二个身份。
 */
export function ensureDevice(
  db: Database.Database,
  input: EnsureDeviceInput,
): SyncDeviceRow {
  const existing = db.prepare(`
    SELECT * FROM ${SYNC_TABLES.devices}
    WHERE profileId = ?
    ORDER BY createdAt ASC
    LIMIT 1
  `).get(input.profileId) as SyncDeviceRow | undefined;

  if (existing) {
    // 设备名/平台可能因系统改名而变化，但 id 绝不变。
    const nextName = input.deviceName ?? existing.deviceName;
    const nextPlatform = input.platform ?? existing.platform;
    if (nextName !== existing.deviceName || nextPlatform !== existing.platform) {
      db.prepare(`
        UPDATE ${SYNC_TABLES.devices}
        SET deviceName = ?, platform = ?
        WHERE id = ?
      `).run(nextName, nextPlatform, existing.id);
      return { ...existing, deviceName: nextName, platform: nextPlatform };
    }
    return existing;
  }

  const id = randomUUID();
  db.prepare(`
    INSERT INTO ${SYNC_TABLES.devices} (
      id, profileId, deviceName, platform, createdAt, lastSeenAt
    ) VALUES (?, ?, ?, ?, datetime('now'), NULL)
  `).run(id, input.profileId, input.deviceName ?? null, input.platform ?? null);

  return db.prepare(`SELECT * FROM ${SYNC_TABLES.devices} WHERE id = ?`)
    .get(id) as SyncDeviceRow;
}

/** 记录一次成功通信时间，供设置页诊断展示。 */
export function touchDevice(db: Database.Database, deviceId: string): void {
  db.prepare(`
    UPDATE ${SYNC_TABLES.devices}
    SET lastSeenAt = datetime('now')
    WHERE id = ?
  `).run(deviceId);
}

export function getDevice(
  db: Database.Database,
  deviceId: string,
): SyncDeviceRow | null {
  const row = db.prepare(`SELECT * FROM ${SYNC_TABLES.devices} WHERE id = ?`)
    .get(deviceId) as SyncDeviceRow | undefined;
  return row || null;
}
