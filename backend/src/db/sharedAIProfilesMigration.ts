import type { Migration } from "./migrations.impl.js";

export const sharedAIProfilesMigration: Migration = {
  version: 140,
  name: "shared-ai-profiles",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS shared_ai_profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        provider TEXT NOT NULL,
        apiUrl TEXT NOT NULL,
        apiKey TEXT NOT NULL DEFAULT '',
        customHeadersJson TEXT NOT NULL DEFAULT '{}',
        model TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        revision INTEGER NOT NULL DEFAULT 1,
        createdBy TEXT REFERENCES users(id) ON DELETE SET NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS shared_ai_profile_grants (
        profileId TEXT NOT NULL REFERENCES shared_ai_profiles(id) ON DELETE CASCADE,
        userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        PRIMARY KEY (profileId, userId)
      );
      CREATE INDEX IF NOT EXISTS idx_shared_ai_profile_grants_user
        ON shared_ai_profile_grants(userId);
    `);
  },
};
