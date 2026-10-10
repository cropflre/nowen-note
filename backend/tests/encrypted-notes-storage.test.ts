import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import test from "node:test";
import { Hono } from "hono";
import { getDb, closeDb } from "../src/db/schema.js";
import { ENCRYPTED_NOTE_FORMAT, guardEncryptedNoteMutation, parseEncryptedNote } from "../src/lib/encryptedNotes.js";
import { extractSearchableText, repairSearchContentText } from "../src/lib/searchIndex.js";
import { syncNoteBlocks } from "../src/lib/noteBlocks.js";
import { yJoin } from "../src/services/yjs.js";
import { applyMutation } from "../src/sync/apply.js";
import { assertRemoteImageImportPermission } from "../src/services/remote-image-import.js";

const vector = JSON.parse(fs.readFileSync(new URL("../../frontend/src/lib/encryptedNotes/__tests__/fixtures/envelope-v1.json", import.meta.url), "utf8"));
const content = JSON.stringify(vector.envelope);
let app: Hono;
test.before(async () => {
  await import("../src/runtime/knowledge-tree-migration-bootstrap.js");
  const db = getDb();
  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES ('encrypted-owner', 'encrypted-owner', 'hash')").run();
  db.prepare("INSERT INTO sync_profiles (id, name, serverUrl, enabled, bootstrapStatus) VALUES ('encrypted-profile', 'test', 'https://sync.invalid', 1, 'ready')").run();
  db.prepare("INSERT INTO sync_device_identity (singletonKey, deviceId) VALUES (1, 'encrypted-device')").run();
  const { initAuditTables } = await import("../src/services/audit.js"); initAuditTables();
  const { default: router } = await import("../src/routes/notes.js");
  app = new Hono(); app.route("/notes", router);
  const { default: attachments } = await import("../src/routes/attachments-core.js");
  app.route("/attachments", attachments);
});
test.after(() => closeDb());
async function request(path: string, body?: unknown, method = "POST") {
  const response = await app.request(`/notes${path}`, { method, headers: { "X-User-Id": "encrypted-owner", "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() as any };
}
const create = () => request("", { title: "Visible title", content, contentText: "", contentFormat: ENCRYPTED_NOTE_FORMAT });

test("creation stores an unchanged envelope at the tree root and creates no plaintext indexes", async () => {
  const result = await create(); assert.equal(result.status, 201);
  assert.equal(result.body.content, content); assert.equal(result.body.contentText, "");
  assert.equal(result.body.contentFormat, ENCRYPTED_NOTE_FORMAT);
  const db = getDb();
  assert.equal((db.prepare("SELECT parentId FROM knowledge_tree_nodes WHERE resourceId = ? AND resourceType = 'note'").get(result.body.id) as any).parentId, null);
  assert.equal(extractSearchableText(content, ENCRYPTED_NOTE_FORMAT), "");
  assert.deepEqual(syncNoteBlocks(db, result.body.id, content, ENCRYPTED_NOTE_FORMAT), { content, contentText: "", blocks: [], changed: false });
  repairSearchContentText(db);
  for (const table of ["note_blocks_index", "note_block_records", "note_yupdates", "note_ysnapshots", "note_embeddings"]) {
    assert.equal((db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE noteId = ?`).get(result.body.id) as any).count, 0);
  }
  const loaded = await request(`/${result.body.id}`, undefined, "GET");
  assert.equal(loaded.body.content, content);
});

test("API rejects plaintext, downgrades, forged preview text, wrong identity and missing encrypted marker", async () => {
  const { body: note } = await create();
  for (const patch of [
    { content: "must-never-persist" },
    { content, contentFormat: "markdown" },
    { contentText: "must-never-persist" },
    { content: JSON.stringify({ ...vector.envelope, objectId: "00112233-4455-4677-8899-aabbccddee00" }), contentFormat: ENCRYPTED_NOTE_FORMAT },
  ]) {
    const response = await request(`/${note.id}`, { ...patch, version: note.version }, "PUT");
    assert.equal(response.status, 400); assert.equal(response.body.code, "INVALID_ENCRYPTED_NOTE");
    assert.equal((getDb().prepare("SELECT content FROM notes WHERE id = ?").get(note.id) as any).content, content);
  }
  const metadata = await request(`/${note.id}`, { isPinned: 1 }, "PUT");
  assert.equal(metadata.status, 200); assert.equal(metadata.body.contentText, "");
  const missingVersion = await request(`/${note.id}`, { content, contentFormat: ENCRYPTED_NOTE_FORMAT }, "PUT");
  assert.equal(missingVersion.status, 400);
});

test("server-confirmed CAS updates keep history encrypted and preserve data on conflict", async () => {
  const { body: note } = await create();
  const changed = structuredClone(vector.envelope);
  changed.payload.ciphertext = Buffer.from(new Uint8Array(32)).toString("base64");
  const updated = await request(`/${note.id}`, { content: JSON.stringify(changed), contentText: "", contentFormat: ENCRYPTED_NOTE_FORMAT, version: note.version }, "PUT");
  assert.equal(updated.status, 200); assert.equal(updated.body.version, note.version + 1);
  const history = getDb().prepare("SELECT content, contentText, contentFormat FROM note_versions WHERE noteId = ?").all(note.id) as any[];
  assert.ok(history.length > 0);
  for (const row of history) { parseEncryptedNote(row.content); assert.equal(row.contentText, ""); assert.equal(row.contentFormat, ENCRYPTED_NOTE_FORMAT); }
  const conflict = await request(`/${note.id}`, { content, contentFormat: ENCRYPTED_NOTE_FORMAT, version: note.version }, "PUT");
  assert.equal(conflict.status, 409);
  assert.equal((getDb().prepare("SELECT content FROM notes WHERE id = ?").get(note.id) as any).content, JSON.stringify(changed));
});

test("database guards reject old writers and Yjs, attachment and public-share derivatives", async () => {
  const { body: note } = await create(); const db = getDb();
  for (const sql of [
    "UPDATE notes SET content = 'must-never-persist' WHERE id = ?",
    "UPDATE notes SET contentFormat = 'markdown' WHERE id = ?",
    "UPDATE notes SET contentText = 'must-never-persist' WHERE id = ?",
  ]) assert.throws(() => db.prepare(sql).run(note.id));
  assert.throws(() => yJoin(note.id, "encrypted-owner"), /ENCRYPTED_NOTE_COLLABORATION_FORBIDDEN/);
  assert.throws(() => db.prepare("INSERT INTO shares (id, noteId, ownerId, shareToken) VALUES ('encrypted-share', ?, 'encrypted-owner', 'encrypted-share-token')").run(note.id), /ENCRYPTED_NOTE_DERIVED_CONTENT_FORBIDDEN/);
  assert.throws(() => db.prepare("INSERT INTO note_yupdates (noteId, update_blob) VALUES (?, ?)").run(note.id, Buffer.from("must-never-persist")), /ENCRYPTED_NOTE_DERIVED_CONTENT_FORBIDDEN/);
  assert.throws(() => db.prepare("INSERT INTO attachments (id, noteId, userId, filename, mimeType, size, path) VALUES ('encrypted-file', ?, 'encrypted-owner', 'file.txt', 'text/plain', 1, 'test-file')").run(note.id), /ENCRYPTED_NOTE_DERIVED_CONTENT_FORBIDDEN/);
  const form = new FormData();
  form.set("noteId", note.id); form.set("file", new File(["must-never-persist"], "file.txt", { type: "text/plain" }));
  const response = await app.request("/attachments", { method: "POST", headers: { "X-User-Id": "encrypted-owner" }, body: form });
  assert.equal(response.status, 400); assert.equal((await response.json() as any).code, "ENCRYPTED_NOTE_ATTACHMENT_FORBIDDEN");
  assert.throws(() => assertRemoteImageImportPermission(note.id, "encrypted-owner"), { code: "ENCRYPTED_NOTE_ATTACHMENT_FORBIDDEN" });
});

test("encrypted creation preserves client IDs so retries cannot create duplicate conflict copies", async () => {
  const id = "00112233-4455-4677-8899-aabbccddee55";
  const payload = { id, title: "Visible title", content, contentFormat: ENCRYPTED_NOTE_FORMAT };
  const created = await request("", payload); assert.equal(created.status, 201); assert.equal(created.body.id, id);
  const retry = await request("", payload); assert.equal(retry.status, 409); assert.equal(retry.body.code, "NOTE_ID_CONFLICT");
  assert.equal((getDb().prepare("SELECT COUNT(*) AS count FROM notes WHERE id = ?").get(id) as any).count, 1);
});

test("SQLite backup reopens with unchanged ciphertext and persistent old-writer/history guards", async () => {
  const { body: note } = await create();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-encrypted-backup-"));
  const filename = path.join(directory, "backup.db");
  let restored: Database.Database | undefined;
  try {
    await getDb().backup(filename);
    restored = new Database(filename);
    assert.equal((restored.prepare("SELECT content FROM notes WHERE id = ?").get(note.id) as any).content, content);
    assert.throws(() => restored!.prepare("UPDATE notes SET content = 'must-never-persist' WHERE id = ?").run(note.id));
    restored.prepare("INSERT INTO note_versions (id, noteId, userId, title, content, contentText, contentFormat, version) VALUES ('encrypted-history', ?, 'encrypted-owner', 'Visible title', ?, '', ?, 1)").run(note.id, content, ENCRYPTED_NOTE_FORMAT);
    assert.throws(() => restored!.prepare("UPDATE note_versions SET content = 'must-never-persist' WHERE id = 'encrypted-history'").run(), /INVALID_ENCRYPTED_NOTE_HISTORY/);
    const bytes = fs.readFileSync(filename);
    assert.equal(bytes.includes(vector.plaintext), false); assert.equal(bytes.includes(vector.passphrase), false);
  } finally { restored?.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test("Sync rejects a plaintext downgrade and retains ciphertext outbox payloads", async () => {
  const { body: note } = await create(); const db = getDb();
  assert.throws(() => applyMutation(db, { mutationId: "encrypted-downgrade", deviceId: "test-device", entityType: "note", entityId: note.id, userId: "encrypted-owner", operation: "upsert", baseVersion: note.version, payload: { ...note, contentFormat: "markdown", content: "must-never-persist" } }), { code: "INVALID_ENCRYPTED_NOTE" });
  assert.equal(applyMutation(db, { mutationId: "encrypted-valid", deviceId: "test-device", entityType: "note", entityId: note.id, userId: "encrypted-owner", operation: "upsert", baseVersion: note.version, payload: note }).status, "applied");
  const changes = db.prepare("SELECT payload FROM sync_outbox WHERE entityType = 'note' AND entityId = ?").all(note.id) as any[];
  assert.ok(changes.length > 0);
  assert.ok(changes.every((row) => !row.payload.includes(vector.plaintext) && !row.payload.includes(vector.passphrase)));
});

test("strict wire validation rejects unsupported envelopes without KDF or secrets", () => {
  assert.equal(parseEncryptedNote(content).objectId, vector.envelope.objectId);
  for (const patch of [{ version: 2 }, { kind: "block" }, { passphrase: "secret" }, { payload: { ...vector.envelope.payload, ciphertext: "plaintext" } }, { kdf: { ...vector.envelope.kdf, memoryKiB: 2 ** 32 } }]) {
    assert.throws(() => parseEncryptedNote(JSON.stringify({ ...vector.envelope, ...patch })));
  }
  assert.throws(() => guardEncryptedNoteMutation({ content, contentFormat: ENCRYPTED_NOTE_FORMAT }, { content: "old plaintext", contentFormat: "markdown" }));
});
