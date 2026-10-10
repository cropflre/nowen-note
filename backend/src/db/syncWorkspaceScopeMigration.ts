import type { Migration } from "./migrations.impl.js";
import { installSyncChangesV2Triggers } from "./syncChangesV2Migration.js";
import { installSyncOutboxCaptureTriggers } from "./syncOutboxCaptureMigration.js";
import { installSyncPersonalEntitiesTriggers } from "./syncPersonalEntitiesMigration.js";

const ENTITY_TYPES = `
  'notebook', 'note', 'tag', 'note_tag', 'favorite', 'attachment',
  'task', 'task_reminder', 'diary', 'mindmap'
`;

function hasColumn(
  db: Parameters<Migration["up"]>[0],
  table: string,
  column: string,
): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return columns.some((item) => item.name === column);
}

function addColumnIfMissing(
  db: Parameters<Migration["up"]>[0],
  table: string,
  column: string,
  definition: string,
): void {
  if (hasColumn(db, table, column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
}

function dropOutboxTriggers(db: Parameters<Migration["up"]>[0]): void {
  const triggers = db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'trigger' AND sql LIKE '%sync_outbox%'
  `).all() as Array<{ name: string }>;
  for (const { name } of triggers) {
    db.exec(`DROP TRIGGER IF EXISTS "${name.replaceAll('"', '""')}";`);
  }
}

function rebuildOutbox(db: Parameters<Migration["up"]>[0]): void {
  if (hasColumn(db, "sync_outbox", "scopeKey")) return;

  db.exec(`
    DROP TABLE IF EXISTS sync_outbox_v91;
    CREATE TABLE sync_outbox_v91 (
      id TEXT PRIMARY KEY,
      mutationId TEXT NOT NULL UNIQUE,
      profileId TEXT NOT NULL,
      scopeKey TEXT NOT NULL DEFAULT 'personal',
      deviceId TEXT NOT NULL,
      entityType TEXT NOT NULL CHECK (entityType IN (${ENTITY_TYPES})),
      entityId TEXT NOT NULL,
      operation TEXT NOT NULL CHECK (operation IN ('upsert', 'delete')),
      baseVersion INTEGER,
      payload TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (
        status IN ('pending', 'inflight', 'failed')
      ),
      retryCount INTEGER NOT NULL DEFAULT 0,
      lastAttemptAt TEXT,
      lastError TEXT,
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (profileId) REFERENCES sync_profiles(id) ON DELETE CASCADE
    );

    INSERT INTO sync_outbox_v91 (
      id, mutationId, profileId, scopeKey, deviceId, entityType, entityId,
      operation, baseVersion, payload, status, retryCount,
      lastAttemptAt, lastError, createdAt
    )
    SELECT id, mutationId, profileId, 'personal', deviceId, entityType, entityId,
           operation, baseVersion, payload, status, retryCount,
           lastAttemptAt, lastError, createdAt
    FROM sync_outbox;

    DROP TABLE sync_outbox;
    ALTER TABLE sync_outbox_v91 RENAME TO sync_outbox;

    CREATE INDEX idx_sync_outbox_pending
      ON sync_outbox(status, createdAt);
    CREATE INDEX idx_sync_outbox_profile
      ON sync_outbox(profileId, status);
    CREATE INDEX idx_sync_outbox_entity
      ON sync_outbox(entityType, entityId, status);
    CREATE INDEX idx_sync_outbox_profile_scope
      ON sync_outbox(profileId, scopeKey, status, createdAt);
  `);
}

function rebuildConflicts(db: Parameters<Migration["up"]>[0]): void {
  if (hasColumn(db, "sync_conflicts", "scopeKey")) return;

  db.exec(`
    DROP TABLE IF EXISTS sync_conflicts_v91;
    CREATE TABLE sync_conflicts_v91 (
      id TEXT PRIMARY KEY,
      profileId TEXT NOT NULL,
      scopeKey TEXT NOT NULL DEFAULT 'personal',
      entityType TEXT NOT NULL CHECK (entityType IN (${ENTITY_TYPES})),
      entityId TEXT NOT NULL,
      localVersion INTEGER,
      remoteVersion INTEGER,
      basePayload TEXT,
      localPayload TEXT,
      remotePayload TEXT,
      status TEXT NOT NULL DEFAULT 'unresolved' CHECK (
        status IN ('unresolved', 'resolved')
      ),
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      resolvedAt TEXT,
      FOREIGN KEY (profileId) REFERENCES sync_profiles(id) ON DELETE CASCADE
    );

    INSERT INTO sync_conflicts_v91 (
      id, profileId, scopeKey, entityType, entityId, localVersion, remoteVersion,
      basePayload, localPayload, remotePayload, status, createdAt, resolvedAt
    )
    SELECT id, profileId, 'personal', entityType, entityId, localVersion, remoteVersion,
           basePayload, localPayload, remotePayload, status, createdAt, resolvedAt
    FROM sync_conflicts;

    DROP TABLE sync_conflicts;
    ALTER TABLE sync_conflicts_v91 RENAME TO sync_conflicts;

    CREATE INDEX idx_sync_conflicts_unresolved
      ON sync_conflicts(profileId, status, createdAt);
    CREATE INDEX idx_sync_conflicts_entity
      ON sync_conflicts(entityType, entityId);
    CREATE INDEX idx_sync_conflicts_profile_scope
      ON sync_conflicts(profileId, scopeKey, status, createdAt);
  `);
}

/** v91：持久化工作区同步作用域、权限状态与逐作用域 Outbox/Conflict。 */
export const syncWorkspaceScopeMigration: Migration = {
  version: 91,
  name: "sync-v2-workspace-scopes",
  up: (db) => {
    dropOutboxTriggers(db);
    rebuildOutbox(db);
    rebuildConflicts(db);

    addColumnIfMissing(db, "sync_state", "accessFingerprint", "TEXT");
    addColumnIfMissing(
      db,
      "sync_state",
      "accessStatus",
      "TEXT NOT NULL DEFAULT 'active' CHECK (accessStatus IN ('active', 'replan_required', 'access_revoked'))",
    );
    addColumnIfMissing(db, "sync_state", "accessChangedAt", "TEXT");

    db.exec(`
      CREATE TABLE IF NOT EXISTS sync_workspace_scopes (
        profileId TEXT NOT NULL,
        scopeKey TEXT NOT NULL,
        workspaceId TEXT,
        workspaceName TEXT,
        role TEXT,
        canWrite INTEGER NOT NULL DEFAULT 0 CHECK (canWrite IN (0, 1)),
        accessFingerprint TEXT NOT NULL DEFAULT '',
        accessStatus TEXT NOT NULL DEFAULT 'active' CHECK (
          accessStatus IN ('active', 'replan_required', 'access_revoked')
        ),
        updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (profileId, scopeKey),
        FOREIGN KEY (profileId) REFERENCES sync_profiles(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_sync_workspace_scopes_access
        ON sync_workspace_scopes(profileId, accessStatus, updatedAt);
      CREATE INDEX IF NOT EXISTS idx_sync_workspace_scopes_workspace
        ON sync_workspace_scopes(workspaceId);
      CREATE INDEX IF NOT EXISTS idx_sync_state_access
        ON sync_state(profileId, accessStatus);
    `);

    const violations = db.pragma("foreign_key_check") as unknown[];
    if (violations.length > 0) {
      throw new Error(
        `[migrations] v91 重建同步作用域表后外键校验失败：${violations.length} 处`,
      );
    }

    installSyncChangesV2Triggers(db);
    installSyncOutboxCaptureTriggers(db);
    installSyncPersonalEntitiesTriggers(db);
  },
};
