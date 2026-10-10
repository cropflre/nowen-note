import type { Migration } from "./migrations.impl.js";

/**
 * v110: allow knowledge_tree_node conflicts to use the same durable conflict ledger.
 *
 * Rebuild instead of ALTER because SQLite cannot widen an existing CHECK constraint in place.
 * Every historical row and its resolution state is preserved.
 */
export const syncV2KnowledgeTreeConflictMigration: Migration = {
  version: 110,
  name: "sync-v2-knowledge-tree-conflicts",
  up: (db) => {
    db.exec(`
      DROP TABLE IF EXISTS sync_conflicts_v110;
      CREATE TABLE sync_conflicts_v110 (
        id TEXT PRIMARY KEY,
        profileId TEXT NOT NULL,
        scopeKey TEXT NOT NULL DEFAULT 'personal',
        entityType TEXT NOT NULL CHECK (entityType IN (
          'notebook', 'note', 'tag', 'note_tag', 'favorite', 'attachment',
          'task', 'task_reminder', 'diary', 'mindmap', 'knowledge_tree_node'
        )),
        entityId TEXT NOT NULL,
        localVersion INTEGER,
        remoteVersion INTEGER,
        basePayload TEXT,
        localPayload TEXT,
        remotePayload TEXT,
        status TEXT NOT NULL DEFAULT 'unresolved'
          CHECK (status IN ('unresolved', 'resolved')),
        createdAt TEXT NOT NULL DEFAULT (datetime('now')),
        resolvedAt TEXT,
        FOREIGN KEY (profileId) REFERENCES sync_profiles(id) ON DELETE CASCADE
      );

      INSERT INTO sync_conflicts_v110 (
        id, profileId, scopeKey, entityType, entityId,
        localVersion, remoteVersion, basePayload, localPayload, remotePayload,
        status, createdAt, resolvedAt
      )
      SELECT
        id, profileId, scopeKey, entityType, entityId,
        localVersion, remoteVersion, basePayload, localPayload, remotePayload,
        status, createdAt, resolvedAt
      FROM sync_conflicts ORDER BY rowid;

      DROP TABLE sync_conflicts;
      ALTER TABLE sync_conflicts_v110 RENAME TO sync_conflicts;

      CREATE INDEX idx_sync_conflicts_unresolved
        ON sync_conflicts(profileId, status, createdAt);
      CREATE INDEX idx_sync_conflicts_entity
        ON sync_conflicts(entityType, entityId);
      CREATE INDEX idx_sync_conflicts_profile_scope
        ON sync_conflicts(profileId, scopeKey, status, createdAt);
    `);

    const violations = db.pragma("foreign_key_check") as unknown[];
    if (violations.length > 0) {
      throw new Error(`[migrations] v110 重建冲突台账后外键校验失败：${violations.length} 处`);
    }
  },
};
