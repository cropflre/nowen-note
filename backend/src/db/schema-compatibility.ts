import type Database from "better-sqlite3";

export class DatabaseUpgradeRequiredError extends Error {
  readonly code = "DATABASE_UPGRADE_REQUIRED";

  constructor(readonly databaseSchemaVersion: number, readonly codeSchemaVersion: number) {
    super(`[migrations] 数据库版本 ${databaseSchemaVersion} 高于当前程序支持的 ${codeSchemaVersion}。\n请升级服务端程序，保留原数据目录，禁止旧程序继续写入新版数据库。`);
    this.name = "DatabaseUpgradeRequiredError";
  }
}

/** Read only: older databases, including those without a ledger, migrate normally. */
export function assertSchemaCompatibility(db: Database.Database, supportedVersion: number): void {
  if (!Number.isSafeInteger(supportedVersion) || supportedVersion < 0) {
    throw new Error("[migrations] 程序数据库版本尚未就绪，拒绝初始化数据库");
  }
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get()) return;
  const row = db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number | null };
  if (row.version !== null && row.version > supportedVersion) {
    throw new DatabaseUpgradeRequiredError(row.version, supportedVersion);
  }
}
