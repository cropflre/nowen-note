import { knowledgeTreeMigration } from "../db/knowledgeTreeMigration.js";
import { knowledgeTreeResourceMigration } from "../db/knowledgeTreeResourceMigration.js";
import { knowledgeTreeParentPreservationMigration } from "../db/knowledgeTreeParentPreservationMigration.js";
import { knowledgeTreeLegacySyncMigration } from "../db/knowledgeTreeLegacySyncMigration.js";
import { knowledgeTreeStructuralGuardMigration } from "../db/knowledgeTreeStructuralGuardMigration.js";
import { MIGRATIONS as BASE_MIGRATIONS } from "../db/migrations.impl.js";

// index.hardened imports this module before any runtime that can open the database.
// Mutating the historical base list here lets migrations.ts compute CURRENT_SCHEMA_VERSION
// with the feature migrations included, without coupling the main migration wrapper to them.
for (const featureMigration of [
  knowledgeTreeMigration,
  knowledgeTreeResourceMigration,
  knowledgeTreeParentPreservationMigration,
  knowledgeTreeLegacySyncMigration,
  knowledgeTreeStructuralGuardMigration,
]) {
  if (!BASE_MIGRATIONS.some((migration) => migration.version === featureMigration.version)) {
    BASE_MIGRATIONS.push(featureMigration);
  }
}
BASE_MIGRATIONS.sort((a, b) => a.version - b.version);
