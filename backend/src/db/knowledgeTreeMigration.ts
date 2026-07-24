import type Database from "better-sqlite3";
import type { Migration } from "./migrations.impl.js";
import {
  KNOWLEDGE_TREE_SCHEMA_VERSION,
  ensureKnowledgeTreeTables as ensureBaseKnowledgeTreeTables,
} from "./knowledgeTreeMigrationCore.js";
import { ensureKnowledgeTreeLegacySync } from "./knowledgeTreeLegacySyncMigration.js";
import { ensureKnowledgeTreeStructuralGuard } from "./knowledgeTreeStructuralGuardMigration.js";

export { KNOWLEDGE_TREE_SCHEMA_VERSION };

const initializedConnections = new WeakSet<Database.Database>();

/**
 * Install the tree schema and hardened triggers once for each open database connection.
 *
 * The historical base helper performs backfill DML in addition to idempotent DDL. Re-running it
 * before every read/restore is both expensive and unsafe while a subtree is temporarily soft
 * deleted. getDb() already runs registered migrations before serving requests, so service-level
 * calls only need a per-connection fallback for direct tests and old embedding entry points.
 */
export function ensureKnowledgeTreeTables(db: Database.Database): void {
  if (initializedConnections.has(db)) return;
  ensureBaseKnowledgeTreeTables(db);
  ensureKnowledgeTreeLegacySync(db);
  ensureKnowledgeTreeStructuralGuard(db);
  initializedConnections.add(db);
}

export const knowledgeTreeMigration: Migration = {
  version: KNOWLEDGE_TREE_SCHEMA_VERSION,
  name: "knowledge-tree-capabilities",
  up: ensureKnowledgeTreeTables,
};
