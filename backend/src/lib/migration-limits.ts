import { systemSettingsRepository } from "../repositories";
import { MIGRATION_LIMITS } from "../services/migrationFormat";

/**
 * 实例级迁移单包（ZIP）上传上限（单位：MB），存放在 system_settings 表，仅管理员可修改。
 * 保持在 100 MB ~ 3584 MB（3.5 GB）以内，兼容标准 32-bit ZIP 预检（< 4 GiB）；
 * 桌面端本地文件夹零拷贝直导不受此上限约束。
 */
export const MIGRATION_MAX_UPLOAD_MB_KEY = "migration_max_upload_mb";
export const MIN_MIGRATION_UPLOAD_MB = 100;
export const MAX_MIGRATION_UPLOAD_MB = 3584;
export const DEFAULT_MIGRATION_UPLOAD_MB = Math.min(
  MAX_MIGRATION_UPLOAD_MB,
  Math.max(MIN_MIGRATION_UPLOAD_MB, Math.round(MIGRATION_LIMITS.uploadBytes / (1024 * 1024))),
);

export function parseMigrationMaxUploadMb(raw: unknown): number | null {
  const num = typeof raw === "number"
    ? raw
    : typeof raw === "string" && /^\s*\d+\s*$/.test(raw)
      ? Number(raw.trim())
      : NaN;
  if (!Number.isInteger(num) || num < MIN_MIGRATION_UPLOAD_MB || num > MAX_MIGRATION_UPLOAD_MB) {
    return null;
  }
  return num;
}

export function getConfiguredMigrationMaxUploadMb(): number {
  try {
    const stored = systemSettingsRepository.get(MIGRATION_MAX_UPLOAD_MB_KEY)?.value;
    const parsed = parseMigrationMaxUploadMb(stored);
    if (parsed !== null) return parsed;
  } catch {
    // 纯单元测试或数据库尚未初始化时回退到启动默认值
  }
  return DEFAULT_MIGRATION_UPLOAD_MB;
}

export function getRuntimeMigrationLimits() {
  const uploadMb = getConfiguredMigrationMaxUploadMb();
  const uploadBytes = uploadMb * 1024 * 1024;
  return {
    ...MIGRATION_LIMITS,
    uploadBytes,
    extractedBytes: Math.max(MIGRATION_LIMITS.extractedBytes, uploadBytes * 2),
    temporaryBytes: Math.max(MIGRATION_LIMITS.temporaryBytes, uploadBytes * 3),
  };
}
