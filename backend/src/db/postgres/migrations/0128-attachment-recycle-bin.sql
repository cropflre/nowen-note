ALTER TABLE attachments ADD COLUMN IF NOT EXISTS "trashedAt" TEXT;
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS "trashedBy" TEXT;
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS "originalFolderId" TEXT;
CREATE INDEX IF NOT EXISTS idx_attachments_trash ON attachments("userId","workspaceId","trashedAt");
CREATE OR REPLACE FUNCTION retain_trashed_attachment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."trashedAt" IS NOT NULL THEN RAISE EXCEPTION 'ATTACHMENT_TRASH_RETAINED'; END IF;
  RETURN OLD;
END;
$$;
DROP TRIGGER IF EXISTS attachments_trash_retention ON attachments;
CREATE TRIGGER attachments_trash_retention BEFORE DELETE ON attachments FOR EACH ROW EXECUTE FUNCTION retain_trashed_attachment();
