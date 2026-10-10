import type { Migration } from "./migrations.impl.js";

const format = (column: string) => `(json_extract(${column}, '$.originalFormat') IS 'markdown' OR json_extract(${column}, '$.originalFormat') IS 'tiptap-json')`;
const sealed = (column: string, key: string, fixed?: number) => `(json_type(${column}, '$.${key}') IS 'object'
  AND (SELECT count(*) FROM json_each(${column}, '$.${key}')) = 2
  AND json_type(${column}, '$.${key}.iv') IS 'text' AND length(json_extract(${column}, '$.${key}.iv')) = 16
  AND json_type(${column}, '$.${key}.ciphertext') IS 'text'
  AND length(json_extract(${column}, '$.${key}.ciphertext')) ${fixed ? `= ${fixed}` : 'BETWEEN 24 AND 5592428'})`;
function validEnvelope(column: string, version: 1 | 2): string {
  return `(CASE WHEN json_valid(${column}) THEN
    json_type(${column}) IS 'object' AND (SELECT count(*) FROM json_each(${column})) = ${version === 1 ? 8 : 12}
    AND length(${column}) <= 5594476
    AND json_extract(${column}, '$.version') IS ${version} AND json_extract(${column}, '$.algorithm') IS 'AES-256-GCM'
    AND json_extract(${column}, '$.kind') IS 'note' AND ${format(column)}
    AND json_type(${column}, '$.objectId') IS 'text' AND length(json_extract(${column}, '$.objectId')) = 36
    AND json_type(${column}, '$.kdf') IS 'object' AND (SELECT count(*) FROM json_each(${column}, '$.kdf')) = 6
    AND json_extract(${column}, '$.kdf.algorithm') IS 'argon2id' AND json_extract(${column}, '$.kdf.version') IS 19
    AND json_extract(${column}, '$.kdf.memoryKiB') IS 65536 AND json_extract(${column}, '$.kdf.iterations') IS 3
    AND json_extract(${column}, '$.kdf.parallelism') IS 4 AND json_type(${column}, '$.kdf.salt') IS 'text'
    AND length(json_extract(${column}, '$.kdf.salt')) = 24 AND ${sealed(column, 'wrappedKey', 64)} AND ${sealed(column, 'payload')}
    AND json_extract(${column}, '$.wrappedKey.iv') IS NOT json_extract(${column}, '$.payload.iv')
    ${version === 2 ? `AND json_type(${column}, '$.parentObjectId') IS 'null' AND json_extract(${column}, '$.documentSchemaVersion') IS 1
    AND json_type(${column}, '$.keyEpoch') IS 'integer' AND json_extract(${column}, '$.keyEpoch') BETWEEN 1 AND 9007199254740991
    AND json_type(${column}, '$.encryptionEpoch') IS 'integer' AND json_extract(${column}, '$.encryptionEpoch') BETWEEN 1 AND 9007199254740991` : ''}
    ELSE 0 END)`;
}
const validNote = `COALESCE(NEW.contentText,'') = '' AND ((NEW.contentFormat IS 'encrypted-note-v1' AND ${validEnvelope('NEW.content', 1)})
  OR (NEW.contentFormat IS 'encrypted-note-v2' AND ${validEnvelope('NEW.content', 2)}))`;
const sameRoot = `json_extract(NEW.content, '$.objectId') IS json_extract(OLD.content, '$.objectId')
  AND json_extract(NEW.content, '$.originalFormat') IS json_extract(OLD.content, '$.originalFormat')
  AND json_extract(NEW.content, '$.keyEpoch') IS json_extract(OLD.content, '$.keyEpoch')
  AND json_extract(NEW.content, '$.encryptionEpoch') IS json_extract(OLD.content, '$.encryptionEpoch')`;

/** v2 storage is prepared privately. Public creation/migration stays capability gated. */
export const encryptedContentV2Migration: Migration = {
  version: 123, name: "encrypted-content-v2-storage",
  up(db) {
    db.exec(`
      DROP TRIGGER encrypted_notes_insert; DROP TRIGGER encrypted_notes_update; DROP TRIGGER encrypted_notes_conversion_validate;
      CREATE TRIGGER encrypted_notes_insert BEFORE INSERT ON notes WHEN NEW.contentFormat LIKE 'encrypted-%' AND NOT (${validNote})
        BEGIN SELECT RAISE(ABORT,'INVALID_ENCRYPTED_NOTE'); END;
      CREATE TRIGGER encrypted_notes_conversion_validate BEFORE UPDATE ON notes WHEN NEW.contentFormat LIKE 'encrypted-%' AND NOT (${validNote})
        BEGIN SELECT RAISE(ABORT,'INVALID_ENCRYPTED_NOTE'); END;
      CREATE TRIGGER encrypted_notes_update BEFORE UPDATE ON notes WHEN
        (OLD.contentFormat LIKE 'encrypted-%' AND (NEW.contentFormat IS NOT OLD.contentFormat OR NOT (${validNote}) OR NOT (${sameRoot})))
        OR (OLD.contentFormat NOT LIKE 'encrypted-%' AND NEW.contentFormat LIKE 'encrypted-%' AND NOT EXISTS (
          SELECT 1 FROM encrypted_note_conversion_permits p WHERE p.noteId = OLD.id AND p.sourceVersion IS OLD.version
          AND p.sourceFormat IS OLD.contentFormat AND p.content IS NEW.content AND NEW.contentFormat IN ('encrypted-note-v1','encrypted-note-v2')
          AND NEW.contentText IS '' AND NEW.version IS OLD.version + 1 AND NEW.id IS OLD.id AND NEW.userId IS OLD.userId
          AND NEW.workspaceId IS OLD.workspaceId AND OLD.workspaceId IS NULL AND OLD.isLocked = 0 AND OLD.isTrashed = 0
          AND CASE WHEN json_valid(NEW.content) THEN json_extract(NEW.content, '$.originalFormat') IS OLD.contentFormat
          AND json_extract(NEW.content, '$.kind') IS 'note' ELSE 0 END))
        BEGIN SELECT RAISE(ABORT,'INVALID_ENCRYPTED_NOTE'); END;
    `);
    const noteRoot = `(SELECT content FROM notes WHERE id = NEW.noteId)`;
    const sameHistoryRoot = `json_extract(NEW.content,'$.objectId') IS json_extract(${noteRoot},'$.objectId')
      AND json_extract(NEW.content,'$.keyEpoch') IS json_extract(${noteRoot},'$.keyEpoch')
      AND json_extract(NEW.content,'$.encryptionEpoch') IS json_extract(${noteRoot},'$.encryptionEpoch')`;
    const history = `CASE WHEN json_valid(NEW.content) THEN json_type(NEW.content) IS 'object'
      AND length(NEW.content) <= 5594476 AND (SELECT count(*) FROM json_each(NEW.content)) = 8
      AND json_extract(NEW.content,'$.version') IS 1 AND json_extract(NEW.content,'$.historyId') IS NEW.id
      AND json_extract(NEW.content,'$.sourceVersion') IS NEW.version AND ${format('NEW.content')} AND ${sealed('NEW.content', 'payload')}
      AND ${sameHistoryRoot} ELSE 0 END`;
    for (const operation of ["INSERT", "UPDATE"]) db.exec(`
      DROP TRIGGER encrypted_note_versions_${operation.toLowerCase()};
      CREATE TRIGGER encrypted_note_versions_${operation.toLowerCase()} BEFORE ${operation} ON note_versions
      WHEN EXISTS(SELECT 1 FROM notes WHERE id = NEW.noteId AND contentFormat LIKE 'encrypted-%') AND NOT (
        COALESCE(NEW.contentText,'') = '' AND (
          (NEW.contentFormat IS 'encrypted-note-v1' AND ${validEnvelope('NEW.content', 1)})
          OR (NEW.contentFormat IS 'encrypted-note-v2' AND ${validEnvelope('NEW.content', 2)} AND ${sameHistoryRoot})
          OR (NEW.contentFormat IS 'encrypted-history-v2' AND ${history})))
      BEGIN SELECT RAISE(ABORT,'INVALID_ENCRYPTED_NOTE_HISTORY'); END;
    `);
  },
};
