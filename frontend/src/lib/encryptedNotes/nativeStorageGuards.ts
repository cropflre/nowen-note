// Persisted structural checks: no JS SQLite callbacks or plaintext interpretation.
const sealed = (key: string, fixed?: number) => `(json_type(NEW.content,'$.${key}') IS 'object'
  AND (SELECT count(*) FROM json_each(NEW.content,'$.${key}')) = 2
  AND json_type(NEW.content,'$.${key}.iv') IS 'text' AND length(json_extract(NEW.content,'$.${key}.iv')) = 16
  AND json_extract(NEW.content,'$.${key}.iv') NOT GLOB '*[^A-Za-z0-9+/]*'
  AND json_type(NEW.content,'$.${key}.ciphertext') IS 'text'
  AND length(json_extract(NEW.content,'$.${key}.ciphertext')) ${fixed ? `= ${fixed}` : 'BETWEEN 24 AND 5592428'}
  AND length(json_extract(NEW.content,'$.${key}.ciphertext')) % 4 = 0
  AND json_extract(NEW.content,'$.${key}.ciphertext') NOT GLOB '*[^A-Za-z0-9+/=]*')`;
const validEnvelope = `CASE WHEN json_valid(NEW.content) THEN
  json_type(NEW.content) IS 'object' AND length(NEW.content) <= 5594476
  AND COALESCE(NEW.contentText,'') = '' AND json_extract(NEW.content,'$.algorithm') IS 'AES-256-GCM'
  AND json_extract(NEW.content,'$.kind') IS 'note'
  AND (json_extract(NEW.content,'$.originalFormat') IS 'markdown' OR json_extract(NEW.content,'$.originalFormat') IS 'tiptap-json')
  AND json_type(NEW.content,'$.objectId') IS 'text' AND length(json_extract(NEW.content,'$.objectId')) = 36
  AND substr(json_extract(NEW.content,'$.objectId'),9,1) IS '-' AND substr(json_extract(NEW.content,'$.objectId'),14,1) IS '-'
  AND substr(json_extract(NEW.content,'$.objectId'),19,1) IS '-' AND substr(json_extract(NEW.content,'$.objectId'),24,1) IS '-'
  AND substr(json_extract(NEW.content,'$.objectId'),15,1) IS '4' AND substr(json_extract(NEW.content,'$.objectId'),20,1) GLOB '[89ab]'
  AND length(replace(json_extract(NEW.content,'$.objectId'),'-','')) = 32
  AND replace(json_extract(NEW.content,'$.objectId'),'-','') NOT GLOB '*[^0-9a-f]*'
  AND json_type(NEW.content,'$.kdf') IS 'object' AND (SELECT count(*) FROM json_each(NEW.content,'$.kdf')) = 6
  AND json_extract(NEW.content,'$.kdf.algorithm') IS 'argon2id' AND json_extract(NEW.content,'$.kdf.version') IS 19
  AND json_extract(NEW.content,'$.kdf.memoryKiB') IS 65536 AND json_extract(NEW.content,'$.kdf.iterations') IS 3
  AND json_extract(NEW.content,'$.kdf.parallelism') IS 4 AND json_type(NEW.content,'$.kdf.salt') IS 'text'
  AND length(json_extract(NEW.content,'$.kdf.salt')) = 24 AND ${sealed('wrappedKey', 64)} AND ${sealed('payload')}
  AND json_extract(NEW.content,'$.wrappedKey.iv') IS NOT json_extract(NEW.content,'$.payload.iv')
  AND ((NEW.contentFormat IS 'encrypted-note-v1' AND json_extract(NEW.content,'$.version') IS 1
    AND (SELECT count(*) FROM json_each(NEW.content)) = 8)
    OR (NEW.contentFormat IS 'encrypted-note-v2' AND json_extract(NEW.content,'$.version') IS 2
    AND (SELECT count(*) FROM json_each(NEW.content)) = 12
    AND json_type(NEW.content,'$.parentObjectId') IS 'null' AND json_extract(NEW.content,'$.documentSchemaVersion') IS 1
    AND json_type(NEW.content,'$.keyEpoch') IS 'integer' AND json_extract(NEW.content,'$.keyEpoch') BETWEEN 1 AND 9007199254740991
    AND json_type(NEW.content,'$.encryptionEpoch') IS 'integer' AND json_extract(NEW.content,'$.encryptionEpoch') BETWEEN 1 AND 9007199254740991))
  ELSE 0 END`;

export const NATIVE_ENCRYPTED_NOTE_GUARDS = [
  "DROP TRIGGER IF EXISTS native_encrypted_notes_insert",
  "DROP TRIGGER IF EXISTS native_encrypted_notes_update",
  `CREATE TRIGGER native_encrypted_notes_insert BEFORE INSERT ON notes
    WHEN NEW.contentFormat LIKE 'encrypted-%' AND NOT (${validEnvelope})
    BEGIN SELECT RAISE(ABORT,'INVALID_ENCRYPTED_NOTE'); END`,
  `CREATE TRIGGER native_encrypted_notes_update BEFORE UPDATE ON notes
    WHEN (OLD.contentFormat LIKE 'encrypted-%' AND (
      NEW.contentFormat IS NOT OLD.contentFormat OR NOT (${validEnvelope})
      OR json_extract(NEW.content,'$.objectId') IS NOT json_extract(OLD.content,'$.objectId')
      OR json_extract(NEW.content,'$.originalFormat') IS NOT json_extract(OLD.content,'$.originalFormat')
      OR json_extract(NEW.content,'$.keyEpoch') IS NOT json_extract(OLD.content,'$.keyEpoch')
      OR json_extract(NEW.content,'$.encryptionEpoch') IS NOT json_extract(OLD.content,'$.encryptionEpoch')
    )) OR (OLD.contentFormat NOT LIKE 'encrypted-%' AND NEW.contentFormat LIKE 'encrypted-%')
    BEGIN SELECT RAISE(ABORT,'INVALID_ENCRYPTED_NOTE'); END`,
] as const;
