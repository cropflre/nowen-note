import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { MIGRATIONS } from "../src/db/migrations";

function createLegacyDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      passwordHash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user'
    );

    CREATE TABLE system_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT '',
      updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
    );

    INSERT INTO users (id, username, passwordHash, role) VALUES
      ('admin-a', 'admin-a', 'hash', 'admin'),
      ('admin-b', 'admin-b', 'hash', 'admin'),
      ('normal-user', 'normal-user', 'hash', 'user');

    INSERT INTO system_settings (key, value) VALUES
      ('ai_provider', 'deepseek'),
      ('ai_api_url', 'https://legacy.example/v1'),
      ('ai_api_key', 'legacy-secret'),
      ('ai_model', 'legacy-model'),
      ('ai_profiles_v1', '[{"id":"legacy-profile"}]'),
      ('ai_disabled_backup_ai_api_key', 'backup-secret'),
      ('aiXdisabledYbackupZsite', 'must-stay'),
      ('site_title', 'Nowen');

    CREATE TRIGGER ai_manual_config_guard_insert
    BEFORE INSERT ON system_settings
    WHEN NEW.key = 'ai_provider'
    BEGIN
      SELECT RAISE(IGNORE);
    END;

    CREATE TRIGGER ai_manual_config_guard_update
    BEFORE UPDATE ON system_settings
    WHEN NEW.key = 'ai_provider'
    BEGIN
      SELECT RAISE(IGNORE);
    END;
  `);
  return db;
}

test("user AI settings migration copies legacy AI config only to admins", () => {
  const migration = MIGRATIONS.find((item) => item.name === "user-ai-settings");
  assert.ok(migration, "user-ai-settings migration should be registered");

  const db = createLegacyDb();
  migration.up(db);

  const rows = db.prepare(`
    SELECT userId, key, value
    FROM user_ai_settings
    ORDER BY userId, key
  `).all() as Array<{ userId: string; key: string; value: string }>;

  for (const adminId of ["admin-a", "admin-b"]) {
    assert.ok(rows.some((row) => row.userId === adminId && row.key === "ai_api_key" && row.value === "legacy-secret"));
    assert.ok(rows.some((row) => row.userId === adminId && row.key === "ai_profiles_v1"));
    assert.ok(rows.some((row) => row.userId === adminId && row.key === "ai_disabled_backup_ai_api_key"));
  }
  assert.equal(rows.some((row) => row.userId === "normal-user"), false);

  const legacyAI = db.prepare(`
    SELECT COUNT(*) AS count
    FROM system_settings
    WHERE key IN ('ai_provider', 'ai_api_url', 'ai_api_key', 'ai_model', 'ai_profiles_v1')
       OR substr(key, 1, 19) = 'ai_disabled_backup_'
  `).get() as { count: number };
  assert.equal(legacyAI.count, 0);
  assert.equal(
    (db.prepare("SELECT value FROM system_settings WHERE key = 'site_title'").get() as { value: string }).value,
    "Nowen",
  );
  assert.equal(
    (db.prepare("SELECT value FROM system_settings WHERE key = 'aiXdisabledYbackupZsite'").get() as { value: string }).value,
    "must-stay",
  );

  const guards = db.prepare(`
    SELECT COUNT(*) AS count
    FROM sqlite_master
    WHERE type = 'trigger' AND name IN ('ai_manual_config_guard_insert', 'ai_manual_config_guard_update')
  `).get() as { count: number };
  assert.equal(guards.count, 0);

  db.prepare("DELETE FROM users WHERE id = 'admin-a'").run();
  const deletedAdminRows = db.prepare("SELECT COUNT(*) AS count FROM user_ai_settings WHERE userId = 'admin-a'").get() as { count: number };
  assert.equal(deletedAdminRows.count, 0);
  db.close();
});
