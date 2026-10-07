import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import Database from "better-sqlite3";
import { NATIVE_ENCRYPTED_NOTE_GUARDS } from "../../frontend/src/lib/encryptedNotes/nativeStorageGuards.js";

const require = createRequire(import.meta.url);
const { envelope } = require("../../frontend/src/lib/encryptedNotes/__tests__/fixtures/envelope-v1.json");

test("Native SQLite persistent guards reject invalid ciphertext and old-client downgrade without JS functions", () => {
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE notes (id TEXT PRIMARY KEY,content TEXT,contentText TEXT,contentFormat TEXT)");
    for (const sql of NATIVE_ENCRYPTED_NOTE_GUARDS) db.exec(sql);
    const insert = db.prepare("INSERT INTO notes VALUES (?,?,?,?)");
    insert.run("protected", JSON.stringify(envelope), "", "encrypted-note-v1");
    insert.run("ordinary", "Public body", "Public body", "markdown");
    const original = db.prepare("SELECT * FROM notes WHERE id='protected'").get();
    for (const [content, preview, format] of [["Plaintext", "", "encrypted-note-v1"], [JSON.stringify(envelope), "Private preview", "encrypted-note-v1"], [JSON.stringify(envelope), "", "encrypted-note-v99"]]) {
      assert.throws(() => insert.run("invalid", content, preview, format), /INVALID_ENCRYPTED_NOTE/);
    }
    const update = db.prepare("UPDATE notes SET content=?,contentText=?,contentFormat=? WHERE id=?");
    assert.throws(() => update.run("Private downgrade", "Private downgrade", "markdown", "protected"), /INVALID_ENCRYPTED_NOTE/);
    assert.throws(() => update.run(JSON.stringify({ ...envelope, objectId: "00112233-4455-4677-8899-aabbccddee00" }), "", "encrypted-note-v1", "protected"), /INVALID_ENCRYPTED_NOTE/);
    assert.throws(() => update.run(JSON.stringify(envelope), "", "encrypted-note-v1", "ordinary"), /INVALID_ENCRYPTED_NOTE/);
    assert.deepEqual(db.prepare("SELECT * FROM notes WHERE id='protected'").get(), original);
    update.run(JSON.stringify({ ...envelope, payload: { ...envelope.payload, iv: "MDEyMzQ1Njc4OTo7" } }), "", "encrypted-note-v1", "protected");
    update.run("Updated public", "Updated public", "markdown", "ordinary");
  } finally { db.close(); }
});
