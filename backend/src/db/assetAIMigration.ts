import type { Migration } from "./migrations.impl.js";

export const assetAIMigration: Migration = {
  version: 130,
  name: "asset-ai-descriptions-and-confirmations",
  up(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS asset_descriptions (
      "attachmentId" TEXT PRIMARY KEY REFERENCES attachments(id) ON DELETE CASCADE,
      description TEXT NOT NULL DEFAULT '', "updatedAt" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS asset_ai_batches (
      "userId" TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      "scopeKey" TEXT NOT NULL, "requestId" TEXT NOT NULL, "payloadHash" TEXT NOT NULL,
      "resultJson" TEXT NOT NULL, "createdAt" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY("userId","scopeKey","requestId")
    );
    CREATE TRIGGER IF NOT EXISTS asset_description_scope_transfer
      AFTER UPDATE OF userId,workspaceId ON attachments
      WHEN OLD.userId IS NOT NEW.userId OR OLD.workspaceId IS NOT NEW.workspaceId
      BEGIN DELETE FROM asset_descriptions WHERE attachmentId=NEW.id; END;`);
  },
};
