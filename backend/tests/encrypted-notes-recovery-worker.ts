import assert from "node:assert/strict";
import fs from "node:fs";
import "../src/runtime/knowledge-tree-migration-bootstrap.js";
import "../src/runtime/backup-restore-large-archive.js";
import { getDb, closeDb } from "../src/db/schema.js";
import { BackupManager } from "../src/services/backup.js";

// Run in a fresh process so module-level database/storage paths cannot refer to the source installation.
async function main() {
  const [, , filename, noteId, reportPath] = process.argv;
  try {
    assert.equal((getDb().prepare("SELECT count(*) AS count FROM notes").get() as any).count, 0);
    const restored = await new BackupManager().restoreFromBackup(filename, { dryRun: false });
    assert.equal(restored.success, true, restored.error);
    const db = getDb();
    const note = db.prepare("SELECT content, contentText, contentFormat, version FROM notes WHERE id = ?").get(noteId);
    const history = db.prepare("SELECT content, contentText, contentFormat FROM note_versions WHERE noteId = ?").all(noteId);
    assert.throws(() => db.prepare("UPDATE notes SET content = 'must-never-persist' WHERE id = ?").run(noteId), /INVALID_ENCRYPTED_NOTE/);
    assert.throws(() => db.prepare("UPDATE notes SET contentFormat = 'markdown' WHERE id = ?").run(noteId), /INVALID_ENCRYPTED_NOTE/);
    assert.throws(() => db.prepare("UPDATE note_versions SET content = 'must-never-persist' WHERE noteId = ?").run(noteId), /INVALID_ENCRYPTED_NOTE_HISTORY/);
    fs.writeFileSync(reportPath, JSON.stringify({ note, history }));
  } finally { closeDb(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
