-- Storage parity only. This does not enable the PostgreSQL product runtime.
ALTER FUNCTION nowen_encrypted_note_valid(TEXT,TEXT,TEXT) RENAME TO nowen_encrypted_note_v1_valid;
CREATE FUNCTION nowen_encrypted_bytes_valid(body TEXT, minimum INTEGER, maximum INTEGER) RETURNS BOOLEAN LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE bytes BYTEA;
BEGIN
  IF body IS NULL OR length(body) > ((maximum + 2) / 3) * 4 OR body !~ '^[A-Za-z0-9+/]*={0,2}$' THEN RETURN FALSE; END IF;
  bytes := decode(body, 'base64');
  RETURN octet_length(bytes) BETWEEN minimum AND maximum AND replace(encode(bytes,'base64'),chr(10),'') = body;
EXCEPTION WHEN OTHERS THEN RETURN FALSE;
END $$;
CREATE FUNCTION nowen_encrypted_sealed_valid(body JSONB, minimum INTEGER, maximum INTEGER) RETURNS BOOLEAN LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  RETURN COALESCE(jsonb_typeof(body) = 'object' AND (SELECT count(*) FROM jsonb_object_keys(body)) = 2
    AND nowen_encrypted_bytes_valid(body->>'iv',12,12) AND nowen_encrypted_bytes_valid(body->>'ciphertext',minimum,maximum),FALSE);
EXCEPTION WHEN OTHERS THEN RETURN FALSE;
END $$;
CREATE FUNCTION nowen_encrypted_epoch_valid(body JSONB) RETURNS BOOLEAN LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  RETURN COALESCE(jsonb_typeof(body) = 'number' AND body::text ~ '^[1-9][0-9]{0,15}$' AND body::text::numeric <= 9007199254740991,FALSE);
EXCEPTION WHEN OTHERS THEN RETURN FALSE;
END $$;
CREATE FUNCTION nowen_encrypted_note_valid(body TEXT, preview TEXT, format TEXT) RETURNS BOOLEAN LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE e JSONB;
BEGIN
  IF format = 'encrypted-note-v1' THEN RETURN nowen_encrypted_note_v1_valid(body,preview,format); END IF;
  IF format IS DISTINCT FROM 'encrypted-note-v2' OR COALESCE(preview,'') <> '' OR body IS NULL OR length(body) > 5594476 THEN RETURN FALSE; END IF;
  e := body::jsonb;
  RETURN COALESCE(jsonb_typeof(e) = 'object' AND (SELECT count(*) FROM jsonb_object_keys(e)) = 12
    AND e->'version' = '2'::jsonb AND e->>'algorithm' = 'AES-256-GCM' AND e->>'kind' = 'note'
    AND e->>'objectId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND e->>'originalFormat' IN ('markdown','tiptap-json') AND e->'parentObjectId' = 'null'::jsonb
    AND e->'documentSchemaVersion' = '1'::jsonb AND nowen_encrypted_epoch_valid(e->'keyEpoch') AND nowen_encrypted_epoch_valid(e->'encryptionEpoch')
    AND jsonb_typeof(e->'kdf') = 'object' AND (SELECT count(*) FROM jsonb_object_keys(e->'kdf')) = 6
    AND e->'kdf'->>'algorithm' = 'argon2id' AND e->'kdf'->'version' = '19'::jsonb AND e->'kdf'->'memoryKiB' = '65536'::jsonb
    AND e->'kdf'->'iterations' = '3'::jsonb AND e->'kdf'->'parallelism' = '4'::jsonb AND nowen_encrypted_bytes_valid(e->'kdf'->>'salt',16,16)
    AND nowen_encrypted_sealed_valid(e->'wrappedKey',48,48) AND nowen_encrypted_sealed_valid(e->'payload',16,4194320)
    AND e->'wrappedKey'->>'iv' IS DISTINCT FROM e->'payload'->>'iv',FALSE);
EXCEPTION WHEN OTHERS THEN RETURN FALSE;
END $$;
CREATE OR REPLACE FUNCTION nowen_guard_encrypted_note() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."contentFormat" LIKE 'encrypted-%' AND NOT nowen_encrypted_note_valid(NEW.content,NEW."contentText",NEW."contentFormat") THEN RAISE EXCEPTION 'INVALID_ENCRYPTED_NOTE'; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD."contentFormat" LIKE 'encrypted-%' THEN
      IF NEW."contentFormat" IS DISTINCT FROM OLD."contentFormat"
        OR (NEW.content::jsonb)->>'objectId' IS DISTINCT FROM (OLD.content::jsonb)->>'objectId'
        OR (NEW.content::jsonb)->>'originalFormat' IS DISTINCT FROM (OLD.content::jsonb)->>'originalFormat'
        OR (NEW.content::jsonb)->'keyEpoch' IS DISTINCT FROM (OLD.content::jsonb)->'keyEpoch'
        OR (NEW.content::jsonb)->'encryptionEpoch' IS DISTINCT FROM (OLD.content::jsonb)->'encryptionEpoch' THEN RAISE EXCEPTION 'INVALID_ENCRYPTED_NOTE'; END IF;
    ELSIF NEW."contentFormat" LIKE 'encrypted-%' THEN
      IF NOT EXISTS (SELECT 1 FROM encrypted_note_conversion_permits p WHERE p."noteId" = OLD.id AND p."sourceVersion" = OLD.version
        AND p."sourceFormat" = OLD."contentFormat" AND p.content = NEW.content AND p."transactionId" = txid_current()
        AND NEW.version = OLD.version + 1 AND NEW.id IS NOT DISTINCT FROM OLD.id AND NEW."userId" IS NOT DISTINCT FROM OLD."userId"
        AND NEW."workspaceId" IS NOT DISTINCT FROM OLD."workspaceId" AND OLD."workspaceId" IS NULL AND NOT OLD."isLocked" AND NOT OLD."isTrashed"
        AND NEW."contentText" = '' AND NEW."contentFormat" IN ('encrypted-note-v1','encrypted-note-v2')
        AND (NEW.content::jsonb)->>'originalFormat' = OLD."contentFormat") THEN RAISE EXCEPTION 'INVALID_ENCRYPTED_NOTE'; END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION nowen_guard_encrypted_note_history() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE root JSONB; e JSONB; valid BOOLEAN;
BEGIN
  SELECT content::jsonb INTO root FROM notes WHERE id = NEW."noteId" AND "contentFormat" LIKE 'encrypted-%';
  IF root IS NULL THEN RETURN NEW; END IF;
  valid := nowen_encrypted_note_valid(NEW.content,NEW."contentText",NEW."contentFormat");
  IF NEW."contentFormat" = 'encrypted-note-v2' THEN
    e := NEW.content::jsonb;
    valid := valid AND e->>'objectId' = root->>'objectId' AND e->'keyEpoch' = root->'keyEpoch' AND e->'encryptionEpoch' = root->'encryptionEpoch';
  ELSIF NEW."contentFormat" = 'encrypted-history-v2' THEN
    e := NEW.content::jsonb;
    valid := COALESCE(COALESCE(NEW."contentText",'') = '' AND length(NEW.content) <= 5594476
      AND jsonb_typeof(e) = 'object' AND (SELECT count(*) FROM jsonb_object_keys(e)) = 8 AND e->'version' = '1'::jsonb
      AND e->>'historyId' = NEW.id AND e->'sourceVersion' = to_jsonb(NEW.version) AND e->>'originalFormat' IN ('markdown','tiptap-json')
      AND e->>'objectId' = root->>'objectId' AND e->'keyEpoch' = root->'keyEpoch' AND e->'encryptionEpoch' = root->'encryptionEpoch'
      AND nowen_encrypted_sealed_valid(e->'payload',16,4194320),FALSE);
  END IF;
  IF NOT COALESCE(valid,FALSE) THEN RAISE EXCEPTION 'INVALID_ENCRYPTED_NOTE_HISTORY'; END IF;
  RETURN NEW;
EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'INVALID_ENCRYPTED_NOTE_HISTORY';
END $$;
