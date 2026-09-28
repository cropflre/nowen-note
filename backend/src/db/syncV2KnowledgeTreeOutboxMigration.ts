import type Database from "better-sqlite3";
import type { Migration } from "./migrations.impl.js";
import { installSyncOutboxCaptureTriggers } from "./syncOutboxCaptureMigration.js";
import { installSyncPersonalEntitiesTriggers } from "./syncPersonalEntitiesMigration.js";
import { installKnowledgeTreeFeedTriggers } from "./syncV2KnowledgeTreeFeedMigration.js";

export function installKnowledgeTreeOutboxTriggers(db: Database.Database): void {
  const readinessTable = db.prepare(`
    SELECT 1 FROM sqlite_master
    WHERE type = 'table' AND name = 'sync_v2_tree_scope_readiness'
  `).get();
  const enqueueGate = `(SELECT enabled FROM sync_v2_should_enqueue) = 1`;
  const changed = `OLD.parentId IS NOT NEW.parentId OR OLD.sortOrder IS NOT NEW.sortOrder
    OR OLD.isDeleted IS NOT NEW.isDeleted OR OLD.deletedAt IS NOT NEW.deletedAt
    OR OLD.scopeKey IS NOT NEW.scopeKey OR OLD.workspaceId IS NOT NEW.workspaceId
    OR OLD.userId IS NOT NEW.userId OR OLD.nodeType IS NOT NEW.nodeType
    OR OLD.resourceType IS NOT NEW.resourceType OR OLD.resourceId IS NOT NEW.resourceId`;
  const scope = (alias: "OLD" | "NEW") => `CASE WHEN ${alias}.workspaceId IS NULL
    THEN 'personal' ELSE 'workspace:' || ${alias}.workspaceId END`;
  const readyGate = (alias: "OLD" | "NEW") => readinessTable
    ? `EXISTS (
        SELECT 1
        FROM sync_v2_tree_scope_readiness readiness
        JOIN sync_v2_outbox_target target ON target.profileId = readiness.profileId
        WHERE readiness.scopeKey = ${scope(alias)}
          AND readiness.status = 'ready'
      )`
    : `(SELECT enabled FROM sync_v2_tree_outbox_ready) = 1`;
  const payload = (alias: "OLD" | "NEW", base?: "OLD") => `json_object(
    'id', ${alias}.id, 'nodeType', ${alias}.nodeType,
    'resourceType', ${alias}.resourceType, 'resourceId', ${alias}.resourceId,
    'parentId', ${alias}.parentId, 'sortOrder', ${alias}.sortOrder,
    'isDeleted', ${alias}.isDeleted, 'deletedAt', ${alias}.deletedAt,
    'createdAt', ${alias}.createdAt, 'updatedAt', ${alias}.updatedAt,
    'userId', ${alias}.userId, 'workspaceId', ${alias}.workspaceId${base ? `,
    'baseParentId', ${base}.parentId, 'baseSortOrder', ${base}.sortOrder,
    'baseIsDeleted', ${base}.isDeleted, 'baseDeletedAt', ${base}.deletedAt` : ""}
  )`;
  const columns = `id, mutationId, profileId, scopeKey, deviceId, entityType,
    entityId, operation, baseVersion, payload, status, retryCount, createdAt`;
  const identity = `lower(hex(randomblob(16))), lower(hex(randomblob(16))),
    (SELECT profileId FROM sync_v2_outbox_target)`;
  const device = `(SELECT deviceId FROM sync_v2_local_device)`;

  db.exec(`
    DROP TRIGGER IF EXISTS sync_outbox_knowledge_tree_insert;
    CREATE TRIGGER sync_outbox_knowledge_tree_insert
    AFTER INSERT ON knowledge_tree_nodes WHEN ${enqueueGate}
      AND ${readyGate("NEW")}
      AND NEW.id NOT GLOB 'notebook:__nowen_root_documents__:*'
    BEGIN
      INSERT INTO sync_outbox (${columns}) VALUES (
        ${identity}, ${scope("NEW")}, ${device}, 'knowledge_tree_node',
        NEW.id, 'upsert', NULL, ${payload("NEW")}, 'pending', 0, datetime('now')
      );
    END;

    DROP TRIGGER IF EXISTS sync_outbox_knowledge_tree_update;
    CREATE TRIGGER sync_outbox_knowledge_tree_update
    AFTER UPDATE OF parentId, sortOrder, isDeleted, deletedAt, scopeKey,
      workspaceId, userId, nodeType, resourceType, resourceId ON knowledge_tree_nodes
    WHEN ${enqueueGate} AND (${changed})
      AND NEW.id NOT GLOB 'notebook:__nowen_root_documents__:*'
    BEGIN
      INSERT INTO sync_outbox (${columns})
      SELECT ${identity}, ${scope("OLD")}, ${device}, 'knowledge_tree_node',
        OLD.id, 'delete', NULL, NULL, 'pending', 0, datetime('now')
      WHERE (OLD.scopeKey IS NOT NEW.scopeKey OR OLD.userId IS NOT NEW.userId)
        AND ${readyGate("OLD")};

      INSERT INTO sync_outbox (${columns})
      SELECT ${identity}, ${scope("NEW")}, ${device}, 'knowledge_tree_node',
        NEW.id, 'upsert', NULL, ${payload("NEW", "OLD")}, 'pending', 0, datetime('now')
      WHERE ${readyGate("NEW")};
    END;

    DROP TRIGGER IF EXISTS sync_outbox_knowledge_tree_delete;
    CREATE TRIGGER sync_outbox_knowledge_tree_delete
    AFTER DELETE ON knowledge_tree_nodes WHEN ${enqueueGate}
      AND ${readyGate("OLD")}
      AND OLD.id NOT GLOB 'notebook:__nowen_root_documents__:*'
    BEGIN
      INSERT INTO sync_outbox (${columns}) VALUES (
        ${identity}, ${scope("OLD")}, ${device}, 'knowledge_tree_node',
        OLD.id, 'delete', NULL, NULL, 'pending', 0, datetime('now')
      );
    END;
  `);
}

/** Prepare atomic local tree capture; enable only after every Sync V2 consumer supports this entity. */
export const syncV2KnowledgeTreeOutboxMigration: Migration = {
  version: 108,
  name: "sync-v2-knowledge-tree-outbox",
  up: (db) => {
    const triggers = db.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'trigger' AND sql LIKE '%sync_outbox%'
    `).all() as Array<{ name: string }>;
    for (const { name } of triggers) {
      db.exec(`DROP TRIGGER IF EXISTS "${name.replaceAll('"', '""')}"`);
    }

    db.exec(`
      CREATE TABLE sync_outbox_v108 (
        id TEXT PRIMARY KEY,
        mutationId TEXT NOT NULL UNIQUE,
        profileId TEXT NOT NULL,
        scopeKey TEXT NOT NULL DEFAULT 'personal',
        deviceId TEXT NOT NULL,
        entityType TEXT NOT NULL CHECK (entityType IN (
          'notebook', 'note', 'tag', 'note_tag', 'favorite', 'attachment',
          'task', 'task_reminder', 'diary', 'mindmap', 'knowledge_tree_node'
        )),
        entityId TEXT NOT NULL,
        operation TEXT NOT NULL CHECK (operation IN ('upsert', 'delete')),
        baseVersion INTEGER,
        payload TEXT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'inflight', 'failed')),
        retryCount INTEGER NOT NULL DEFAULT 0,
        lastAttemptAt TEXT,
        lastError TEXT,
        createdAt TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (profileId) REFERENCES sync_profiles(id) ON DELETE CASCADE
      );
      INSERT INTO sync_outbox_v108
        (id, mutationId, profileId, scopeKey, deviceId, entityType, entityId,
         operation, baseVersion, payload, status, retryCount, lastAttemptAt, lastError, createdAt)
      SELECT id, mutationId, profileId, scopeKey, deviceId, entityType, entityId,
             operation, baseVersion, payload, status, retryCount, lastAttemptAt, lastError, createdAt
      FROM sync_outbox ORDER BY rowid;
      DROP TABLE sync_outbox;
      ALTER TABLE sync_outbox_v108 RENAME TO sync_outbox;
      CREATE INDEX idx_sync_outbox_pending ON sync_outbox(status, createdAt);
      CREATE INDEX idx_sync_outbox_profile ON sync_outbox(profileId, status);
      CREATE INDEX idx_sync_outbox_entity ON sync_outbox(entityType, entityId, status);
      CREATE INDEX idx_sync_outbox_profile_scope
        ON sync_outbox(profileId, scopeKey, status, createdAt);

      DROP VIEW IF EXISTS sync_v2_tree_outbox_ready;
      CREATE VIEW sync_v2_tree_outbox_ready AS SELECT 0 AS enabled;
    `);

    installSyncOutboxCaptureTriggers(db);
    installSyncPersonalEntitiesTriggers(db);
    installKnowledgeTreeFeedTriggers(db);
    installKnowledgeTreeOutboxTriggers(db);

    const violations = db.pragma("foreign_key_check") as unknown[];
    if (violations.length > 0) {
      throw new Error(`[migrations] v108 重建 Outbox 后外键校验失败：${violations.length} 处`);
    }
  },
};
