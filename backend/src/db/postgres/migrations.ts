import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { DatabaseAdapter } from "../adapters/types";
import { getDatabaseAdapter } from "../runtime";
import { readPostgresSchemaSource } from "./schemaLoader";

export interface AppliedPostgresMigration {
  version: string;
  checksum: string;
  appliedAt: string;
}

const MIGRATION_FILE_PATTERN = /^\d{4}_[a-z0-9][a-z0-9_-]*\.sql$/i;

function migrationDirectoryCandidates(): string[] {
  return [
    join(__dirname, "migrations"),
    join(__dirname, "postgres", "migrations"),
    join(process.cwd(), "src", "db", "postgres", "migrations"),
    join(process.cwd(), "backend", "src", "db", "postgres", "migrations"),
    join(process.cwd(), "dist", "postgres", "migrations"),
  ];
}

function resolveMigrationDirectory(): string | undefined {
  const directory = migrationDirectoryCandidates().find((candidate) => existsSync(candidate));
  return directory ? resolve(directory) : undefined;
}

function checksum(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

function listMigrationFiles(): Array<{ version: string; source: string; checksum: string }> {
  const directory = resolveMigrationDirectory();
  if (!directory) return [];

  return readdirSync(directory)
    .filter((file) => MIGRATION_FILE_PATTERN.test(file))
    .sort((left, right) => left.localeCompare(right))
    .map((file) => {
      const source = readFileSync(join(directory, file), "utf-8");
      return { version: file.replace(/\.sql$/i, ""), source, checksum: checksum(source) };
    });
}

async function ensureMigrationTable(adapter: DatabaseAdapter): Promise<void> {
  await adapter.execute(`
    CREATE TABLE IF NOT EXISTS postgres_schema_migrations (
      version TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      "appliedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

/**
 * 初始化 PostgreSQL 空库并顺序应用不可变的版本化 migrations。
 *
 * schema.sql 当前仍作为幂等 bootstrap，确保历史试点库具备完整基础表；
 * 此后所有结构演化必须放进 migrations/*.sql，并通过 checksum 防止历史迁移被改写。
 */
export async function runPostgresMigrations(
  adapter: DatabaseAdapter = getDatabaseAdapter(),
): Promise<AppliedPostgresMigration[]> {
  await adapter.execute(readPostgresSchemaSource());
  await ensureMigrationTable(adapter);

  for (const migration of listMigrationFiles()) {
    const existing = await adapter.queryOne<AppliedPostgresMigration>(
      `SELECT version, checksum, "appliedAt" FROM postgres_schema_migrations WHERE version = ?`,
      [migration.version],
    );

    if (existing) {
      if (existing.checksum !== migration.checksum) {
        throw new Error(
          `[db] PostgreSQL migration ${migration.version} checksum mismatch; applied migrations are immutable`,
        );
      }
      continue;
    }

    await adapter.executeStatements([
      { sql: migration.source },
      {
        sql: `INSERT INTO postgres_schema_migrations (version, checksum) VALUES (?, ?)`,
        params: [migration.version, migration.checksum],
      },
    ]);
  }

  return adapter.queryMany<AppliedPostgresMigration>(
    `SELECT version, checksum, "appliedAt" FROM postgres_schema_migrations ORDER BY version`,
  );
}
