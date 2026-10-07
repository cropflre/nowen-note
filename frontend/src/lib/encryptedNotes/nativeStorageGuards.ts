// Structural guards only; GCM authentication is performed by the unlocked client.
const invalidEnvelope = `CASE WHEN json_valid(NEW.content)=0 THEN 1 ELSE
  NEW.contentFormat <> 'encrypted-note-v1' OR COALESCE(NEW.contentText,'') <> ''
  OR length(NEW.content)>5594476
  OR json_extract(NEW.content,'$.version') IS NOT 1
  OR json_extract(NEW.content,'$.algorithm') IS NOT 'AES-256-GCM'
  OR json_extract(NEW.content,'$.kind') IS NOT 'note'
  OR json_type(NEW.content,'$.objectId') IS NOT 'text'
  OR json_extract(NEW.content,'$.originalFormat') NOT IN ('markdown','tiptap-json')
  OR json_extract(NEW.content,'$.originalFormat') IS NULL
  OR json_type(NEW.content,'$.payload.ciphertext') IS NOT 'text'
  OR json_type(NEW.content,'$.wrappedKey.ciphertext') IS NOT 'text'
  OR json_extract(NEW.content,'$.kdf.algorithm') IS NOT 'argon2id'
  OR json_extract(NEW.content,'$.kdf.version') IS NOT 19
  OR json_extract(NEW.content,'$.kdf.memoryKiB') IS NOT 65536
  OR json_extract(NEW.content,'$.kdf.iterations') IS NOT 3
  OR json_extract(NEW.content,'$.kdf.parallelism') IS NOT 4 END`;

export const NATIVE_ENCRYPTED_NOTE_GUARDS = [
  `CREATE TRIGGER IF NOT EXISTS native_encrypted_notes_insert BEFORE INSERT ON notes
    WHEN NEW.contentFormat LIKE 'encrypted-%' AND (${invalidEnvelope})
    BEGIN SELECT RAISE(ABORT,'INVALID_ENCRYPTED_NOTE'); END`,
  `CREATE TRIGGER IF NOT EXISTS native_encrypted_notes_update BEFORE UPDATE ON notes
    WHEN (OLD.contentFormat LIKE 'encrypted-%' AND (
      NEW.contentFormat IS NOT OLD.contentFormat OR (${invalidEnvelope})
      OR json_extract(NEW.content,'$.objectId') IS NOT json_extract(OLD.content,'$.objectId')
      OR json_extract(NEW.content,'$.originalFormat') IS NOT json_extract(OLD.content,'$.originalFormat')
    )) OR (OLD.contentFormat NOT LIKE 'encrypted-%' AND NEW.contentFormat LIKE 'encrypted-%')
    BEGIN SELECT RAISE(ABORT,'INVALID_ENCRYPTED_NOTE'); END`,
] as const;
