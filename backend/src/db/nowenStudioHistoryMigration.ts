import type { Migration } from "./migrations.impl.js";

// SQLite-backed history is appended only on committed saves, never AI previews.
export const nowenStudioHistoryMigration: Migration = {
  version: 134,
  name: "personal-studio-app-history",
  up(db) {
    db.exec([
      "CREATE TABLE IF NOT EXISTS personal_studio_app_versions (",
      "appId TEXT NOT NULL, userId TEXT NOT NULL, revision INTEGER NOT NULL,",
      "specJson TEXT NOT NULL, createdAt TEXT NOT NULL,",
      "PRIMARY KEY (appId, revision),",
      "FOREIGN KEY (appId) REFERENCES personal_studio_apps(id) ON DELETE CASCADE);",
      "CREATE INDEX IF NOT EXISTS idx_personal_studio_history_owner ",
      "ON personal_studio_app_versions(userId, appId, revision DESC);",
      "INSERT OR IGNORE INTO personal_studio_app_versions(appId,userId,revision,specJson,createdAt) ",
      "SELECT id,userId,revision,specJson,updatedAt FROM personal_studio_apps;",
      "CREATE TRIGGER IF NOT EXISTS personal_studio_version_after_insert ",
      "AFTER INSERT ON personal_studio_apps BEGIN ",
      "INSERT INTO personal_studio_app_versions(appId,userId,revision,specJson,createdAt) ",
      "VALUES (NEW.id,NEW.userId,NEW.revision,NEW.specJson,NEW.updatedAt); END;",
      "CREATE TRIGGER IF NOT EXISTS personal_studio_version_after_update ",
      "AFTER UPDATE OF specJson ON personal_studio_apps WHEN NEW.revision > OLD.revision BEGIN ",
      "INSERT INTO personal_studio_app_versions(appId,userId,revision,specJson,createdAt) ",
      "VALUES (NEW.id,NEW.userId,NEW.revision,NEW.specJson,NEW.updatedAt);",
      "DELETE FROM personal_studio_app_versions WHERE appId=NEW.id AND revision < NEW.revision - 24; END;",
    ].join("\n"));
  },
};
