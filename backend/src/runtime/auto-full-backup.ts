import { BackupManager } from "../services/backup.js";
import { getDb } from "../db/schema.js";
import { uploadAutomaticBackupToWebDav } from "../services/backup-webdav.js";

export type AutoBackupType = "full" | "db-only";

const AUTO_CONFIG_KEY = "backup:auto";
const PATCH_FLAG = Symbol.for("nowen.autoFullBackup.patched");
const RUNNING_FLAG = Symbol.for("nowen.autoFullBackup.running");

interface AutoBackupConfigLike {
  enabled?: boolean;
  intervalHours?: number;
  mode?: "interval" | "daily";
  dailyAt?: string;
  keepCount?: number;
  emailOnSuccess?: boolean;
  emailTo?: string;
  backupType?: unknown;
  [key: string]: unknown;
}

interface PatchedBackupManager {
  autoBackupConfig: AutoBackupConfigLike;
  createBackup: BackupManager["createBackup"];
  sendAutoBackupEmail(filename: string, to: string): Promise<void>;
  [RUNNING_FLAG]?: boolean;
}

interface PatchablePrototype extends Record<PropertyKey, unknown> {
  startAutoBackup: (config: AutoBackupConfigLike | number, options?: { persist?: boolean }) => void;
  readEffectiveAutoConfig: () => AutoBackupConfigLike;
  getHealth: () => Record<string, unknown>;
  runAutoTick: () => Promise<void>;
  [PATCH_FLAG]?: boolean;
}

export function normalizeAutoBackupType(value: unknown): AutoBackupType {
  return value === "db-only" ? "db-only" : "full";
}

function readPersistedAutoBackupType(): AutoBackupType {
  try {
    const row = getDb()
      .prepare("SELECT value FROM system_settings WHERE key = ?")
      .get(AUTO_CONFIG_KEY) as { value?: string } | undefined;
    if (row?.value) {
      const parsed = JSON.parse(row.value) as { backupType?: unknown };
      if (parsed.backupType === "full" || parsed.backupType === "db-only") {
        return parsed.backupType;
      }
    }
  } catch {
    // Database startup and malformed legacy rows both fall through to ENV/default.
  }

  return normalizeAutoBackupType(process.env.BACKUP_AUTO_TYPE);
}

function installAutoFullBackupPatch(): void {
  const prototype = BackupManager.prototype as unknown as PatchablePrototype;
  if (prototype[PATCH_FLAG]) return;
  prototype[PATCH_FLAG] = true;

  const nativeStartAutoBackup = prototype.startAutoBackup;
  prototype.startAutoBackup = function startAutoBackupWithType(
    configOrInterval: AutoBackupConfigLike | number,
    options: { persist?: boolean } = {},
  ): void {
    const config: AutoBackupConfigLike = typeof configOrInterval === "number"
      ? {
          enabled: true,
          intervalHours: configOrInterval,
          mode: "interval",
          dailyAt: "03:00",
          keepCount: 15,
          emailOnSuccess: false,
          emailTo: "",
        }
      : { ...configOrInterval };

    config.backupType = normalizeAutoBackupType(
      config.backupType ?? readPersistedAutoBackupType(),
    );
    nativeStartAutoBackup.call(this, config, options);
  };

  const nativeReadEffectiveAutoConfig = prototype.readEffectiveAutoConfig;
  prototype.readEffectiveAutoConfig = function readEffectiveAutoConfigWithType(): AutoBackupConfigLike {
    const config = nativeReadEffectiveAutoConfig.call(this);
    const effectiveConfig = {
      ...config,
      backupType: normalizeAutoBackupType(
        config.backupType ?? readPersistedAutoBackupType(),
      ),
    };
    (this as unknown as PatchedBackupManager).autoBackupConfig = effectiveConfig;
    return effectiveConfig;
  };

  const nativeGetHealth = prototype.getHealth;
  prototype.getHealth = function getHealthWithAutoType(): Record<string, unknown> {
    const health = nativeGetHealth.call(this);
    const manager = this as unknown as PatchedBackupManager;
    return {
      ...health,
      autoBackupType: normalizeAutoBackupType(manager.autoBackupConfig?.backupType),
    };
  };

  prototype.runAutoTick = async function runAttachmentSafeAutoBackup(): Promise<void> {
    const manager = this as unknown as PatchedBackupManager;
    if (manager[RUNNING_FLAG]) {
      console.warn("[Backup] 上一次自动备份仍在执行，本轮已跳过，避免全量备份并发占用磁盘");
      return;
    }

    manager[RUNNING_FLAG] = true;
    try {
      const config = manager.autoBackupConfig || {};
      const backupType = normalizeAutoBackupType(config.backupType);
      const info = await manager.createBackup({
        type: backupType,
        description: backupType === "full" ? "自动备份（全量）" : "自动备份（仅数据库）",
      });
      console.log(`[Backup] 自动${backupType === "full" ? "全量" : "数据库"}备份完成: ${info.filename}`);

      // Remote delivery is deliberately best-effort: a WebDAV outage must never turn a valid
      // local snapshot into a failed backup or block email delivery.
      await uploadAutomaticBackupToWebDav(info.filename)
        .then((uploaded) => {
          if (uploaded) console.log(`[Backup] 自动备份已同步到 WebDAV: ${info.filename}`);
        })
        .catch((error: unknown) => {
          console.warn(
            "[Backup] 自动备份 WebDAV 上传失败，本地备份仍然有效:",
            error instanceof Error ? error.message : error,
          );
        });

      if (config.emailOnSuccess === true && typeof config.emailTo === "string" && config.emailTo) {
        await manager.sendAutoBackupEmail(info.filename, config.emailTo).catch((error: unknown) => {
          console.warn(
            "[Backup] 自动备份邮件发送失败:",
            error instanceof Error ? error.message : error,
          );
        });
      }
    } catch (error) {
      console.error(
        "[Backup] 自动备份失败:",
        error instanceof Error ? error.message : error,
      );
    } finally {
      manager[RUNNING_FLAG] = false;
    }
  };
}

installAutoFullBackupPatch();
