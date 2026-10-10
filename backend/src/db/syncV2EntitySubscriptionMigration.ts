import type { Migration } from "./migrations.impl.js";

/** Bind an explicit entity subscription to a device only after a complete snapshot. */
export const syncV2EntitySubscriptionMigration: Migration = {
  version: 106,
  name: "sync-v2-entity-subscription",
  up: (db) => {
    db.exec(`
      ALTER TABLE sync_v2_clients ADD COLUMN entitySet TEXT;

      CREATE TABLE sync_v2_snapshot_sessions (
        deviceId TEXT NOT NULL,
        userId TEXT NOT NULL,
        scopeKey TEXT NOT NULL,
        entitySet TEXT NOT NULL,
        accessFingerprint TEXT NOT NULL,
        snapshotSequence INTEGER NOT NULL,
        nextCursor TEXT,
        completed INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (deviceId, userId, scopeKey)
      );
    `);
  },
};
