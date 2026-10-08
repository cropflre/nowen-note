import type { Migration } from "./migrations.impl.js";

export const pluginInboundMigration: Migration = {
  version: 120,
  name: "plugin-inbound-webhooks",
  up(db) {
    db.exec(`CREATE TABLE plugin_inbound_webhooks (
      pluginId TEXT NOT NULL REFERENCES plugin_registry(id) ON DELETE CASCADE,
      hookId TEXT NOT NULL,
      ownerUserId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      tokenHash TEXT NOT NULL UNIQUE,
      tokenVersion INTEGER NOT NULL,
      workflowId TEXT REFERENCES automation_workflows(id) ON DELETE SET NULL,
      declarationJson TEXT NOT NULL,
      requestsInWindow INTEGER NOT NULL DEFAULT 0,
      windowStartedAt INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(pluginId, hookId, ownerUserId)
    );`);
  },
};
