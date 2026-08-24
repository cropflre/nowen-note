import type { DatabaseSync } from "node:sqlite";

export const REGISTRY_OPERATION_LEASE_MIGRATION_VERSION = 6;
export const REGISTRY_OPERATION_LEASE_MIGRATION_NAME = "registry_operation_leases";

export function runRegistryOperationLeaseMigration(db: DatabaseSync): void {
  const existing = db.prepare("SELECT name FROM registry_schema_migrations WHERE version=?").get(REGISTRY_OPERATION_LEASE_MIGRATION_VERSION) as { name: string } | undefined;
  if (existing) {
    if (existing.name !== REGISTRY_OPERATION_LEASE_MIGRATION_NAME) {
      throw new Error(`Registry migration v${REGISTRY_OPERATION_LEASE_MIGRATION_VERSION} is already occupied by ${existing.name}`);
    }
    return;
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      CREATE TABLE registry_operation_leases(
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('publish','artifact_gc')),
        holder TEXT NOT NULL,
        expiresAt INTEGER NOT NULL,
        createdAt TEXT NOT NULL
      );
      CREATE INDEX registry_operation_leases_kind_expiry_idx ON registry_operation_leases(kind,expiresAt);
    `);
    db.prepare("INSERT INTO registry_schema_migrations(version,name,appliedAt) VALUES (?,?,?)")
      .run(REGISTRY_OPERATION_LEASE_MIGRATION_VERSION, REGISTRY_OPERATION_LEASE_MIGRATION_NAME, new Date().toISOString());
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw new Error("Registry migration 6 (registry_operation_leases) failed", { cause: error });
  }
}
