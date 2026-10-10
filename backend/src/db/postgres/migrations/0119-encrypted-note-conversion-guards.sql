-- Private storage permit parity only; no PostgreSQL conversion product/API runtime.
CREATE TABLE encrypted_note_conversion_permits (
  "noteId" TEXT PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
  "sourceVersion" INTEGER NOT NULL,
  "sourceFormat" TEXT NOT NULL CHECK ("sourceFormat" IN ('markdown', 'tiptap-json')),
  content TEXT NOT NULL,
  "transactionId" BIGINT NOT NULL DEFAULT txid_current()
);
CREATE OR REPLACE FUNCTION nowen_guard_encrypted_note() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."contentFormat" LIKE 'encrypted-%' AND NOT nowen_encrypted_note_valid(NEW.content, NEW."contentText", NEW."contentFormat") THEN
    RAISE EXCEPTION 'INVALID_ENCRYPTED_NOTE';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD."contentFormat" LIKE 'encrypted-%' THEN
      IF NEW."contentFormat" IS DISTINCT FROM OLD."contentFormat"
        OR (NEW.content::jsonb)->>'objectId' IS DISTINCT FROM (OLD.content::jsonb)->>'objectId'
        OR (NEW.content::jsonb)->>'originalFormat' IS DISTINCT FROM (OLD.content::jsonb)->>'originalFormat' THEN
        RAISE EXCEPTION 'INVALID_ENCRYPTED_NOTE';
      END IF;
    ELSIF NEW."contentFormat" LIKE 'encrypted-%' THEN
      IF NOT EXISTS (SELECT 1 FROM encrypted_note_conversion_permits p
        WHERE p."noteId" = OLD.id AND p."sourceVersion" = OLD.version
          AND p."sourceFormat" = OLD."contentFormat" AND p.content = NEW.content
          AND p."transactionId" = txid_current() AND NEW.version = OLD.version + 1
          AND NEW.id IS NOT DISTINCT FROM OLD.id AND NEW."userId" IS NOT DISTINCT FROM OLD."userId"
          AND NEW."workspaceId" IS NOT DISTINCT FROM OLD."workspaceId" AND OLD."workspaceId" IS NULL
          AND NOT OLD."isLocked" AND NOT OLD."isTrashed"
          AND NEW."contentText" = '' AND NEW."contentFormat" = 'encrypted-note-v1'
          AND (NEW.content::jsonb)->>'originalFormat' = OLD."contentFormat") THEN
        RAISE EXCEPTION 'INVALID_ENCRYPTED_NOTE';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;

DO $$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['note_block_operations', 'block_operations', 'note_block_attachment_refs', 'yjs_operation_receipts', 'embedding_queue', 'note_import_origins'] LOOP
    IF to_regclass(table_name) IS NOT NULL THEN
      EXECUTE format('CREATE TRIGGER encrypted_conversion_derived_write BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION nowen_guard_encrypted_derived_content()', table_name);
    END IF;
  END LOOP;
END $$;
