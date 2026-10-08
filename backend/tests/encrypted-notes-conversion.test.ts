import assert from "node:assert/strict";
import { createHash, createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { Hono } from "hono";
import { closeDb, getDb } from "../src/db/schema.js";
import { ENCRYPTED_NOTE_FORMAT } from "../src/lib/encryptedNotes.js";
import { encryptedNotesMigration } from "../src/db/encryptedNotesMigration.js";
import { encryptedBlocksMigration } from "../src/db/encryptedBlocksMigration.js";
import { encryptedNoteConversionMigration } from "../src/db/encryptedNoteConversionMigration.js";
import { convertEncryptedNoteStorage, type EncryptedNoteConversionInput } from "../src/services/encryptedNoteConversion.js";
import { inspectEncryptedNoteConversion } from "../src/services/encryptedNoteConversionPreflight.js";
import { yJoin, yLeave, yDestroyDoc, yFlush } from "../src/services/yjs.js";
import { applyMutation } from "../src/sync/apply.js";
import { applyRemoteChanges } from "../src/sync/applyLocal.js";

const vector = JSON.parse(fs.readFileSync(new URL("../../frontend/src/lib/encryptedNotes/__tests__/fixtures/envelope-v1.json", import.meta.url), "utf8"));
const sentinel = "conversionprivatesentinel";
const owner = "conversion-owner";
let app: Hono;
test.before(async () => {
  await import("../src/runtime/knowledge-tree-migration-bootstrap.js");
  const db = getDb();
  db.prepare("INSERT INTO users (id,username,passwordHash) VALUES (?,?,'hash')").run(owner, owner);
  db.prepare("INSERT INTO notebooks (id,userId,name) VALUES ('conversion-notebook',?,'Public')").run(owner);
  const { initAuditTables } = await import("../src/services/audit.js"); initAuditTables();
  const { default: router } = await import("../src/routes/notes.js"); app = new Hono(); app.route("/notes", router);
});
test.after(() => closeDb());
const digest = (content: string) => createHash("sha256").update(content).digest("hex");
function encrypt(content: string, format: string) {
  const envelope = structuredClone(vector.envelope); envelope.objectId = randomUUID(); envelope.originalFormat = format;
  const dek = randomBytes(32);
  const aad = (purpose: string) => JSON.stringify(["nowen-encrypted-content", 1, "AES-256-GCM", purpose, envelope.objectId, "note", format]);
  const seal = (body: Buffer, key: Buffer, purpose: string) => {
    const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", key, iv); cipher.setAAD(Buffer.from(aad(purpose)));
    return { iv: iv.toString("base64"), ciphertext: Buffer.concat([cipher.update(body), cipher.final(), cipher.getAuthTag()]).toString("base64") };
  };
  envelope.wrappedKey = seal(dek, Buffer.from(vector.derivedKeyHex, "hex"), "key");
  envelope.payload = seal(Buffer.from(content), dek, "content"); dek.fill(0);
  return JSON.stringify(envelope);
}
function decrypt(content: string) {
  const envelope = JSON.parse(content);
  const aad = (purpose: string) => JSON.stringify(["nowen-encrypted-content", 1, "AES-256-GCM", purpose, envelope.objectId, "note", envelope.originalFormat]);
  const open = (cipher: { iv: string; ciphertext: string }, key: Buffer, purpose: string) => {
    const bytes = Buffer.from(cipher.ciphertext, "base64"); const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(cipher.iv, "base64"));
    decipher.setAAD(Buffer.from(aad(purpose))); decipher.setAuthTag(bytes.subarray(-16));
    return Buffer.concat([decipher.update(bytes.subarray(0, -16)), decipher.final()]);
  };
  const dek = open(envelope.wrappedKey, Buffer.from(vector.derivedKeyHex, "hex"), "key");
  try { return open(envelope.payload, dek, "content").toString("utf8"); } finally { dek.fill(0); }
}
async function create(format = "markdown") {
  const body = format === "markdown" ? `${sentinel} ${randomUUID()}` : JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: sentinel }] }] });
  const response = await app.request("/notes", { method: "POST", headers: { "X-User-Id": owner, "Content-Type": "application/json" }, body: JSON.stringify({ title: "Public", content: body, contentFormat: format, notebookId: "conversion-notebook" }) });
  assert.equal(response.status, 201, await response.clone().text());
  const created = await response.json() as any;
  const note = getDb().prepare("SELECT * FROM notes WHERE id = ?").get(created.id) as any;
  const input: EncryptedNoteConversionInput = { noteId: note.id, userId: owner, version: note.version, sourceDigest: digest(note.content), content: encrypt(note.content, format), discardHistory: true };
  return { note, input };
}
const retainedTables = ["note_versions", "note_blocks_index", "note_block_documents", "note_block_records", "note_block_operations", "block_operations", "note_yupdates", "note_ysnapshots", "note_y_subdocuments", "note_y_subdocument_updates", "note_y_subdocument_manifests", "yjs_operation_receipts", "embedding_queue", "note_embeddings", "note_import_origins", "sync_outbox_legacy_unbound"];

function seedCopies(noteId: string) {
  const db = getDb();
  const sql = (query: string, ...params: any[]) => db.prepare(query).run(...params);
  sql("INSERT INTO note_versions (id,noteId,userId,content,contentText,contentFormat,version) VALUES (?,?,?, ?,?,'markdown',1)", randomUUID(), noteId, owner, sentinel, sentinel);
  sql("INSERT OR REPLACE INTO note_block_documents (noteId,contentFormat,snapshotHash,materializedHash,snapshotContent) VALUES (?,'markdown','hash','hash',?)", noteId, sentinel);
  sql("INSERT INTO note_block_records (noteId,blockId,blockType,blockOrder,path,payload,payloadHash,plainText) VALUES (?,'copy','paragraph',0,'path',?,'hash',?)", noteId, sentinel, sentinel);
  sql("INSERT INTO note_block_operations (id,noteId,operationType,noteVersion,blockVersion,structureVersion,operationJson) VALUES (?,?,'update',1,1,1,?)", randomUUID(), noteId, sentinel);
  sql("INSERT INTO block_operations (userId,operationId,noteId,resultJson) VALUES (?,?,?,?)", owner, randomUUID(), noteId, sentinel);
  const update = sql("INSERT INTO note_yupdates (noteId,update_blob) VALUES (?,?)", noteId, Buffer.from(sentinel));
  sql("INSERT INTO note_ysnapshots (noteId,snapshot_blob) VALUES (?,?)", noteId, Buffer.from(sentinel));
  sql("INSERT INTO yjs_operation_receipts (noteId,operationId,updateId,updateHash,persistedAt) VALUES (?,?,?,'hash',datetime('now'))", noteId, randomUUID(), update.lastInsertRowid);
  sql("INSERT INTO note_y_subdocument_manifests (noteId,rootGuid,rootSnapshot,contentHash,sectionCount) VALUES (?,'root',?,'hash',1)", noteId, Buffer.from(sentinel));
  sql("INSERT INTO note_y_subdocuments (noteId,sectionId,guid,blockStart,blockEnd,snapshotBlob,payloadHash) VALUES (?,'section','guid',0,1,?,'hash')", noteId, Buffer.from(sentinel));
  sql("INSERT INTO note_y_subdocument_updates (noteId,sectionId,updateBlob) VALUES (?,'section',?)", noteId, Buffer.from(sentinel));
  sql("INSERT INTO note_embeddings (noteId,userId,model,dim,chunkText,vectorJson) VALUES (?,?,'model',2,?,'[0.1,0.2]')", noteId, owner, sentinel);
  sql("INSERT INTO note_import_origins (id,userId,workspaceScope,noteId,sourceType,externalId,metadata) VALUES (?,?,'personal',?,'markdown',?,?)", randomUUID(), owner, noteId, randomUUID(), sentinel);
  sql("INSERT INTO sync_outbox_legacy_unbound (id,mutationId,entityType,entityId,operation,payload) VALUES (?,?,'note',?,'upsert',?)", randomUUID(), randomUUID(), noteId, sentinel);
}
function snapshot(db = getDb()) {
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>);
  return tables.map(({ name }) => [name, db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all().map((row) => JSON.stringify(row)).sort()]);
}

for (const format of ["markdown", "tiptap-json"]) test(`conversion preserves authenticated ${format}, removes related payloads and keeps other notes intact`, async () => {
  const { note, input } = await create(format); const { note: other } = await create(); seedCopies(note.id); seedCopies(other.id);
  const otherCopies = retainedTables.map((table) => getDb().prepare(`SELECT * FROM ${table} WHERE ${table === "sync_outbox_legacy_unbound" ? "entityId" : "noteId"} = ?`).all(other.id));
  const result = convertEncryptedNoteStorage(getDb(), input);
  assert.equal(result.version, note.version + 1); assert.equal(result.physicalErasure, "not_verified");
  const stored = getDb().prepare("SELECT * FROM notes WHERE id = ?").get(note.id) as any;
  assert.equal(stored.content, input.content); assert.equal(stored.contentText, ""); assert.equal(stored.contentFormat, ENCRYPTED_NOTE_FORMAT);
  assert.equal(decrypt(stored.content), note.content);
  for (const table of retainedTables) {
    const rows = getDb().prepare(`SELECT * FROM ${table} WHERE ${table === "sync_outbox_legacy_unbound" ? "entityId" : "noteId"} = ?`).all(note.id) as any[];
    if (table === "note_versions") { assert.equal(rows.length, 1); assert.equal(decrypt(rows[0].content), note.content); }
    else assert.equal(rows.length, 0, table);
  }
  assert.deepEqual(retainedTables.map((table) => getDb().prepare(`SELECT * FROM ${table} WHERE ${table === "sync_outbox_legacy_unbound" ? "entityId" : "noteId"} = ?`).all(other.id)), otherCopies);
  for (const table of ["notes_fts", "notes_search_fts"]) {
    const matches = getDb().prepare(`SELECT rowid FROM ${table} WHERE ${table} MATCH ?`).all(sentinel) as any[];
    const converted = (getDb().prepare("SELECT rowid FROM notes WHERE id = ?").get(note.id) as any).rowid;
    assert.ok(!matches.some((row) => row.rowid === converted));
    assert.ok(matches.some((row) => row.rowid === (getDb().prepare("SELECT rowid FROM notes WHERE id = ?").get(other.id) as any).rowid));
  }
  assert.equal((getDb().prepare("SELECT count(*) AS count FROM encrypted_note_conversion_permits").get() as any).count, 0);
});

// SQL failures exercise real SQLite rollback rather than a production fault hook.
for (const table of [...retainedTables, "notes", "encrypted_note_conversion_permits"]) test(`failure at ${table} restores all source/history/index state`, async () => {
  const { note, input } = await create(); seedCopies(note.id); const db = getDb();
  const action = table === "notes" ? "UPDATE" : "DELETE";
  const column = table === "sync_outbox_legacy_unbound" ? "entityId" : table === "notes" ? "id" : "noteId";
  db.exec(`CREATE TRIGGER conversion_failure BEFORE ${action} ON ${table} WHEN OLD.${column} = '${note.id}' BEGIN SELECT RAISE(ABORT, 'conversion_failure'); END`);
  try {
    const before = snapshot(); assert.throws(() => convertEncryptedNoteStorage(db, input), /conversion_failure/);
    assert.deepEqual(snapshot(), before);
  } finally { db.exec("DROP TRIGGER conversion_failure"); }
});
test("failure after both FTS rebuilds also rolls back the encrypted transition and purge", async () => {
  const { note, input } = await create(); seedCopies(note.id); const db = getDb();
  db.exec(`CREATE TRIGGER conversion_failure BEFORE INSERT ON note_versions WHEN NEW.noteId = '${note.id}' BEGIN SELECT RAISE(ABORT, 'conversion_failure'); END`);
  try { const before = snapshot(); assert.throws(() => convertEncryptedNoteStorage(db, input), /conversion_failure/); assert.deepEqual(snapshot(), before); }
  finally { db.exec("DROP TRIGGER conversion_failure"); }
});
test("owner, version, exact source, format and explicit history consent are checked before deletion", async () => {
  const { input } = await create(); const before = snapshot();
  for (const patch of [{ userId: "other" }, { version: input.version - 1 }, { sourceDigest: digest("another source") }, { discardHistory: false }, { content: "not an envelope" }]) {
    assert.throws(() => convertEncryptedNoteStorage(getDb(), { ...input, ...patch } as any)); assert.deepEqual(snapshot(), before);
  }
  assert.throws(() => getDb().transaction(() => convertEncryptedNoteStorage(getDb(), input))(), { code: "INVALID_CONVERSION" });
  const payload = JSON.parse(input.content); payload.originalFormat = "tiptap-json";
  assert.throws(() => convertEncryptedNoteStorage(getDb(), { ...input, content: JSON.stringify(payload) }), { code: "CONVERSION_BLOCKED" });
  assert.deepEqual(snapshot(), before);
});
test("the database permit cannot authorize a different target, source revision, identity or invalid envelope", async () => {
  const { note, input } = await create(); const db = getDb();
  const malformed = JSON.parse(input.content); malformed.version = 2;
  for (const scenario of [
    { sourceVersion: input.version - 1 }, { sourceFormat: "tiptap-json" }, { target: encrypt(note.content, "markdown") },
    { update: "version = version + 2" }, { update: "version = version + 1, contentText = 'source'" },
    { update: "version = version + 1, id = 'different-note'" }, { target: JSON.stringify(malformed), body: JSON.stringify(malformed) },
  ]) {
    const before = snapshot();
    db.transaction(() => {
      db.prepare("INSERT INTO encrypted_note_conversion_permits (noteId,sourceVersion,sourceFormat,content) VALUES (?,?,?,?)").run(note.id, scenario.sourceVersion ?? input.version, scenario.sourceFormat ?? "markdown", scenario.target ?? input.content);
      assert.throws(() => db.prepare(`UPDATE notes SET content = ?, contentFormat = 'encrypted-note-v1', ${scenario.update || "version = version + 1, contentText = ''"} WHERE id = ?`).run(scenario.body ?? input.content, note.id), /INVALID_ENCRYPTED_NOTE/);
      db.prepare("DELETE FROM encrypted_note_conversion_permits WHERE noteId = ?").run(note.id);
    })();
    assert.deepEqual(snapshot(), before);
  }
});
test("v118 guards upgrade without relaxing the ordinary writer or envelope validator", async () => {
  const { input } = await create(); const filename = path.join(path.dirname(process.env.DB_PATH!), "upgrade-118.db"); await getDb().backup(filename);
  const old = new Database(filename); old.function("nowen_search_normalize", (value) => String(value || ""));
  try {
    // Restore the actual historical guard definitions in this private fixture.
    const triggers = old.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'encrypted_%'").all() as Array<{ name: string }>;
    for (const { name } of triggers) old.exec(`DROP TRIGGER "${name}"`);
    old.exec("DROP TABLE encrypted_note_conversion_permits; DROP TABLE encrypted_block_write_permits");
    encryptedNotesMigration.up(old); encryptedBlocksMigration.up(old);
    const ordinary = () => old.prepare("UPDATE notes SET content = ?, contentFormat = 'encrypted-note-v1', contentText = '', version = version + 1 WHERE id = ?").run(input.content, input.noteId);
    assert.throws(ordinary, /INVALID_ENCRYPTED_NOTE/);
    old.transaction(() => encryptedNoteConversionMigration.up(old))();
    assert.throws(ordinary, /INVALID_ENCRYPTED_NOTE/);
    convertEncryptedNoteStorage(old, input);
    assert.equal((old.prepare("SELECT content FROM notes WHERE id = ?").get(input.noteId) as any).content, input.content);
    assert.equal((old.prepare("SELECT count(*) AS count FROM encrypted_note_conversion_permits").get() as any).count, 0);
  } finally { old.close(); }
});
test("unsupported media or opaque rich text is refused before any source is removed", async () => {
  const db = getDb();
  for (const [format, content] of [["markdown", "![remote](https://example.invalid/image.png)"], ["tiptap-json", '{"type":"doc","content":[{"type":"image","attrs":{"src":"https://example.invalid/image.png"}}]}']]) {
    const { note } = await create(format);
    db.prepare("UPDATE notes SET content = ? WHERE id = ?").run(content, note.id);
    const input = { noteId: note.id, userId: owner, version: note.version, sourceDigest: digest(content), content: encrypt(content, format), discardHistory: true as const };
    const before = snapshot(); assert.throws(() => convertEncryptedNoteStorage(db, input), { code: "CONVERSION_BLOCKED" }); assert.deepEqual(snapshot(), before);
  }
});
test("the immediate transaction hides intermediate state and rejects a simultaneous writer", async () => {
  const { note, input } = await create(); const db = getDb(); const reader = new Database(process.env.DB_PATH!);
  reader.pragma("busy_timeout = 0"); reader.function("nowen_search_normalize", (value) => String(value || "")); reader.function("conversion_observer", () => 0);
  let observations = 0;
  db.function("conversion_observer", () => {
    observations++;
    assert.equal((reader.prepare("SELECT content FROM notes WHERE id = ?").get(note.id) as any).content, note.content);
    assert.equal((reader.prepare("SELECT count(*) AS count FROM encrypted_note_conversion_permits").get() as any).count, 0);
    assert.throws(() => reader.prepare("UPDATE notes SET sortOrder = sortOrder + 1 WHERE id = ?").run(note.id), { code: "SQLITE_BUSY" });
    return 0;
  });
  db.exec(`CREATE TRIGGER conversion_probe AFTER UPDATE OF content ON notes WHEN NEW.id = '${note.id}' BEGIN SELECT conversion_observer(); END`);
  try {
    convertEncryptedNoteStorage(db, input); assert.equal(observations, 1);
    assert.equal((reader.prepare("SELECT content FROM notes WHERE id = ?").get(note.id) as any).content, input.content);
  } finally { db.exec("DROP TRIGGER conversion_probe"); reader.close(); }
});
test("search rebuild removes extra stale terms absent from the old contentText", async () => {
  const { note, input } = await create(); const db = getDb(); const rowid = (db.prepare("SELECT rowid FROM notes WHERE id = ?").get(note.id) as any).rowid;
  for (const table of ["notes_fts", "notes_search_fts"]) {
    db.prepare(`INSERT INTO ${table}(rowid,title,contentText) VALUES (?,'Public','staleprivatesentinel')`).run(rowid);
    assert.ok(db.prepare(`SELECT rowid FROM ${table} WHERE ${table} MATCH 'staleprivatesentinel'`).all().length > 0);
  }
  convertEncryptedNoteStorage(db, input);
  for (const table of ["notes_fts", "notes_search_fts"]) assert.equal(db.prepare(`SELECT rowid FROM ${table} WHERE ${table} MATCH 'staleprivatesentinel'`).all().length, 0);
});
test("active and idle collaboration rooms are refused without flushing or losing state", async () => {
  const { note, input } = await create(); yJoin(note.id, owner);
  try {
    const before = snapshot();
    assert.throws(() => convertEncryptedNoteStorage(getDb(), input), { code: "CONVERSION_BLOCKED" });
    assert.deepEqual(snapshot(), before); yLeave(note.id);
    assert.throws(() => convertEncryptedNoteStorage(getDb(), input), { code: "CONVERSION_BLOCKED" });
  } finally { yDestroyDoc(note.id); }
});
test("unknown linked stores, templates, in-flight embeddings and disabled sync profiles block conversion", async () => {
  const { note, input } = await create(); const db = getDb();
  const blocked = () => { const before = snapshot(); assert.throws(() => convertEncryptedNoteStorage(db, input), { code: "CONVERSION_BLOCKED" }); assert.deepEqual(snapshot(), before); };
  db.exec("CREATE TABLE future_conversion_store (noteId TEXT, content TEXT)");
  try { db.prepare("INSERT INTO future_conversion_store VALUES (?,?)").run(note.id, sentinel); blocked(); } finally { db.exec("DROP TABLE future_conversion_store"); }
  db.prepare("UPDATE embedding_queue SET status = 'processing' WHERE noteId = ?").run(note.id); blocked();
  db.prepare("UPDATE embedding_queue SET status = 'pending' WHERE noteId = ?").run(note.id);
  db.prepare("INSERT INTO note_templates (id,createdBy,name,contentFormat,sourceNoteId) VALUES ('conversion-template',?,'Public','markdown',?)").run(owner, note.id);
  try { blocked(); } finally { db.prepare("DELETE FROM note_templates WHERE id = 'conversion-template'").run(); }
  db.prepare("INSERT INTO sync_profiles (id,name,serverUrl,enabled) VALUES ('conversion-profile','test','https://test.invalid',0)").run();
  try { blocked(); } finally { db.prepare("DELETE FROM sync_profiles WHERE id = 'conversion-profile'").run(); }
});
test("old API, direct database and Sync writers cannot restore plaintext after conversion", async () => {
  const { note, input } = await create(); convertEncryptedNoteStorage(getDb(), input); const db = getDb();
  const response = await app.request(`/notes/${note.id}`, { method: "PUT", headers: { "X-User-Id": owner, "Content-Type": "application/json" }, body: JSON.stringify({ content: sentinel, contentFormat: "markdown", version: note.version + 1 }) });
  assert.equal(response.status, 400);
  assert.throws(() => db.prepare("UPDATE notes SET content = ?, contentFormat = 'markdown' WHERE id = ?").run(sentinel, note.id));
  assert.throws(() => applyMutation(db, { mutationId: randomUUID(), deviceId: "old-client", entityType: "note", entityId: note.id, userId: owner, operation: "upsert", baseVersion: note.version, payload: note }));
  assert.throws(() => applyRemoteChanges(db, [{ entityType: "note", entityId: note.id, operation: "upsert", payload: note }], { userId: owner }));
  assert.throws(() => yJoin(note.id, owner), /ENCRYPTED_NOTE_COLLABORATION_FORBIDDEN/); yFlush(note.id);
  assert.throws(() => db.prepare("INSERT INTO note_versions (id,noteId,userId,content,contentFormat,version) VALUES (?,?,?,?,'markdown',1)").run(randomUUID(), note.id, owner, sentinel));
  assert.throws(() => db.prepare("INSERT INTO block_operations (userId,operationId,noteId,resultJson) VALUES (?,?,?,?)").run(owner, randomUUID(), note.id, sentinel));
  assert.throws(() => db.prepare("INSERT INTO embedding_queue (noteId,userId) VALUES (?,?)").run(note.id, owner));
  assert.equal((db.prepare("SELECT content FROM notes WHERE id = ?").get(note.id) as any).content, input.content);
});
test("vector rows participate in the same purge and rollback while unrelated vectors survive", async () => {
  const { note, input } = await create(); const { note: other } = await create(); seedCopies(note.id); seedCopies(other.id); const db = getDb();
  sqliteVec.load(db); db.exec("CREATE VIRTUAL TABLE vec_note_chunks USING vec0(embedding float[2])");
  try {
    const ids = [note.id, other.id].map((id) => (db.prepare("SELECT id FROM note_embeddings WHERE noteId = ?").get(id) as any).id);
    for (const id of ids) db.prepare("INSERT INTO vec_note_chunks (rowid,embedding) VALUES (?,?)").run(BigInt(id), new Uint8Array(new Float32Array([0.1, 0.2]).buffer));
    assert.ok(inspectEncryptedNoteConversion(db, note.id)!.copies.find((copy) => copy.kind === "embeddings")!.records >= 2);
    db.exec(`CREATE TRIGGER conversion_failure BEFORE INSERT ON note_versions WHEN NEW.noteId = '${note.id}' BEGIN SELECT RAISE(ABORT, 'conversion_failure'); END`);
    try { assert.throws(() => convertEncryptedNoteStorage(db, input), /conversion_failure/); assert.equal((db.prepare("SELECT count(*) AS count FROM vec_note_chunks").get() as any).count, 2); }
    finally { db.exec("DROP TRIGGER conversion_failure"); }
    convertEncryptedNoteStorage(db, input);
    assert.deepEqual(db.prepare("SELECT rowid FROM vec_note_chunks").all(), [{ rowid: ids[1] }]);
  } finally { db.exec("DROP TABLE vec_note_chunks"); }
});
test("a restored database retains conversion guards and startup does not re-enqueue ciphertext", async () => {
  const { note, input } = await create(); convertEncryptedNoteStorage(getDb(), input);
  const filename = path.join(path.dirname(process.env.DB_PATH!), "converted-backup.db"); await getDb().backup(filename);
  const restored = new Database(filename);
  try { assert.throws(() => restored.prepare("UPDATE notes SET contentFormat = 'markdown' WHERE id = ?").run(note.id)); }
  finally { restored.close(); }
  getDb().prepare("DELETE FROM embedding_queue").run();
  closeDb(); const restarted = getDb();
  assert.ok((restarted.prepare("SELECT count(*) AS count FROM embedding_queue").get() as any).count > 0);
  assert.equal((restarted.prepare("SELECT count(*) AS count FROM embedding_queue WHERE noteId = ?").get(note.id) as any).count, 0);
  restarted.prepare("UPDATE notes SET title = 'Changed public title' WHERE id = ?").run(note.id);
  assert.equal((restarted.prepare("SELECT count(*) AS count FROM embedding_queue WHERE noteId = ?").get(note.id) as any).count, 0);
  assert.equal((restarted.prepare("SELECT content FROM notes WHERE id = ?").get(note.id) as any).content, input.content);
});
