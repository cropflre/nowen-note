import type { Migration } from "./migrations.impl.js";

export const ASSET_ORGANIZATION_SCHEMA = `
CREATE TABLE IF NOT EXISTS asset_tags (
  id TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  "workspaceId" TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  "normalizedName" TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#58a6ff',
  "createdAt" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_asset_tags_personal_name ON asset_tags("userId", "normalizedName") WHERE "workspaceId" IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_asset_tags_workspace_name ON asset_tags("workspaceId", "normalizedName") WHERE "workspaceId" IS NOT NULL;
CREATE TABLE IF NOT EXISTS asset_tag_relations (
  "attachmentId" TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
  "tagId" TEXT NOT NULL REFERENCES asset_tags(id) ON DELETE CASCADE,
  "createdAt" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("attachmentId", "tagId")
);
CREATE INDEX IF NOT EXISTS idx_asset_tag_relations_tag ON asset_tag_relations("tagId", "attachmentId");
CREATE TABLE IF NOT EXISTS asset_smart_folders (
  id TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  "workspaceId" TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  "normalizedName" TEXT NOT NULL,
  filters TEXT NOT NULL,
  "createdAt" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_asset_smart_personal_name ON asset_smart_folders("userId", "normalizedName") WHERE "workspaceId" IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_asset_smart_workspace_name ON asset_smart_folders("userId", "workspaceId", "normalizedName") WHERE "workspaceId" IS NOT NULL;
`;

export const assetOrganizationMigration: Migration = {
  version: 127,
  name: "asset-tags-and-smart-folders",
  up(db) {
    db.exec(ASSET_ORGANIZATION_SCHEMA);
    for (const operation of ["INSERT", "UPDATE"])
      db.exec(`
      CREATE TRIGGER IF NOT EXISTS asset_tag_scope_${operation.toLowerCase()}
      BEFORE ${operation} ON asset_tag_relations
      WHEN NOT EXISTS (
        SELECT 1 FROM attachments a JOIN asset_tags t ON t.id = NEW.tagId
        WHERE a.id = NEW.attachmentId AND (
          (a.workspaceId IS NULL AND t.workspaceId IS NULL AND a.userId = t.userId)
          OR (a.workspaceId IS NOT NULL AND a.workspaceId = t.workspaceId)
        )
      ) BEGIN SELECT RAISE(ABORT, 'ASSET_TAG_SCOPE_MISMATCH'); END;
    `);
    db.exec(`CREATE TRIGGER IF NOT EXISTS asset_tag_scope_transfer
      AFTER UPDATE OF workspaceId, userId ON attachments BEGIN
        DELETE FROM asset_tag_relations WHERE attachmentId = NEW.id AND NOT EXISTS (
          SELECT 1 FROM asset_tags t WHERE t.id = asset_tag_relations.tagId AND (
            (NEW.workspaceId IS NULL AND t.workspaceId IS NULL AND NEW.userId = t.userId)
            OR (NEW.workspaceId IS NOT NULL AND NEW.workspaceId = t.workspaceId)
          )
        );
      END;`);
  },
};
