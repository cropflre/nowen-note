/**
 * Compatibility wrapper around the historical migration list.
 *
 * PR #243 originally inferred historical task completion time from updatedAt.
 * That value is not a reliable completion timestamp, so v44 now only adds the
 * column and clears impossible stale values. v45 introduces an append-only task
 * activity ledger used by records, trends and heatmaps.
 */
import type Database from "better-sqlite3";
import { markSearchIndexRebuilt, rebuildNormalizedSearchFts, repairSearchContentText } from "../lib/searchIndex.js";
import {
  MIGRATIONS as BASE_MIGRATIONS,
  type Migration,
} from "./migrations.impl.js";
import { roundTripImportLinksMigration } from "./roundtripImportLinksMigration.js";
import { roundTripImportBatchesMigration } from "./roundtripImportBatchesMigration.js";

export type { Migration } from "./migrations.impl.js";

function ensureTaskActivitySchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_activity_events (
      id TEXT PRIMARY KEY,
      taskId TEXT,
      taskTitle TEXT NOT NULL,
      eventType TEXT NOT NULL CHECK (eventType IN ('created', 'completed')),
      userId TEXT NOT NULL,
      workspaceId TEXT,
      projectId TEXT,
      occurredAt TEXT NOT NULL,
      createdAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE INDEX IF NOT EXISTS idx_task_activity_scope_time
      ON task_activity_events(workspaceId, userId, occurredAt DESC);
    CREATE INDEX IF NOT EXISTS idx_task_activity_task_type
      ON task_activity_events(taskId, eventType, occurredAt DESC);
    CREATE INDEX IF NOT EXISTS idx_task_activity_type_time
      ON task_activity_events(eventType, occurredAt DESC);

    DROP TRIGGER IF EXISTS tasks_activity_after_insert_created;
    CREATE TRIGGER tasks_activity_after_insert_created
    AFTER INSERT ON tasks
    BEGIN
      INSERT INTO task_activity_events (
        id, taskId, taskTitle, eventType, userId, workspaceId, projectId, occurredAt
      ) VALUES (
        lower(hex(randomblob(16))),
        NEW.id,
        NEW.title,
        'created',
        NEW.userId,
        NEW.workspaceId,
        NEW.projectId,
        CASE
          WHEN NEW.createdAt IS NULL OR trim(NEW.createdAt) = ''
            THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          WHEN NEW.createdAt GLOB '*Z' OR NEW.createdAt GLOB '*+??:??' OR NEW.createdAt GLOB '*-??:??'
            THEN replace(NEW.createdAt, ' ', 'T')
          ELSE replace(NEW.createdAt, ' ', 'T') || 'Z'
        END
      );
    END;

    DROP TRIGGER IF EXISTS tasks_activity_after_insert_completed;
    CREATE TRIGGER tasks_activity_after_insert_completed
    AFTER INSERT ON tasks
    WHEN NEW.isCompleted = 1
    BEGIN
      INSERT INTO task_activity_events (
        id, taskId, taskTitle, eventType, userId, workspaceId, projectId, occurredAt
      ) VALUES (
        lower(hex(randomblob(16))),
        NEW.id,
        NEW.title,
        'completed',
        NEW.userId,
        NEW.workspaceId,
        NEW.projectId,
        COALESCE(NULLIF(NEW.completedAt, ''), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
    END;

    DROP TRIGGER IF EXISTS tasks_activity_after_update_completed;
    CREATE TRIGGER tasks_activity_after_update_completed
    AFTER UPDATE OF isCompleted ON tasks
    WHEN OLD.isCompleted = 0 AND NEW.isCompleted = 1
    BEGIN
      INSERT INTO task_activity_events (
        id, taskId, taskTitle, eventType, userId, workspaceId, projectId, occurredAt
      ) VALUES (
        lower(hex(randomblob(16))),
        NEW.id,
        NEW.title,
        'completed',
        NEW.userId,
        NEW.workspaceId,
        NEW.projectId,
        COALESCE(NULLIF(NEW.completedAt, ''), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
    END;
  `);
}

const patchedV44: Migration = {
  version: 44,
  name: "tasks-completed-at",
  up: (db) => {
    const cols = db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[];
    if (!cols.some((column) => column.name === "completedAt")) {
      db.prepare("ALTER TABLE tasks ADD COLUMN completedAt TEXT").run();
    }
    // updatedAt is not a trustworthy historical completion timestamp. Unknown
    // historical completion times stay NULL instead of polluting heatmaps.
    db.prepare(
      "UPDATE tasks SET completedAt = NULL WHERE isCompleted = 0 AND completedAt IS NOT NULL",
    ).run();
  },
};

const activityMigration: Migration = {
  version: 45,
  name: "task-activity-events",
  up: ensureTaskActivitySchema,
};

const repairNotesFtsMigration: Migration = {
  version: 46,
  name: "repair-notes-fts-index",
  up: (db) => {
    // External-content FTS tables can drift after interrupted historical imports
    // or old trigger versions. Rebuild from notes once during upgrade; the live
    // insert/update/delete triggers keep it synchronized afterwards.
    db.prepare("INSERT INTO notes_fts(notes_fts) VALUES('rebuild')").run();
  },
};

const LEGACY_AI_SETTING_KEYS = [
  "ai_provider",
  "ai_api_url",
  "ai_api_key",
  "ai_model",
  "ai_embedding_url",
  "ai_embedding_key",
  "ai_embedding_model",
  "ai_profiles_v1",
  "ai_active_profile_id",
  "ai_manual_enabled",
] as const;
const LEGACY_AI_BACKUP_PREFIX = "ai_disabled_backup_";

const userAISettingsMigration: Migration = {
  version: 47,
  name: "user-ai-settings",
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS user_ai_settings (
        userId TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL DEFAULT '',
        updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (userId, key),
        FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_user_ai_settings_user
        ON user_ai_settings(userId);
    `);

    const placeholders = LEGACY_AI_SETTING_KEYS.map(() => "?").join(",");
    const legacySettings = db.prepare(`
      SELECT key, value
      FROM system_settings
      WHERE key IN (${placeholders}) OR substr(key, 1, ?) = ?
    `).all(
      ...LEGACY_AI_SETTING_KEYS,
      LEGACY_AI_BACKUP_PREFIX.length,
      LEGACY_AI_BACKUP_PREFIX,
    ) as Array<{ key: string; value: string }>;
    const admins = db.prepare("SELECT id FROM users WHERE role = 'admin'").all() as Array<{ id: string }>;
    const upsert = db.prepare(`
      INSERT INTO user_ai_settings (userId, key, value, updatedAt)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(userId, key) DO UPDATE SET
        value = excluded.value,
        updatedAt = datetime('now')
    `);

    for (const admin of admins) {
      for (const setting of legacySettings) {
        upsert.run(admin.id, setting.key, setting.value);
      }
    }

    db.prepare(`
      DELETE FROM system_settings
      WHERE key IN (${placeholders}) OR substr(key, 1, ?) = ?
    `).run(
      ...LEGACY_AI_SETTING_KEYS,
      LEGACY_AI_BACKUP_PREFIX.length,
      LEGACY_AI_BACKUP_PREFIX,
    );
    db.exec(`
      DROP TRIGGER IF EXISTS ai_manual_config_guard_insert;
      DROP TRIGGER IF EXISTS ai_manual_config_guard_update;
    `);
  },
};

const noteImportOriginsMigration: Migration = {
  version: 49,
  name: "note-import-origins",
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS note_import_origins (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        workspaceId TEXT,
        workspaceScope TEXT NOT NULL,
        noteId TEXT NOT NULL,
        sourceType TEXT NOT NULL,
        externalId TEXT NOT NULL,
        contentHash TEXT,
        batchId TEXT,
        importedAt TEXT NOT NULL DEFAULT (datetime('now')),
        updatedAt TEXT,
        metadata TEXT,
        FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (noteId) REFERENCES notes(id) ON DELETE CASCADE
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_note_import_origins_scope_external
        ON note_import_origins(userId, workspaceScope, sourceType, externalId);
      CREATE INDEX IF NOT EXISTS idx_note_import_origins_note
        ON note_import_origins(noteId);
      CREATE INDEX IF NOT EXISTS idx_note_import_origins_batch
        ON note_import_origins(batchId);
    `);
  },
};

const repairSearchContentTextMigration: Migration = {
  version: 52,
  name: "repair-search-content-text",
  up: (db) => {
    repairSearchContentText(db);
    db.prepare("INSERT INTO notes_fts(notes_fts) VALUES('rebuild')").run();
    rebuildNormalizedSearchFts(db);
    markSearchIndexRebuilt(db);
  },
};

export const MIGRATIONS: Migration[] = [
  ...BASE_MIGRATIONS.filter((migration) => migration.version !== 44),
  patchedV44,
  activityMigration,
  repairNotesFtsMigration,
  userAISettingsMigration,
  noteImportOriginsMigration,
  repairSearchContentTextMigration,
  roundTripImportLinksMigration,
  roundTripImportBatchesMigration,
].sort((a, b) => a.version - b.version);

export const CURRENT_SCHEMA_VERSION: number = MIGRATIONS.reduce(
  (highest, migration) => Math.max(highest, migration.version),
  0,
);

function ensureMigrationsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      appliedAt TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

export function getCurrentSchemaVersion(db: Database.Database): number {
  ensureMigrationsTable(db);
  const row = db
    .prepare("SELECT MAX(version) AS version FROM schema_migrations")
    .get() as { version: number | null } | undefined;
  return row?.version ?? 0;
}

export function runMigrations(db: Database.Database): number {
  ensureMigrationsTable(db);
  const current = getCurrentSchemaVersion(db);
  if (current > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `[migrations] 数据库版本 ${current} 高于当前程序支持的 ${CURRENT_SCHEMA_VERSION}。\n` +
      "请升级程序或从兼容版本备份恢复，禁止旧程序继续写入新版数据库。",
    );
  }

  const pending = MIGRATIONS
    .filter((migration) => migration.version > current)
    .sort((a, b) => a.version - b.version);
  if (pending.length === 0) return 0;

  let previous = current;
  for (const migration of pending) {
    if (migration.version <= previous) {
      throw new Error(
        `[migrations] 版本号必须严格递增：v${previous} 之后是 v${migration.version}（${migration.name}）`,
      );
    }
    previous = migration.version;
  }

  const insert = db.prepare(
    "INSERT INTO schema_migrations (version, name) VALUES (?, ?)",
  );
  let applied = 0;
  for (const migration of pending) {
    const transaction = db.transaction(() => {
      migration.up(db);
      insert.run(migration.version, migration.name);
    });
    try {
      transaction();
      applied += 1;
      console.log(`[migrations] applied v${migration.version} (${migration.name})`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `[migrations] v${migration.version} (${migration.name}) failed: ${message}`,
      );
    }
  }
  return applied;
}
