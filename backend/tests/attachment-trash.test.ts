import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Hono } from "hono";
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-trash-"));
process.env.DB_PATH = path.join(directory, "test.db"); process.env.ELECTRON_USER_DATA = directory;
let app: Hono, schema: typeof import("../src/db/schema"), attachmentsDir: string;
function req(url: string, method = "GET", body?: unknown, userId = "trash-owner") {
  return app.request(url, { method, headers: { "X-User-Id": userId, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function json(response: Promise<Response>, status = 200): Promise<any> { const r = await response; assert.equal(r.status, status, await r.clone().text()); return r.json(); }
async function upload(bytes: string, folderId?: string) {
  const form = new FormData(); form.set("file", new File([bytes], "original.txt", { type: "text/plain" })); if (folderId) form.set("folderId", folderId);
  return json(app.request("/api/files/upload", { method: "POST", headers: { "X-User-Id": "trash-owner" }, body: form }), 201);
}
test.before(async () => {
  await import("../src/runtime/knowledge-tree-migration-bootstrap"); schema = await import("../src/db/schema");
  const [{ default: files }, { default: folders }, { default: attachments }, { wrapKnowledgeRoute }, { getAttachmentsDir }] = await Promise.all([
    import("../src/routes/files"), import("../src/routes/attachment-folders"), import("../src/routes/attachments"), import("../src/runtime/knowledge-tree"), import("../src/routes/attachments-core"),
  ]);
  app = new Hono().route("/api/files", wrapKnowledgeRoute("/api/files", files)).route("/api/attachment-folders", folders).route("/api/attachments", attachments);
  app.route("/api/data-file", (await import("../src/routes/data-file")).default);
  attachmentsDir = getAttachmentsDir();
  const db = schema.getDb();
  for (const id of ["trash-owner", "trash-other"]) db.prepare("INSERT INTO users (id,username,passwordHash) VALUES (?,?,'hash')").run(id, id);
});
test.after(() => { schema?.closeDb(); fs.rmSync(directory, { recursive: true, force: true }); });
test("trash retains identity, bytes, tags and backup state while hiding active listings and public links", async () => {
  const folder = await json(req("/api/attachment-folders", "POST", { name: "Original" }), 201);
  const file = await upload("recoverable bytes", folder.id);
  const db = schema.getDb(); const before = db.prepare("SELECT * FROM attachments WHERE id=?").get(file.id) as any;
  const tag = (await json(req("/api/files/organization/tags", "POST", { name: "Retained" }), 201)).tag;
  await json(req("/api/files/organization/tag-files", "POST", { ids: [file.id], tagIds: [tag.id], operation: "add" }));
  await json(req(`/api/files/${file.id}`, "DELETE"));
  const row = db.prepare("SELECT * FROM attachments WHERE id=?").get(file.id) as any;
  for (const field of ["id", "noteId", "path", "hash", "filename", "size"]) assert.equal(row[field], before[field]);
  assert.ok(row.trashedAt); assert.equal(row.originalFolderId, folder.id); assert.equal(row.folderId, null);
  assert.equal(fs.readFileSync(path.join(attachmentsDir, row.path), "utf8"), "recoverable bytes");
  assert.equal((await json(req("/api/files"))).items.some((f: any) => f.id === file.id), false);
  assert.equal((await json(req("/api/files/stats"))).total, 0);
  assert.equal((await json(req("/api/attachment-folders"))).folders[0].fileCount, 0);
  assert.equal((await json(req("/api/files/trash"))).entries[0].id, file.id);
  assert.equal((await json(req("/api/files/trash", "GET", undefined, "trash-other"))).total, 0);
  const { isAttachmentExternalAccessEnabled } = await import("../src/services/attachment-link-policy");
  assert.equal(isAttachmentExternalAccessEnabled(file.id), false);
  const { attachmentDeletionRisk } = await import("../src/services/attachment-deletion-safety");
  assert.equal(attachmentDeletionRisk(file.id)?.code, "FILE_TRASHED");
  assert.throws(() => db.prepare("DELETE FROM attachments WHERE id=?").run(file.id), /ATTACHMENT_TRASH_RETAINED/);
  assert.throws(() => db.prepare("DELETE FROM notes WHERE id=?").run(row.noteId), /ATTACHMENT_TRASH_RETAINED/);
  const { deleteAttachmentFilesByNoteIds } = await import("../src/routes/attachments-core");
  assert.throws(() => deleteAttachmentFilesByNoteIds([row.noteId]), /请先恢复/);
  assert.equal(fs.readFileSync(path.join(attachmentsDir, row.path), "utf8"), "recoverable bytes");
  db.prepare("UPDATE notes SET isTrashed=1 WHERE id=?").run(row.noteId);
  const { permanentlyDeleteNote } = await import("../src/services/trash/noteTrashAdapter");
  assert.throws(() => permanentlyDeleteNote(row.noteId, "trash-owner"), (error: any) => error.code === "ATTACHMENT_TRASH_RETAINED");
  db.prepare("UPDATE notes SET isTrashed=0 WHERE id=?").run(row.noteId);
  const snapshot = path.join(directory, "snapshot.db"); await db.backup(snapshot);
  const Database = (await import("better-sqlite3")).default; const backup = new Database(snapshot);
  assert.equal((backup.prepare("SELECT trashedAt FROM attachments WHERE id=?").get(file.id) as any).trashedAt, row.trashedAt);
  assert.ok(backup.prepare("SELECT 1 FROM asset_tag_relations WHERE attachmentId=?").get(file.id)); backup.close();
  const restored = await json(req("/api/files/trash/restore", "POST", { ids: [file.id] }));
  assert.deepEqual(restored.restored, [{ id: file.id, folderId: folder.id, fallback: false }]);
  assert.equal((await json(req(`/api/files/${file.id}`))).externalAccessEnabled, false);
  assert.equal((await json(req(`/api/files/organization/assets/${file.id}`))).tags[0].id, tag.id);

});
test("restore falls back safely after original-folder deletion and batch validation never partially restores", async () => {
  const folder = await json(req("/api/attachment-folders", "POST", { name: "Removed folder" }), 201);
  const file = await upload("fallback bytes", folder.id);
  await json(req(`/api/files/${file.id}`, "DELETE")); await json(req(`/api/attachment-folders/${folder.id}`, "DELETE"));
  await json(req("/api/files/trash/restore", "POST", { ids: [file.id, "missing"] }), 403);
  assert.ok((schema.getDb().prepare("SELECT trashedAt FROM attachments WHERE id=?").get(file.id) as any).trashedAt);
  await json(req("/api/files/trash/restore", "POST", { ids: [file.id] }, "trash-other"), 403);
  const result = await json(req("/api/files/trash/restore", "POST", { ids: [file.id] }));
  assert.deepEqual(result.restored, [{ id: file.id, folderId: null, fallback: true }]);
});
test("purge requires explicit confirmation, trash state and a fresh backend reference check", async () => {
  const first = await upload("purge bytes"); const second = await upload("keep bytes");
  await json(req("/api/files/trash/purge", "POST", { ids: [first.id] }), 400);
  await json(req("/api/files/trash/purge", "POST", { ids: [first.id], confirmation: "PERMANENTLY_DELETE" }), 409);
  for (const id of [first.id, second.id]) await json(req(`/api/files/${id}`, "DELETE"));
  const db = schema.getDb(); const row = db.prepare("SELECT path,noteId FROM attachments WHERE id=?").get(first.id) as any;
  db.prepare("INSERT INTO attachment_references (attachmentId,noteId) VALUES (?,?)").run(second.id, row.noteId);
  await json(req("/api/files/trash/purge", "POST", { ids: [first.id, second.id], confirmation: "PERMANENTLY_DELETE" }), 409);
  assert.ok(db.prepare("SELECT id FROM attachments WHERE id=?").get(first.id)); assert.ok(fs.existsSync(path.join(attachmentsDir, row.path)));
  db.prepare("DELETE FROM attachment_references WHERE attachmentId=?").run(second.id);
  await json(req("/api/files/trash/purge", "POST", { ids: [first.id], confirmation: "PERMANENTLY_DELETE" }, "trash-other"), 403);
  await json(req("/api/files/trash/purge", "POST", { ids: [first.id], confirmation: "PERMANENTLY_DELETE" }));
  assert.equal(db.prepare("SELECT id FROM attachments WHERE id=?").get(first.id), undefined);
  assert.equal(fs.existsSync(path.join(attachmentsDir, row.path)), false);
  await json(req("/api/files/trash/restore", "POST", { ids: [second.id] }));
});
test("reuploading identical bytes creates an active record without reviving or moving the trashed file", async () => {
  const file = await upload("dedup trash bytes"); await json(req(`/api/files/${file.id}`, "DELETE"));
  const next = await upload("dedup trash bytes"); assert.notEqual(next.id, file.id);
  assert.ok((schema.getDb().prepare("SELECT trashedAt FROM attachments WHERE id=?").get(file.id) as any).trashedAt);
  assert.equal((schema.getDb().prepare("SELECT trashedAt FROM attachments WHERE id=?").get(next.id) as any).trashedAt, null);
});
test("migration is additive and idempotent and retains existing attachments", async () => {
  const { attachmentTrashMigration } = await import("../src/db/attachmentTrashMigration");
  const db = schema.getDb(); const before = db.prepare("SELECT * FROM attachments ORDER BY id").all();
  attachmentTrashMigration.up(db); attachmentTrashMigration.up(db);
  assert.deepEqual(db.prepare("SELECT * FROM attachments ORDER BY id").all(), before);
});

test("orphan scan, dry run and cleanup preserve retained note-attachment bytes", async () => {
  const file = await upload("retained outside garbage collection");
  await json(req(`/api/files/${file.id}`, "DELETE"));
  const db = schema.getDb();
  db.prepare("UPDATE attachments SET uploadSource=NULL,createdAt='2000-01-01 00:00:00' WHERE id=?").run(file.id);
  const row = db.prepare("SELECT path FROM attachments WHERE id=?").get(file.id) as any;
  const { scanOrphanAttachments } = await import("../src/routes/attachments-core");
  const scan = scanOrphanAttachments(0);
  assert.equal(scan.contentOrphans.some((entry) => entry.id === file.id), false);
  assert.equal(scan.dbOrphans.some((entry) => entry.filename === row.path), false);
  const dryRun = await json(req("/api/data-file/cleanup-orphans?dryRun=1&graceHours=0", "POST"));
  assert.equal(dryRun.contentOrphanBytes, 0);
  const cleanup = await json(req("/api/data-file/cleanup-orphans?graceHours=0", "POST"));
  assert.equal(cleanup.contentOrphansRemoved, 0);
  assert.ok(db.prepare("SELECT 1 FROM attachments WHERE id=?").get(file.id));
  assert.equal(fs.readFileSync(path.join(attachmentsDir, row.path), "utf8"), "retained outside garbage collection");
});
