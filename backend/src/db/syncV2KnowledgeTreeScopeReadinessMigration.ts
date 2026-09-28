import type { Migration } from "./migrations.impl.js";
import { installKnowledgeTreeOutboxTriggers } from "./syncV2KnowledgeTreeOutboxMigration.js";

/**
 * v111: tree readiness is scoped by (profile, scope), not only by profile.
 *
 * Personal tree convergence must never unlock unrelated workspaces. The trigger gate is
 * reinstalled after this table exists so each structural mutation checks its own scope.
 */
export const syncV2KnowledgeTreeScopeReadinessMigration: Migration = {
  version: 111,
  name: "sync-v2-knowledge-tree-scope-readiness",
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS sync_v2_tree_scope_readiness (
        profileId TEXT NOT NULL,
        scopeKey TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'ready')),
        readyAt TEXT,
        updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (profileId, scopeKey),
        FOREIGN KEY (profileId) REFERENCES sync_profiles(id) ON DELETE CASCADE
      );

      INSERT OR IGNORE INTO sync_v2_tree_scope_readiness (
        profileId, scopeKey, status, readyAt, updatedAt
      )
      SELECT profileId, 'personal', status, readyAt, updatedAt
      FROM sync_v2_tree_profile_readiness;

      DROP VIEW IF EXISTS sync_v2_tree_outbox_ready;
      CREATE VIEW sync_v2_tree_outbox_ready AS
      SELECT CASE WHEN EXISTS (
        SELECT 1
        FROM sync_v2_outbox_target target
        JOIN sync_v2_tree_scope_readiness readiness
          ON readiness.profileId = target.profileId
        WHERE readiness.status = 'ready'
      ) THEN 1 ELSE 0 END AS enabled;
    `);

    installKnowledgeTreeOutboxTriggers(db);
  },
};
