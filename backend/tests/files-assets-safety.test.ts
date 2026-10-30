import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Hono } from "hono";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-assets-safety-"));
process.env.DB_PATH = path.join(directory, "test.db");
process.env.ELECTRON_USER_DATA = directory;
let app: Hono;
let schema: typeof import("../src/db/schema");
const owner = "asset-owner";
const other = "asset-other";

function req(url: string, method = "GET", body?: unknown, userId = owner) {
  return app.request(url, { method, headers: { "X-User-Id": userId, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function upload(bytes: string, folderId?: string, workspaceId?: string) {
  const form = new FormData();
  form.set("file", new File([bytes], "sample.txt", { type: "text/plain" }));
  if (folderId) form.set("folderId", folderId);
  return app.request(`/api/files/upload${workspaceId ? `?workspaceId=${workspaceId}` : ""}`, {
    method: "POST", headers: { "X-User-Id": owner }, body: form,
  });
}
test.before(async () => {
  await import("../src/runtime/knowledge-tree-migration-bootstrap");
  schema = await import("../src/db/schema");
  const { default: files } = await import("../src/routes/files");
  const { default: folders } = await import("../src/routes/attachment-folders");
  const { default: attachments } = await import("../src/routes/attachments");
  const { wrapKnowledgeRoute } = await import("../src/runtime/knowledge-tree");
  app = new Hono();
  app.route("/api/files", wrapKnowledgeRoute("/api/files", files));
  app.route("/api/attachment-folders", folders);
  app.route("/api/attachments", attachments);
  const db = schema.getDb();
  for (const id of [owner, other]) db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, 'hash')").run(id, id);
  db.prepare("INSERT INTO workspaces (id, name, ownerId) VALUES ('asset-workspace', 'Team', ?)").run(owner);
  db.prepare("INSERT INTO workspace_members (workspaceId, userId, role) VALUES ('asset-workspace', ?, 'owner')").run(owner);
  for (const id of ["asset-a", "asset-b"]) db.prepare("INSERT INTO attachment_folders (id, userId, name) VALUES (?, ?, ?)").run(id, owner, id);
});
test.after(() => { schema?.closeDb(); fs.rmSync(directory, { recursive: true, force: true }); });

test("duplicate upload reports original location without changing identity, bytes or references", async () => {
  const first = await (await upload("dedup safe bytes", "asset-a")).json() as any;
  const db = schema.getDb();
  const before = db.prepare("SELECT id, folderId, path, noteId, hash, createdAt FROM attachments WHERE id = ?").get(first.id);
  const duplicate = await upload("dedup safe bytes", "asset-b");
  assert.equal(duplicate.status, 200);
  assert.deepEqual(db.prepare("SELECT id, folderId, path, noteId, hash, createdAt FROM attachments WHERE id = ?").get(first.id), before);
  assert.deepEqual(await duplicate.json(), { ...(await (await upload("dedup safe bytes")).json() as any) });
  const payload = await (await upload("dedup safe bytes", "asset-b")).json() as any;
  assert.equal(payload.deduplicated, true);
  assert.equal(payload.folderId, "asset-a");
  assert.equal(payload.folderName, "asset-a");
  const conflict = await req("/api/files/batch-move", "POST", { ids: [first.id], folderId: "asset-b", expectedFolderIds: { [first.id]: null } });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json() as any).code, "FILE_POSITION_CONFLICT");
});

test("workspace files cannot enter personal folders; mixed batches and workspace uploads fail atomically", async () => {
  const personal = await (await upload("personal scope")).json() as any;
  const workspace = await (await upload("workspace scope", undefined, "asset-workspace")).json() as any;
  const move = await req("/api/files/batch-move", "POST", { ids: [personal.id, workspace.id], folderId: "asset-a" });
  assert.equal(move.status, 409);
  assert.equal((await move.json() as any).code, "FILE_SCOPE_MISMATCH");
  const rows = schema.getDb().prepare("SELECT folderId FROM attachments WHERE id IN (?, ?)").all(personal.id, workspace.id) as any[];
  assert.ok(rows.every((row) => row.folderId === null));
  assert.equal((await upload("invalid workspace destination", "asset-a", "asset-workspace")).status, 409);
  const folders = await (await req("/api/attachment-folders?workspaceId=asset-workspace")).json() as any;
  assert.equal(folders.supported, false);
  assert.deepEqual(folders.folders, []);
  assert.equal((await req("/api/attachment-folders?workspaceId=asset-workspace", "POST", { name: "Team folder" })).status, 409);
});

test("read-only workspace uploads are rejected before creating any holder or file", async () => {
  const db = schema.getDb();
  db.prepare("INSERT INTO workspace_members (workspaceId, userId, role) VALUES ('asset-workspace', ?, 'viewer')").run(other);
  const before = db.prepare("SELECT COUNT(*) AS count FROM notes").get();
  const filesBefore = db.prepare("SELECT COUNT(*) AS count FROM attachments").get();
  const form = new FormData();
  form.set("file", new File(["viewer must not write"], "viewer.txt", { type: "text/plain" }));
  const response = await app.request("/api/files/upload?workspaceId=asset-workspace", { method: "POST", headers: { "X-User-Id": other }, body: form });
  assert.equal(response.status, 403);
  assert.equal((await response.json() as any).code, "FORBIDDEN");
  assert.deepEqual(db.prepare("SELECT COUNT(*) AS count FROM notes").get(), before);
  assert.deepEqual(db.prepare("SELECT COUNT(*) AS count FROM attachments").get(), filesBefore);
});

test("explorer filters are server parsed, paginated and scoped", async () => {
  assert.equal((await req("/api/files?fileKind=unknown")).status, 400);
  assert.equal((await req("/api/files?createdAfter=invalid")).status, 400);
  const response = await req("/api/files?fileKind=document&page=1&pageSize=1&sort=name_asc");
  const payload = await response.json() as any;
  assert.equal(payload.items.length, 1);
  assert.equal(payload.items[0].mimeType, "text/plain");
  assert.ok(payload.total > 1);
  const future = await (await req("/api/files?createdAfter=2099-01-01")).json() as any;
  assert.equal(future.total, 0);
  const foreign = await (await req("/api/files?fileKind=document", "GET", undefined, other)).json() as any;
  assert.equal(foreign.total, 0);
});

test("three-level folders reject cycles, missing parents, foreign parents and nonempty deletion", async () => {
  const create = async (name: string, parentId?: string) => {
    const res = await req("/api/attachment-folders", "POST", { name, parentId });
    assert.equal(res.status, 201);
    return await res.json() as any;
  };
  const a = await create("Level 1");
  const b = await create("Level 2", a.id);
  const c = await create("Level 3", b.id);
  for (const parentId of [a.id, c.id]) {
    const response = await req(`/api/attachment-folders/${a.id}`, "PATCH", { parentId });
    assert.equal(response.status, 409);
    assert.equal((await response.json() as any).code, "FOLDER_CYCLE");
  }
  assert.equal((await req(`/api/attachment-folders/${b.id}`, "PATCH", { parentId: "missing" })).status, 404);
  assert.equal((await req(`/api/attachment-folders/${a.id}`, "DELETE")).status, 409);
  assert.equal((schema.getDb().prepare("SELECT parentId FROM attachment_folders WHERE id = ?").get(b.id) as any).parentId, a.id);
  assert.equal((await req(`/api/attachment-folders/${c.id}`, "PATCH", { parentId: null })).status, 200);
  assert.equal((await req(`/api/attachment-folders/${b.id}`, "DELETE")).status, 200);
  assert.equal((await req(`/api/attachment-folders/${a.id}`, "DELETE", undefined, other)).status, 404);
  assert.equal((await req(`/api/attachment-folders/${a.id}`, "DELETE")).status, 200);
  assert.equal((await req(`/api/attachment-folders/${c.id}`, "DELETE")).status, 200);
  const inUse = await (await upload("nonempty folder", "asset-b")).json() as any;
  assert.equal((await req("/api/attachment-folders/asset-b", "DELETE")).status, 409);
  assert.equal((schema.getDb().prepare("SELECT folderId FROM attachments WHERE id = ?").get(inUse.id) as any).folderId, "asset-b");
});

test("single and batch deletion preserve indexed, unindexed and trashed references and active shares", async () => {
  const db = schema.getDb();
  const referenced = await (await upload("referenced bytes")).json() as any;
  const unused = await (await upload("unused bytes")).json() as any;
  const noteId = (db.prepare("SELECT noteId FROM attachments WHERE id = ?").get(referenced.id) as any).noteId;
  db.prepare("INSERT INTO attachment_references (attachmentId, noteId) VALUES (?, ?)").run(referenced.id, noteId);
  db.prepare("UPDATE notes SET isTrashed = 1 WHERE id = ?").run(noteId);
  for (const prefix of ["files", "attachments"]) {
    const response = await req(`/api/${prefix}/${referenced.id}`, "DELETE");
    assert.equal(response.status, prefix === "attachments" ? 403 : 409);
    assert.equal((await response.json() as any).code, prefix === "attachments" ? "FORBIDDEN" : "FILE_IN_USE");
  }
  const batch = await (await req("/api/files/batch-delete", "POST", { ids: [referenced.id, unused.id] })).json() as any;
  assert.equal(batch.deleted, 1);
  assert.equal(batch.failed[0].code, "FILE_IN_USE");
  assert.ok(db.prepare("SELECT 1 FROM attachments WHERE id = ?").get(referenced.id));
  db.prepare("DELETE FROM attachment_references WHERE attachmentId = ?").run(referenced.id);
  db.prepare("UPDATE notes SET content = ? WHERE id = ?").run(`/api/attachments/${referenced.id}`, noteId);
  assert.equal((await req(`/api/files/${referenced.id}`, "DELETE")).status, 409);
  db.prepare("UPDATE notes SET content = '{}' WHERE id = ?").run(noteId);
  const { ensureFileSharesTable } = await import("../src/services/file-shares");
  ensureFileSharesTable();
  db.prepare(`INSERT INTO file_shares (id, token, attachmentId, noteId, ownerId) VALUES ('safety-share', 'safety-token', ?, ?, ?)`)
    .run(referenced.id, noteId, owner);
  const shared = await req(`/api/files/${referenced.id}`, "DELETE");
  assert.equal(shared.status, 409);
  assert.equal((await shared.json() as any).code, "FILE_SHARED");
  db.prepare("UPDATE file_shares SET isActive = 0 WHERE id = 'safety-share'").run();
  assert.equal((await req(`/api/files/${referenced.id}`, "DELETE")).status, 200);
});
