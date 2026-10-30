import type { Migration } from "./migrations.impl.js";
import { installSyncPersonalEntitiesTriggers } from "./syncPersonalEntitiesMigration.js";

export const taskComposerMigration: Migration = {
  version: 125,
  name: "task-composer-idempotency",
  up: db => {
    db.exec(`CREATE TABLE IF NOT EXISTS task_composer_batches (
      userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      scopeKey TEXT NOT NULL,
      requestId TEXT NOT NULL,
      previewId TEXT NOT NULL,
      payloadHash TEXT NOT NULL,
      taskIdsJson TEXT NOT NULL,
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY(userId,scopeKey,requestId),
      UNIQUE(userId,scopeKey,previewId)
    );`);
    installSyncPersonalEntitiesTriggers(db);
  },
};
