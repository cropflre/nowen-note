import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import fs from "node:fs";
import { Hono } from "hono";
import { ENCRYPTED_NOTE_FORMAT } from "../src/lib/encryptedNotes.js";
import { getDb, closeDb } from "../src/db/schema.js";
import { inspectEncryptedNoteConversion } from "../src/services/encryptedNoteConversionPreflight.js";
import { yJoin, yDestroyDoc } from "../src/services/yjs.js";

let app: Hono;
const sentinel = "private-preflight-body-must-not-be-returned";
test.before(async () => {
  await import("../src/runtime/knowledge-tree-migration-bootstrap.js");
  const db = getDb();
  for (const id of ["preflight-owner", "preflight-other"]) {
    db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, 'hash')").run(id, id);
  }
  db.prepare("INSERT INTO notebooks (id,userId,name) VALUES ('preflight-notebook','preflight-owner','Test')").run();
  const { initAuditTables } = await import("../src/services/audit.js"); initAuditTables();
  const { default: router } = await import("../src/routes/notes.js");
  app = new Hono(); app.route("/notes", router);
});
test.after(() => closeDb());
async function create() {
  const response = await app.request("/notes", { method: "POST", headers: { "X-User-Id": "preflight-owner", "Content-Type": "application/json" }, body: JSON.stringify({ title: "Test", content: sentinel, contentFormat: "markdown", notebookId: "preflight-notebook" }) });
  assert.equal(response.status, 201, await response.clone().text());
  return await response.json() as { id: string; version: number };
}
const inspect = (id: string, user = "preflight-owner") => app.request(`/notes/${id}/encryption-preflight`, { headers: { "X-User-Id": user } });

test("only the owner can inspect; missing notes and anonymous callers are rejected", async () => {
  const note = await create();
  getDb().prepare("INSERT INTO note_acl (noteId,userId,permission) VALUES (?,'preflight-other','manage')").run(note.id);
  assert.equal((await inspect(note.id, "preflight-other")).status, 403);
  assert.equal((await inspect(note.id, "")).status, 403);
  assert.equal((await inspect("does-not-exist")).status, 404);
  const response = await inspect(note.id);
  assert.equal(response.status, 200); assert.equal(response.headers.get("Cache-Control"), "no-store");
});

test("inspection never grants a conversion permit to the ordinary save endpoint", async () => {
  const note = await create(); const db = getDb();
  const before = db.prepare("SELECT content,contentFormat,version FROM notes WHERE id = ?").get(note.id);
  await inspect(note.id);
  const vector = JSON.parse(fs.readFileSync(new URL("../../frontend/src/lib/encryptedNotes/__tests__/fixtures/envelope-v1.json", import.meta.url), "utf8"));
  const response = await app.request(`/notes/${note.id}`, {
    method: "PUT", headers: { "X-User-Id": "preflight-owner", "Content-Type": "application/json" },
    body: JSON.stringify({ content: JSON.stringify(vector.envelope), contentFormat: ENCRYPTED_NOTE_FORMAT, contentText: "", version: note.version }),
  });
  assert.equal(response.status, 400); assert.equal((await response.json() as any).code, "INVALID_ENCRYPTED_NOTE");
  assert.deepEqual(db.prepare("SELECT content,contentFormat,version FROM notes WHERE id = ?").get(note.id), before);
});

test("inventory counts linked copies only and never changes or discloses plaintext", async () => {
  const note = await create(); const other = await create(); const db = getDb();
  for (const [id, noteId] of [["preflight-history", note.id], ["other-history", other.id]]) {
    db.prepare("INSERT INTO note_versions (id,noteId,userId,title,content,contentText,contentFormat,version) VALUES (?,?,'preflight-owner','Test',?,?,'markdown',1)").run(id, noteId, sentinel, sentinel);
  }
  db.prepare("INSERT INTO note_templates (id,createdBy,name,content,contentText,contentFormat,sourceNoteId) VALUES ('preflight-template','preflight-owner','Test',?,?,'markdown',?)").run(sentinel, sentinel, note.id);
  for (const [id, refs] of [["ai-linked", JSON.stringify([{ noteId: note.id, excerpt: sentinel }])], ["ai-malformed", `broken:${note.id}`], ["ai-other", JSON.stringify([{ noteId: other.id }])]]) {
    db.prepare("INSERT INTO ai_chat_messages (id,userId,role,content,referencesJson) VALUES (?,'preflight-owner','user',?,?)").run(id, sentinel, refs);
  }
  db.prepare("INSERT INTO note_yupdates (noteId,update_blob) VALUES (?,?)").run(note.id, Buffer.from(sentinel));
  const before = db.prepare("SELECT total_changes() AS count").get();
  const bodyBefore = db.prepare("SELECT * FROM notes WHERE id = ?").get(note.id);
  const historyBefore = db.prepare("SELECT * FROM note_versions WHERE noteId = ?").all(note.id);
  const response = await inspect(note.id); assert.equal(response.status, 200);
  const raw = await response.text(); const report = JSON.parse(raw);
  assert.equal(raw.includes(sentinel), false);
  assert.equal(report.canConvert, false); assert.ok(report.blockers.includes("conversion_not_enabled"));
  const count = (kind: string) => report.copies.find((copy: { kind: string }) => copy.kind === kind).records;
  assert.equal(count("history"), historyBefore.length); assert.equal(count("templates"), 1);
  assert.equal(count("aiReferences"), 2); assert.equal(count("collaboration"), 1);
  assert.ok(report.blockers.includes("templates")); assert.ok(report.blockers.includes("aiReferences"));
  assert.equal(report.physicalErasure, "not_verified"); assert.equal(report.externalCopies, "not_inspectable");
  assert.deepEqual(db.prepare("SELECT total_changes() AS count").get(), before);
  assert.deepEqual(db.prepare("SELECT * FROM notes WHERE id = ?").get(note.id), bodyBefore);
  assert.deepEqual(db.prepare("SELECT * FROM note_versions WHERE noteId = ?").all(note.id), historyBefore);
});

test("an incomplete schema and unknown note/entity stores cannot produce a complete audit", () => {
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE notes (id,version,contentFormat,contentText,workspaceId,isTrashed,isLocked); INSERT INTO notes VALUES ('note',1,'markdown','private',NULL,0,0); CREATE TABLE future_note_store (note_id,payload); INSERT INTO future_note_store VALUES ('note','private'); CREATE TABLE future_entity_store (entityType,entityId,payload); INSERT INTO future_entity_store VALUES ('note','note','private'),('task','note','private');");
    const report = inspectEncryptedNoteConversion(db, "note")!;
    assert.ok(report.copies.every((copy) => !copy.complete));
    assert.deepEqual(report.unreviewed, [{ table: "future_note_store", records: 1 }, { table: "future_entity_store", records: 1 }]);
    assert.ok(report.blockers.includes("audit_incomplete")); assert.equal(report.canConvert, false);
    assert.equal(inspectEncryptedNoteConversion(db, "missing"), null);
    db.exec("UPDATE notes SET contentFormat = 'html', workspaceId = 'workspace', isTrashed = 1, isLocked = 1");
    const blocked = inspectEncryptedNoteConversion(db, "note")!;
    for (const blocker of ["unsupported_format", "shared_workspace", "note_unavailable"]) assert.ok(blocked.blockers.includes(blocker));
  } finally { db.close(); }
});

test("live collaboration is reported without flushing or modifying its state", async () => {
  const note = await create(); const db = getDb();
  yJoin(note.id, "preflight-owner");
  try {
    const before = db.prepare("SELECT total_changes() AS count").get();
    const report = inspectEncryptedNoteConversion(db, note.id)!;
    assert.equal(report.activeCollaborators, 1); assert.ok(report.blockers.includes("active_collaboration"));
    assert.deepEqual(db.prepare("SELECT total_changes() AS count").get(), before);
  } finally { yDestroyDoc(note.id); }
});
