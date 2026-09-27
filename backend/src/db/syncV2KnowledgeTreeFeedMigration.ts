import type Database from "better-sqlite3";
import type { Migration } from "./migrations.impl.js";
import { installSyncChangesV2Triggers } from "./syncChangesV2Migration.js";
import { installSyncPersonalEntitiesTriggers } from "./syncPersonalEntitiesMigration.js";

function installKnowledgeTreeFeedTriggers(db: Database.Database): void {
  const changed = `
    OLD.parentId IS NOT NEW.parentId OR OLD.sortOrder IS NOT NEW.sortOrder
    OR OLD.isDeleted IS NOT NEW.isDeleted OR OLD.deletedAt IS NOT NEW.deletedAt
    OR OLD.scopeKey IS NOT NEW.scopeKey OR OLD.workspaceId IS NOT NEW.workspaceId
    OR OLD.userId IS NOT NEW.userId OR OLD.nodeType IS NOT NEW.nodeType
    OR OLD.resourceType IS NOT NEW.resourceType OR OLD.resourceId IS NOT NEW.resourceId
  `;
  const scopeChanged = "OLD.scopeKey IS NOT NEW.scopeKey OR OLD.userId IS NOT NEW.userId";
  db.exec(`
    DROP TRIGGER IF EXISTS sync_v2_knowledge_tree_feed_insert;
    CREATE TRIGGER sync_v2_knowledge_tree_feed_insert
    AFTER INSERT ON knowledge_tree_nodes
    WHEN (SELECT enabled FROM sync_v2_should_log) = 1
    BEGIN
      INSERT INTO sync_changes_v2 (entityType, entityId, userId, workspaceId, operation)
      VALUES ('knowledge_tree_node', NEW.id, NEW.userId, NEW.workspaceId, 'upsert');
    END;

    DROP TRIGGER IF EXISTS sync_v2_knowledge_tree_feed_update;
    CREATE TRIGGER sync_v2_knowledge_tree_feed_update
    AFTER UPDATE OF parentId, sortOrder, isDeleted, deletedAt, scopeKey,
      workspaceId, userId, nodeType, resourceType, resourceId ON knowledge_tree_nodes
    WHEN (SELECT enabled FROM sync_v2_should_log) = 1 AND (${changed})
    BEGIN
      INSERT INTO sync_changes_v2 (entityType, entityId, userId, workspaceId, operation)
      SELECT 'knowledge_tree_node', OLD.id, OLD.userId, OLD.workspaceId, 'delete'
      WHERE ${scopeChanged};
      INSERT INTO sync_changes_v2 (entityType, entityId, userId, workspaceId, operation)
      VALUES ('knowledge_tree_node', NEW.id, NEW.userId, NEW.workspaceId, 'upsert');
    END;

    DROP TRIGGER IF EXISTS sync_v2_knowledge_tree_feed_delete;
    CREATE TRIGGER sync_v2_knowledge_tree_feed_delete
    AFTER DELETE ON knowledge_tree_nodes
    WHEN (SELECT enabled FROM sync_v2_should_log) = 1
    BEGIN
      INSERT INTO sync_changes_v2 (entityType, entityId, userId, workspaceId, operation)
      VALUES ('knowledge_tree_node', OLD.id, OLD.userId, OLD.workspaceId, 'delete');
    END;
  `);
}

/** Capture tree structure without exposing it to clients until the full Sync V2 chain is ready. */
export const syncV2KnowledgeTreeFeedMigration: Migration = {
  version: 107,
  name: "sync-v2-knowledge-tree-feed",
  up: (db) => {
    const highWater = (db.prepare(
      "SELECT seq FROM sqlite_sequence WHERE name = 'sync_changes_v2'",
    ).get() as { seq: number } | undefined)?.seq ?? 0;
    const triggers = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'trigger' AND sql LIKE '%sync_changes_v2%'
    `).all() as Array<{ name: string }>;
    for (const { name } of triggers) {
      db.exec(`DROP TRIGGER IF EXISTS "${name.replaceAll('"', '""')}"`);
    }

    db.exec(`
      CREATE TABLE sync_changes_v2_next (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        entityType TEXT NOT NULL CHECK (entityType IN (
          'notebook', 'note', 'tag', 'note_tag', 'favorite', 'attachment',
          'task', 'task_reminder', 'diary', 'mindmap', 'knowledge_tree_node'
        )),
        entityId TEXT NOT NULL,
        noteId TEXT,
        userId TEXT NOT NULL,
        workspaceId TEXT,
        operation TEXT NOT NULL CHECK (operation IN ('upsert', 'delete')),
        version INTEGER,
        changedAt TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO sync_changes_v2_next
        (sequence, entityType, entityId, noteId, userId, workspaceId, operation, version, changedAt)
      SELECT sequence, entityType, entityId, noteId, userId, workspaceId, operation, version, changedAt
      FROM sync_changes_v2;
      DROP TABLE sync_changes_v2;
      ALTER TABLE sync_changes_v2_next RENAME TO sync_changes_v2;
      CREATE INDEX idx_sync_changes_v2_user_sequence ON sync_changes_v2(userId, sequence);
      CREATE INDEX idx_sync_changes_v2_scope_sequence ON sync_changes_v2(workspaceId, sequence);
      CREATE INDEX idx_sync_changes_v2_entity ON sync_changes_v2(entityType, entityId, sequence);
      CREATE INDEX idx_sync_changes_v2_time ON sync_changes_v2(changedAt);
    `);
    if (highWater > 0) {
      db.prepare("DELETE FROM sqlite_sequence WHERE name = 'sync_changes_v2'").run();
      db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES ('sync_changes_v2', ?)").run(highWater);
    }

    installSyncChangesV2Triggers(db);
    installSyncPersonalEntitiesTriggers(db);
    installKnowledgeTreeFeedTriggers(db);
  },
};
