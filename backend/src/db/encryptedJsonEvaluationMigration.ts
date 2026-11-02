import type { Migration } from "./migrations.impl.js";

// AND/OR do not protect JSON reads from evaluation on malformed input. Keep the
// installed conversion/decryption permits and validate each JSON input with CASE.
export const encryptedJsonEvaluationMigration: Migration = {
  version: 139,
  name: "encrypted-json-evaluation-guards",
  up(db) {
    for (const name of ["encrypted_notes_update", "encrypted_note_versions_insert", "encrypted_note_versions_update"]) {
      const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(name) as { sql: string } | undefined;
      if (!row?.sql) throw new Error(`ENCRYPTED_JSON_GUARD_MIGRATION_MISMATCH: ${name}`);
      const sql = row.sql.replace(
        /json_extract\((NEW\.content|OLD\.content|\(SELECT content FROM notes WHERE id = NEW\.noteId\))\s*,/gi,
        (_match, content: string) => `json_extract(CASE WHEN json_valid(${content}) THEN ${content} ELSE '{}' END,`,
      );
      if (sql !== row.sql) db.exec(`DROP TRIGGER ${name}; ${sql};`);
    }
  },
};
