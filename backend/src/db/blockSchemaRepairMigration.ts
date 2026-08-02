import type Database from "better-sqlite3";
import { ensureNoteBlockTables } from "../lib/noteBlocks.js";
import { blockAuthorityMigration } from "./blockAuthorityMigration.js";
import { blockAuthorityStaleGuardMigration } from "./blockAuthorityStaleGuardMigration.js";
import {
  MIGRATIONS as BASE_MIGRATIONS,
  type Migration,
} from "./migrations.impl.js";
import { yjsSubdocumentGenerationMigration } from "./yjsSubdocumentGenerationMigration.js";
import { yjsSubdocumentsMigration } from "./yjsSubdocumentsMigration.js";

const LEGACY_BLOCK_SCHEMA_VERSION = 48;

/**
 * Repair the complete block-storage schema for databases that reached a newer
 * schema version before the historical v48 migration was added to the registry.
 *
 * The old migration runner only compared MAX(schema_migrations.version), so a
 * database already at v50+ could permanently skip v48. That leaves
 * block_operations/note_blocks_index absent and makes the legacy createBlock
 * route fail before its runtime table guard can run.
 *
 * Every operation below is intentionally idempotent. Reusing the published
 * migration implementations keeps the repair aligned with the canonical schema
 * instead of maintaining a second copy of the DDL.
 */
export function ensureBlockSchemaRepair(db: Database.Database): void {
  const legacyBlockMigration = BASE_MIGRATIONS.find(
    (migration) => migration.version === LEGACY_BLOCK_SCHEMA_VERSION,
  );
  if (!legacyBlockMigration) {
    throw new Error(
      `[block-schema-repair] missing canonical v${LEGACY_BLOCK_SCHEMA_VERSION} migration`,
    );
  }

  legacyBlockMigration.up(db);
  ensureNoteBlockTables(db);

  // A database affected by the same out-of-order history can also be missing
  // the later block authority and optional Yjs shadow tables. Re-applying these
  // CREATE/ALTER/trigger migrations is safe and lets the next block write rebuild
  // the materialized state normally.
  blockAuthorityMigration.up(db);
  yjsSubdocumentsMigration.up(db);
  blockAuthorityStaleGuardMigration.up(db);
  yjsSubdocumentGenerationMigration.up(db);
}

export const blockSchemaRepairMigration: Migration = {
  version: 69,
  name: "repair-skipped-block-schema",
  up: ensureBlockSchemaRepair,
};
