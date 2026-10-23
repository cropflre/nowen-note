import type { Migration } from "./migrations.impl.js";

// Personal AppSpec data is server-side, user-owned and intentionally separate
// from executable plugins and Sync V2 business entities.
export const nowenStudioMigration: Migration = {
  version: 133,
  name: "personal-studio-apps",
  up(db) {
    db.exec("CREATE TABLE IF NOT EXISTS personal_studio_apps (" +
      "id TEXT PRIMARY KEY, userId TEXT NOT NULL, specJson TEXT NOT NULL, " +
      "revision INTEGER NOT NULL DEFAULT 1, " +
      "createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, " +
      "FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE" +
      ");" +
      "CREATE INDEX IF NOT EXISTS idx_personal_studio_owner ON personal_studio_apps(userId, updatedAt DESC);");
  },
};
