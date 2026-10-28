import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { encryptedContentV2Migration } from "../src/db/encryptedContentV2Migration.js";
import { encryptedNoteDecryptionMigration } from "../src/db/encryptedNoteDecryptionMigration.js";
import { encryptedJsonEvaluationMigration } from "../src/db/encryptedJsonEvaluationMigration.js";

test("DCC-008: existing encrypted guards reject malformed JSON with stable errors and retain rows after reopening", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-encrypted-json-"));
  const filename = path.join(directory, "fixture.db");
  let db = new Database(filename);
  try {
    db.exec(`CREATE TABLE notes (id TEXT PRIMARY KEY, content TEXT, contentText TEXT, contentFormat TEXT,
      version INTEGER DEFAULT 1, userId TEXT, workspaceId TEXT, notebookId TEXT, isLocked INTEGER DEFAULT 0, isTrashed INTEGER DEFAULT 0);
      CREATE TABLE note_versions (id TEXT PRIMARY KEY, noteId TEXT, version INTEGER, content TEXT, contentText TEXT, contentFormat TEXT);
      CREATE TABLE encrypted_note_conversion_permits (noteId TEXT, sourceVersion INTEGER, sourceFormat TEXT, content TEXT);`);
    encryptedContentV2Migration.up(db);
    encryptedNoteDecryptionMigration.up(db);
    const fixture = JSON.parse(fs.readFileSync(new URL("../../frontend/src/lib/encryptedNotes/__tests__/fixtures/envelope-v2.json", import.meta.url), "utf8"));
    const content = JSON.stringify(fixture.envelope);
    db.prepare("INSERT INTO notes (id,content,contentText,contentFormat) VALUES ('protected',?,'','encrypted-note-v2')").run(content);
    db.prepare("INSERT INTO notes (id,content,contentText,contentFormat) VALUES ('ordinary','public','public','markdown')").run();
    db.prepare("INSERT INTO note_versions VALUES ('history','protected',1,?,'','encrypted-note-v2')").run(content);
    const original = db.prepare("SELECT * FROM notes ORDER BY id").all();
    const history = db.prepare("SELECT * FROM note_versions").all();
    db.transaction(() => encryptedJsonEvaluationMigration.up(db))();
    encryptedJsonEvaluationMigration.up(db); // Safe if repaired triggers are restored from a backup.
    db.close();
    db = new Database(filename);
    for (const invalid of ["plaintext", "{", "", null]) {
      assert.throws(() => db.prepare("UPDATE notes SET content=? WHERE id='protected'").run(invalid), /INVALID_ENCRYPTED_NOTE/);
      assert.throws(() => db.prepare("UPDATE note_versions SET content=? WHERE id='history'").run(invalid), /INVALID_ENCRYPTED_NOTE_HISTORY/);
      assert.throws(() => db.prepare("INSERT INTO note_versions VALUES ('bad','protected',2,?,'','encrypted-note-v2')").run(invalid), /INVALID_ENCRYPTED_NOTE_HISTORY/);
    }
    assert.throws(() => db.prepare("UPDATE notes SET content='plaintext',contentFormat='markdown' WHERE id='protected'").run(), /INVALID_ENCRYPTED_NOTE/);
    assert.deepEqual(db.prepare("SELECT * FROM notes ORDER BY id").all(), original);
    assert.deepEqual(db.prepare("SELECT * FROM note_versions").all(), history);
    db.prepare("UPDATE notes SET content='updated public',contentText='updated public' WHERE id='ordinary'").run();
    db.prepare("UPDATE notes SET content=? WHERE id='protected'").run(content);
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
