import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { syncV2EntitySubscriptionMigration } from "../src/db/syncV2EntitySubscriptionMigration.js";

test("v106 保留旧设备 ACK，并将其视为未绑定显式实体集合", () => {
  const db = new Database(":memory:");
  try {
    db.exec(`
      CREATE TABLE sync_v2_clients (
        deviceId TEXT NOT NULL, userId TEXT NOT NULL, scopeKey TEXT NOT NULL,
        lastSequence INTEGER NOT NULL, lastSeenAt TEXT NOT NULL,
        PRIMARY KEY (deviceId, userId, scopeKey)
      );
      INSERT INTO sync_v2_clients VALUES ('old-device', 'user', 'personal', 42, '2026-01-01');
    `);
    syncV2EntitySubscriptionMigration.up(db);
    const row = db.prepare(`
      SELECT lastSequence, entitySet FROM sync_v2_clients WHERE deviceId = 'old-device'
    `).get() as { lastSequence: number; entitySet: string | null };
    assert.deepEqual(row, { lastSequence: 42, entitySet: null });
    assert.ok(db.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sync_v2_snapshot_sessions'
    `).get());
  } finally {
    db.close();
  }
});
