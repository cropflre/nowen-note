import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Hono } from "hono";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-assets-linking-"));
process.env.DB_PATH = path.join(directory, "test.db");
process.env.ELECTRON_USER_DATA = directory;
let app: Hono;
let schema: typeof import("../src/db/schema");
function req(url: string, body: unknown, userId = "link-owner") {
  return app.request(`/api/files/${url}`, { method: "POST", headers: { "X-User-Id": userId, "Content-Type": "application/json" }, body: JSON.stringify(body) });
}
test.before(async () => {
  await import("../src/runtime/knowledge-tree-migration-bootstrap");
  schema = await import("../src/db/schema");
  const { default: files } = await import("../src/routes/files");
  const { wrapKnowledgeRoute } = await import("../src/runtime/knowledge-tree");
  app = new Hono().route("/api/files", wrapKnowledgeRoute("/api/files", files));
  const db = schema.getDb();
  for (const id of ["link-owner", "link-other"]) {
    db.prepare("INSERT INTO users (id,username,passwordHash) VALUES (?,?,'hash')").run(id, id);
    db.prepare("INSERT INTO notebooks (id,userId,name) VALUES (?,?,'Notes')").run(`${id}-book`, id);
    db.prepare("INSERT INTO notes (id,userId,notebookId,title) VALUES (?,?,?,'Target')").run(`${id}-note`, id, `${id}-book`);
  }
  db.prepare("INSERT INTO workspaces (id,name,ownerId) VALUES ('link-team','Team','link-owner')").run();
  db.prepare("INSERT INTO workspace_members (workspaceId,userId,role) VALUES ('link-team','link-owner','owner')").run();
  db.prepare("INSERT INTO notes (id,userId,notebookId,title,workspaceId) VALUES ('link-team-note','link-owner','link-owner-book','Team','link-team')").run();
  for (const [id, user, ws, source] of [["link-file", "link-owner", null, "file_manager"], ["link-foreign", "link-other", null, "file_manager"], ["link-team-file", "link-owner", "link-team", "file_manager"], ["link-note-file", "link-owner", null, null]] as const) {
    db.prepare(`INSERT INTO attachments (id,noteId,userId,filename,mimeType,size,path,workspaceId,uploadSource) VALUES (?,?,?,'test.png','image/png',4,'retained.png',?,?)`).run(id, `${user}-note`, user, ws, source);
  }
});
test.after(() => { schema?.closeDb(); fs.rmSync(directory, { recursive: true, force: true }); });
test("inserting reuses the canonical attachment ID without copying or prematurely indexing a reference", async () => {
  const db = schema.getDb();
  const before = db.prepare("SELECT * FROM attachments").all();
  for (const id of ["link-file", "link-note-file"]) {
    const response = await req(`${id}/prepare-insert`, { noteId: "link-owner-note" });
    assert.equal(response.status, 200, await response.clone().text());
    const item = await response.json() as any;
    assert.equal(item.id, id);
    assert.equal(item.url, `/api/attachments/${id}`);
    assert.equal(item.filename, "test.png");
  }
  assert.deepEqual(db.prepare("SELECT * FROM attachments").all(), before);
  assert.equal((db.prepare("SELECT COUNT(*) n FROM attachment_references").get() as any).n, 0);
});
test("insertion rejects foreign files, cross-space reuse, read-only and trashed targets without writes", async () => {
  const db = schema.getDb();
  const before = db.prepare("SELECT * FROM attachments").all();
  assert.equal((await req("link-file/prepare-insert", { noteId: "link-other-note" })).status, 403);
  assert.equal((await req("link-foreign/prepare-insert", { noteId: "link-owner-note" })).status, 404);
  for (const [id, noteId] of [["link-file", "link-team-note"], ["link-team-file", "link-owner-note"]]) {
    const response = await req(`${id}/prepare-insert`, { noteId });
    assert.equal(response.status, 409);
    assert.equal((await response.json() as any).code, "FILE_SCOPE_MISMATCH");
  }
  assert.equal((await req("link-team-file/prepare-insert", { noteId: "link-team-note" })).status, 200);
  db.prepare("UPDATE notes SET isTrashed=1 WHERE id='link-owner-note'").run();
  assert.equal((await req("link-file/prepare-insert", { noteId: "link-owner-note" })).status, 403);
  db.prepare("UPDATE notes SET isTrashed=0 WHERE id='link-owner-note'").run();
  assert.deepEqual(db.prepare("SELECT * FROM attachments").all(), before);
});
test("normal note indexing yields authorized reverse references and removes the reference on ordinary editing", async () => {
  const { syncReferences } = await import("../src/lib/attachmentRefs");
  const db = schema.getDb();
  // Real attachment extractor accepts UUIDs used by uploads.
  const id = "d0000000-0000-4000-8000-000000000001";
  db.prepare("INSERT INTO attachments (id,noteId,userId,filename,mimeType,size,path,uploadSource) VALUES (?,'link-owner-note','link-owner','image.png','image/png',4,'retained.png','file_manager')").run(id);
  for (const content of [`![Image](/api/attachments/${id})`, JSON.stringify({ type: "doc", content: [{ type: "image", attrs: { src: `/api/attachments/${id}` } }] })]) {
    db.transaction(() => { db.prepare("UPDATE notes SET content=? WHERE id='link-owner-note'").run(content); syncReferences(db, "link-owner-note", content); })();
    const response = await app.request(`/api/files/${id}`, { headers: { "X-User-Id": "link-owner" } });
    const detail = await response.json() as any;
    assert.deepEqual(detail.references.map((r: any) => r.id), ["link-owner-note"]);
    assert.equal((await app.request(`/api/files/${id}`, { headers: { "X-User-Id": "link-other" } })).status, 404);
  }
  db.transaction(() => { db.prepare("UPDATE notes SET content='' WHERE id='link-owner-note'").run(); syncReferences(db, "link-owner-note", ""); })();
  assert.equal((db.prepare("SELECT COUNT(*) n FROM attachment_references WHERE attachmentId=?").get(id) as any).n, 0);
});

test("Yjs saves and removes attachment reverse references with the persisted document", async () => {
  const Y = await import("yjs");
  const yjs = await import("../src/services/yjs");
  const db = schema.getDb(), noteId = "link-owner-note";
  const attachmentId = "d0000000-0000-4000-8000-000000000001";
  const client = new Y.Doc();
  try {
    const joined = yjs.yJoin(noteId, "link-owner");
    Y.applyUpdate(client, Buffer.from(joined.stateBase64, "base64"));
    for (const content of [`![Reused](/api/attachments/${attachmentId})`, "Removed image"]) {
      const vector = Y.encodeStateVector(client), text = client.getText("content");
      client.transact(() => { text.delete(0, text.length); text.insert(0, content); });
      assert.equal(yjs.yApplyUpdate(noteId, Buffer.from(Y.encodeStateAsUpdate(client, vector)).toString("base64"), "link-owner"), "ok");
      yjs.yFlush(noteId);
      assert.equal((db.prepare("SELECT content FROM notes WHERE id=?").get(noteId) as any).content, content);
      assert.equal((db.prepare("SELECT COUNT(*) n FROM attachment_references WHERE attachmentId=? AND noteId=?").get(attachmentId, noteId) as any).n, content.startsWith("!") ? 1 : 0);
    }
  } finally { client.destroy(); yjs.yDestroyDoc(noteId); }
});

test("a failed collaborative reference write rolls back the note projection and remains retryable", async () => {
  const Y = await import("yjs"), yjs = await import("../src/services/yjs");
  const db = schema.getDb(), noteId = "link-owner-note", client = new Y.Doc();
  const before = db.prepare("SELECT content,version FROM notes WHERE id=?").get(noteId);
  try {
    const joined = yjs.yJoin(noteId, "link-owner"); Y.applyUpdate(client, Buffer.from(joined.stateBase64, "base64"));
    db.exec("CREATE TRIGGER fail_link_index BEFORE INSERT ON attachment_references BEGIN SELECT RAISE(ABORT,'index failure'); END");
    const text = client.getText("content"), vector = Y.encodeStateVector(client);
    text.insert(0, "![Retained](/api/attachments/d0000000-0000-4000-8000-000000000001)\n");
    assert.equal(yjs.yApplyUpdate(noteId, Buffer.from(Y.encodeStateAsUpdate(client, vector)).toString("base64"), "link-owner"), "ok");
    yjs.yFlush(noteId);
    assert.deepEqual(db.prepare("SELECT content,version FROM notes WHERE id=?").get(noteId), before);
    db.exec("DROP TRIGGER fail_link_index");
    const next = Y.encodeStateVector(client); text.insert(text.length, " retry");
    assert.equal(yjs.yApplyUpdate(noteId, Buffer.from(Y.encodeStateAsUpdate(client, next)).toString("base64"), "link-owner"), "ok");
    yjs.yFlush(noteId);
    assert.equal((db.prepare("SELECT content FROM notes WHERE id=?").get(noteId) as any).content, text.toString());
    assert.equal((db.prepare("SELECT COUNT(*) n FROM attachment_references WHERE noteId=?").get(noteId) as any).n, 1);
  } finally { db.exec("DROP TRIGGER IF EXISTS fail_link_index"); client.destroy(); yjs.yDestroyDoc(noteId); }
});
