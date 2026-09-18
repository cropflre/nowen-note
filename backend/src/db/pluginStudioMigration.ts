import type { Migration } from "./migrations.impl.js";

export const pluginStudioMigration: Migration = {
  version: 103,
  name: "plugin-studio-isolated-projects",
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS plugin_studio_projects (
        id TEXT PRIMARY KEY,
        ownerUserId TEXT NOT NULL,
        name TEXT NOT NULL,
        slug TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft'
          CHECK (status IN ('draft', 'ready', 'archived')),
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        UNIQUE(ownerUserId, slug),
        FOREIGN KEY (ownerUserId) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_plugin_studio_projects_owner_updated
        ON plugin_studio_projects(ownerUserId, updatedAt DESC);

      CREATE TABLE IF NOT EXISTS plugin_studio_generations (
        id TEXT PRIMARY KEY,
        projectId TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        catalogDigest TEXT,
        model TEXT,
        inputDigest TEXT,
        outputDigest TEXT,
        resultSummary TEXT,
        errorCode TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        FOREIGN KEY (projectId) REFERENCES plugin_studio_projects(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_plugin_studio_generations_project_created
        ON plugin_studio_generations(projectId, createdAt DESC);

      CREATE TABLE IF NOT EXISTS plugin_studio_artifacts (
        id TEXT PRIMARY KEY,
        projectId TEXT NOT NULL,
        generationId TEXT,
        kind TEXT NOT NULL,
        digest TEXT NOT NULL,
        reportJson TEXT NOT NULL DEFAULT '{}',
        expiresAt TEXT,
        createdAt TEXT NOT NULL,
        FOREIGN KEY (projectId) REFERENCES plugin_studio_projects(id) ON DELETE CASCADE,
        FOREIGN KEY (generationId) REFERENCES plugin_studio_generations(id) ON DELETE SET NULL
      );
      CREATE INDEX IF NOT EXISTS idx_plugin_studio_artifacts_project_created
        ON plugin_studio_artifacts(projectId, createdAt DESC);
    `);
  },
};
