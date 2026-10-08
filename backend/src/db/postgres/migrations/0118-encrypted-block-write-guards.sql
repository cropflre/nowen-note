-- No PostgreSQL product runtime is enabled here; current writers must grant and
-- consume an exact target in one transaction. txid prevents a leaked permit reuse.
CREATE TABLE encrypted_block_write_permits (
  "noteId" TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  "contentFormat" TEXT NOT NULL,
  "transactionId" BIGINT NOT NULL DEFAULT txid_current()
);
CREATE OR REPLACE FUNCTION nowen_guard_encrypted_block_write() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.content IS DISTINCT FROM OLD.content OR NEW."contentFormat" IS DISTINCT FROM OLD."contentFormat")
    AND (strpos(lower(OLD.content), 'nowen-encrypted') > 0 OR strpos(lower(NEW.content), 'nowen-encrypted') > 0)
    AND NOT EXISTS (SELECT 1 FROM encrypted_block_write_permits
      WHERE "noteId" = NEW.id AND content IS NOT DISTINCT FROM NEW.content
        AND "contentFormat" IS NOT DISTINCT FROM NEW."contentFormat" AND "transactionId" = txid_current()) THEN
    RAISE EXCEPTION 'ENCRYPTED_BLOCK_WRITE_FORBIDDEN';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER encrypted_blocks_update BEFORE UPDATE OF content, "contentFormat" ON notes
  FOR EACH ROW EXECUTE FUNCTION nowen_guard_encrypted_block_write();
