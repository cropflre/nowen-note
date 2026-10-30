import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { getDb, closeDb } from "../src/db/schema.js";
import { runMigrations } from "../src/db/migrations.js";

const guards = ["encrypted_notes_insert", "encrypted_notes_update", "encrypted_notes_conversion_validate", "encrypted_note_versions_insert", "encrypted_note_versions_update"];
const vector = JSON.parse(fs.readFileSync(new URL("../../frontend/src/lib/encryptedNotes/__tests__/fixtures/envelope-v1.json", import.meta.url), "utf8"));

test.after(() => closeDb());

for (const missing of [["encrypted_note_versions_update"], guards]) {
  test(`v123 repairs missing predecessor guards (${missing.join(", ")}) without changing stored data`, () => {
    const db = getDb();
    db.exec("SAVEPOINT migration_fixture");
    try {
      db.prepare("INSERT OR IGNORE INTO users(id,username,passwordHash) VALUES ('migration-owner','migration-owner','hash')").run();
      db.prepare("INSERT OR IGNORE INTO notebooks(id,userId,name) VALUES ('migration-notebook','migration-owner','Fixture')").run();
      db.prepare("INSERT OR IGNORE INTO notes(id,userId,notebookId,title,content,contentText,contentFormat) VALUES ('migration-note','migration-owner','migration-notebook','Encrypted fixture',?,'','encrypted-note-v1')")
        .run(JSON.stringify(vector.envelope));
      db.prepare("INSERT OR IGNORE INTO note_versions(id,noteId,userId,title,content,contentText,contentFormat,version) VALUES ('migration-history','migration-note','migration-owner','Encrypted fixture',?,'','encrypted-note-v1',1)")
        .run(JSON.stringify(vector.envelope));
      const note = db.prepare("SELECT * FROM notes WHERE id='migration-note'").get();
      const history = db.prepare("SELECT * FROM note_versions WHERE id='migration-history'").get();
      const outbox = db.prepare("SELECT * FROM sync_outbox ORDER BY id").all();
      db.prepare("DELETE FROM schema_migrations WHERE version>=123").run();
      for (const name of missing) db.exec(`DROP TRIGGER ${name}`);

      assert.doesNotThrow(() => runMigrations(db));
      for (const name of guards) assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?").get(name));
      assert.equal(db.prepare("SELECT name FROM schema_migrations WHERE version=123").get().name, "encrypted-content-v2-storage");
      assert.deepEqual(db.prepare("SELECT * FROM notes WHERE id='migration-note'").get(), note);
      assert.deepEqual(db.prepare("SELECT * FROM note_versions WHERE id='migration-history'").get(), history);
      assert.deepEqual(db.prepare("SELECT * FROM sync_outbox ORDER BY id").all(), outbox);
      assert.throws(() => db.prepare("UPDATE notes SET content='invalid' WHERE id='migration-note'").run(), /INVALID_ENCRYPTED_NOTE/);
      assert.throws(() => db.prepare("UPDATE note_versions SET content='invalid' WHERE id='migration-history'").run(), /INVALID_ENCRYPTED_NOTE_HISTORY/);
      assert.throws(() => db.prepare("INSERT INTO note_versions(id,noteId,userId,title,content,contentFormat,version) VALUES ('invalid-history','migration-note','migration-owner','Fixture','invalid','markdown',2)").run(), /INVALID_ENCRYPTED_NOTE_HISTORY/);
      assert.equal(runMigrations(db), 0);
    } finally {
      db.exec("ROLLBACK TO migration_fixture; RELEASE migration_fixture");
    }
  });
}
