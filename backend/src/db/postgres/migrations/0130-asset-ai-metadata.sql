-- Storage parity only; this does not enable the PostgreSQL product runtime.
CREATE TABLE IF NOT EXISTS asset_descriptions (
  "attachmentId" TEXT PRIMARY KEY REFERENCES attachments(id) ON DELETE CASCADE,
  description TEXT NOT NULL DEFAULT '', "updatedAt" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS asset_ai_batches (
  "userId" TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  "scopeKey" TEXT NOT NULL, "requestId" TEXT NOT NULL, "payloadHash" TEXT NOT NULL,
  "resultJson" TEXT NOT NULL, "createdAt" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY("userId","scopeKey","requestId")
);
CREATE OR REPLACE FUNCTION nowen_asset_description_transfer() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."userId" IS DISTINCT FROM NEW."userId" OR OLD."workspaceId" IS DISTINCT FROM NEW."workspaceId" THEN
    DELETE FROM asset_descriptions WHERE "attachmentId"=NEW.id;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS asset_description_scope_transfer ON attachments;
CREATE TRIGGER asset_description_scope_transfer AFTER UPDATE OF "userId","workspaceId" ON attachments
  FOR EACH ROW EXECUTE FUNCTION nowen_asset_description_transfer();
