import type { Migration } from "./migrations.impl.js";

/**
 * Replace the global hard-off tree Outbox gate with an active-Profile readiness gate.
 *
 * Existing profiles intentionally start without a readiness row, which is equivalent to pending.
 * A later negotiated tree-baseline flow must explicitly mark one profile ready before structural
 * edits are allowed to enter the Outbox.
 */
export const syncV2KnowledgeTreeReadinessMigration: Migration = {
  version: 109,
  name: "sync-v2-knowledge-tree-profile-readiness",
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS sync_v2_tree_profile_readiness (
        profileId TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'ready')),
        readyAt TEXT,
        updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (profileId) REFERENCES sync_profiles(id) ON DELETE CASCADE
      );

      DROP VIEW IF EXISTS sync_v2_tree_outbox_ready;
      CREATE VIEW sync_v2_tree_outbox_ready AS
      SELECT CASE WHEN EXISTS (
        SELECT 1
        FROM sync_v2_outbox_target target
        JOIN sync_v2_tree_profile_readiness readiness
          ON readiness.profileId = target.profileId
        WHERE readiness.status = 'ready'
      ) THEN 1 ELSE 0 END AS enabled;
    `);
  },
};
