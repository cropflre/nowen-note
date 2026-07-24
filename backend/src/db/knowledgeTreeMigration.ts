import type Database from "better-sqlite3";
import type { Migration } from "./migrations.impl.js";
import {
  KNOWLEDGE_TREE_SCHEMA_VERSION,
  ensureKnowledgeTreeTables as ensureBaseKnowledgeTreeTables,
} from "./knowledgeTreeMigrationCore.js";
import { ensureKnowledgeTreeLegacySync } from "./knowledgeTreeLegacySyncMigration.js";
import { ensureKnowledgeTreeStructuralGuard } from "./knowledgeTreeStructuralGuardMigration.js";

export { KNOWLEDGE_TREE_SCHEMA_VERSION };

/**
 * The base helper is intentionally idempotent and is called by services before queries. It also
 * recreates its original broad notebook sync and update-guard triggers, so always re-apply the
 * hardened v63/v64 variants before returning.
 */
export function ensureKnowledgeTreeTables(db: Database.Database): void {
  ensureBaseKnowledgeTreeTables(db);
  ensureKnowledgeTreeLegacySync(db);
  ensureKnowledgeTreeStructuralGuard(db);
}

export const knowledgeTreeMigration: Migration = {
  version: KNOWLEDGE_TREE_SCHEMA_VERSION,
  name: "knowledge-tree-capabilities",
  up: ensureKnowledgeTreeTables,
};
