-- PostgreSQL parity for the encrypted-note storage boundary. The default runtime
-- still uses SQLite; this migration does not enable a PostgreSQL runtime.
CREATE OR REPLACE FUNCTION nowen_encrypted_note_valid(body TEXT, preview TEXT, format TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE envelope JSONB;
BEGIN
  IF format IS DISTINCT FROM 'encrypted-note-v1' OR COALESCE(preview, '') <> ''
    OR body IS NULL OR length(body) > 5594476 THEN RETURN FALSE; END IF;
  envelope := body::jsonb;
  RETURN COALESCE(
    envelope->'version' = '1'::jsonb AND envelope->>'algorithm' = 'AES-256-GCM'
    AND envelope->>'kind' = 'note'
    AND envelope->>'originalFormat' IN ('markdown', 'tiptap-json')
    AND envelope->>'objectId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND envelope->'kdf'->>'algorithm' = 'argon2id'
    AND envelope->'kdf'->'version' = '19'::jsonb
    AND envelope->'kdf'->'memoryKiB' = '65536'::jsonb
    AND envelope->'kdf'->'iterations' = '3'::jsonb
    AND envelope->'kdf'->'parallelism' = '4'::jsonb
    AND jsonb_typeof(envelope->'wrappedKey'->'ciphertext') = 'string'
    AND jsonb_typeof(envelope->'payload'->'ciphertext') = 'string', FALSE);
EXCEPTION WHEN invalid_text_representation THEN RETURN FALSE;
END $$;

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
      RAISE EXCEPTION 'INVALID_ENCRYPTED_NOTE';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS encrypted_notes_write ON notes;
CREATE TRIGGER encrypted_notes_write BEFORE INSERT OR UPDATE ON notes FOR EACH ROW EXECUTE FUNCTION nowen_guard_encrypted_note();

CREATE OR REPLACE FUNCTION nowen_guard_encrypted_derived_content() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM notes WHERE id = NEW."noteId" AND "contentFormat" LIKE 'encrypted-%') THEN
    RAISE EXCEPTION 'ENCRYPTED_NOTE_DERIVED_CONTENT_FORBIDDEN';
  END IF;
  RETURN NEW;
END $$;
DO $$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['attachments', 'shares', 'note_blocks_index', 'note_block_documents', 'note_block_records', 'note_yupdates', 'note_ysnapshots', 'note_y_subdocuments', 'note_y_subdocument_updates', 'note_y_subdocument_manifests', 'note_embeddings'] LOOP
    IF to_regclass(table_name) IS NOT NULL THEN
      EXECUTE format('DROP TRIGGER IF EXISTS encrypted_derived_write ON %I', table_name);
      EXECUTE format('CREATE TRIGGER encrypted_derived_write BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION nowen_guard_encrypted_derived_content()', table_name);
    END IF;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION nowen_guard_encrypted_note_history() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM notes WHERE id = NEW."noteId" AND "contentFormat" LIKE 'encrypted-%')
    AND NOT nowen_encrypted_note_valid(NEW.content, NEW."contentText", NEW."contentFormat") THEN
    RAISE EXCEPTION 'INVALID_ENCRYPTED_NOTE_HISTORY';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS encrypted_note_history_write ON note_versions;
CREATE TRIGGER encrypted_note_history_write BEFORE INSERT OR UPDATE ON note_versions FOR EACH ROW EXECUTE FUNCTION nowen_guard_encrypted_note_history();
