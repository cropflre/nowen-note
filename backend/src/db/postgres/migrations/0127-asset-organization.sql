-- Storage parity; PostgreSQL product runtime remains under validation.

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
CREATE OR REPLACE FUNCTION nowen_asset_tag_scope() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM attachments a JOIN asset_tags t ON t.id = NEW."tagId"
    WHERE a.id = NEW."attachmentId" AND (
      (a."workspaceId" IS NULL AND t."workspaceId" IS NULL AND a."userId" = t."userId")
      OR (a."workspaceId" IS NOT NULL AND a."workspaceId" = t."workspaceId")
    )
  ) THEN RAISE EXCEPTION 'ASSET_TAG_SCOPE_MISMATCH'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS asset_tag_scope_guard ON asset_tag_relations;
CREATE TRIGGER asset_tag_scope_guard BEFORE INSERT OR UPDATE ON asset_tag_relations FOR EACH ROW EXECUTE FUNCTION nowen_asset_tag_scope();
CREATE OR REPLACE FUNCTION nowen_asset_tag_transfer() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM asset_tag_relations r WHERE r."attachmentId" = NEW.id AND NOT EXISTS (
    SELECT 1 FROM asset_tags t WHERE t.id = r."tagId" AND (
      (NEW."workspaceId" IS NULL AND t."workspaceId" IS NULL AND NEW."userId" = t."userId")
      OR (NEW."workspaceId" IS NOT NULL AND NEW."workspaceId" = t."workspaceId")
    )
  );
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS asset_tag_scope_transfer ON attachments;
CREATE TRIGGER asset_tag_scope_transfer AFTER UPDATE OF "workspaceId", "userId" ON attachments FOR EACH ROW EXECUTE FUNCTION nowen_asset_tag_transfer();
