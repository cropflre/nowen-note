import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type Database from "better-sqlite3";
import type { Hono } from "hono";
import type { KnowledgeTreeNode } from "../src/services/knowledgeTree.js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-shared-templates-"));
process.env.DB_PATH = path.join(tempDir, "templates.db");
process.env.ELECTRON_USER_DATA = tempDir;

let db: Database.Database;
let closeDatabase: () => void;
let app: Hono;
let shared: KnowledgeTreeNode;
let nested: KnowledgeTreeNode;
let privateFolder: KnowledgeTreeNode;
let foreignFolder: KnowledgeTreeNode;
let personalFolder: KnowledgeTreeNode;
let source: KnowledgeTreeNode;
let templateId: string;
const attachmentBytes = Buffer.from("shared template attachment bytes");
const sourceAttachmentId = "72664587-acce-4587-a639-65abc16fabb8";

function request(url: string, userId = "guest", body?: unknown, method = "POST") {
  return app.request(url, {
    method: body === undefined && method === "POST" ? "GET" : method,
    headers: { "X-User-Id": userId, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

test.before(async () => {
  await import("../src/runtime/knowledge-tree-migration-bootstrap.js");
  const schema = await import("../src/db/schema.js");
  db = schema.getDb();
  closeDatabase = schema.closeDb;
  app = (await import("../src/routes/note-templates.js")).default;
  const { createKnowledgeChild } = await import("../src/services/knowledgeTree.js");
  const { setKnowledgeNodeRole } = await import("../src/services/knowledgeCapabilities.js");
  const { writeAttachmentObject } = await import("../src/services/attachment-storage.js");
  for (const userId of ["owner", "guest", "viewer", "outsider"]) {
    db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, 'hash')").run(userId, userId);
  }
  for (const workspaceId of ["smt", "other"]) {
    db.prepare("INSERT INTO workspaces (id, name, ownerId) VALUES (?, ?, 'owner')").run(workspaceId, workspaceId);
    db.prepare("INSERT INTO workspace_members (workspaceId, userId, role) VALUES (?, 'owner', 'owner')").run(workspaceId);
  }
  const folder = (workspaceId: string | null, parentId: string | null, title: string) => createKnowledgeChild({
    actorUserId: "owner", workspaceId, parentId, title, nodeType: "folder", db,
  });
  shared = folder("smt", null, "Shared SMT");
  nested = folder("smt", shared.id, "Inherited edit target");
  privateFolder = folder("smt", null, "Private sibling");
  foreignFolder = folder("other", null, "Other space");
  personalFolder = folder(null, null, "Owner personal folder");
  for (const nodeId of [shared.id, personalFolder.id]) {
    setKnowledgeNodeRole({ nodeId, targetUserId: "guest", rolePreset: "editor", actorUserId: "owner", db });
  }
  setKnowledgeNodeRole({ nodeId: shared.id, targetUserId: "viewer", rolePreset: "readonly", actorUserId: "owner", db });
  source = createKnowledgeChild({
    actorUserId: "owner", workspaceId: "smt", parentId: privateFolder.id,
    nodeType: "markdown", title: "Private source document", db,
  });
  await writeAttachmentObject("fixtures/template.txt", attachmentBytes, "text/plain");
  db.prepare(`INSERT INTO attachments (id, noteId, userId, workspaceId, filename, mimeType, size, path)
    VALUES (?, ?, 'owner', 'smt', 'template.txt', 'text/plain', ?, 'fixtures/template.txt')`)
    .run(sourceAttachmentId, source.resourceId, attachmentBytes.length);
  db.prepare("UPDATE notes SET content = ?, contentText = ? WHERE id = ?")
    .run(`# SMT record\n\n[attachment](/api/attachments/${sourceAttachmentId})`, "SMT record", source.resourceId);
  const saved = await request(`/from-note/${source.resourceId}?workspaceId=smt`, "owner", { name: "SMT record" });
  assert.equal(saved.status, 201);
  templateId = (await saved.json() as { template: { id: string } }).template.id;
  db.prepare(`INSERT INTO note_templates (id, createdBy, name, content, contentFormat)
    VALUES ('owner-personal-template', 'owner', 'Private personal template', '# Private', 'markdown')`).run();
});

test.after(() => {
  closeDatabase?.();
  fs.rmSync(tempDir, { recursive: true, force: true });
  delete process.env.DB_PATH;
  delete process.env.ELECTRON_USER_DATA;
});

test("DCC-006: folder editors list workspace templates and create complete independent notes in inherited targets", async () => {
  const list = await request(`/?parentId=${nested.id}`);
  assert.equal(list.status, 200);
  const templates = (await list.json() as { templates: Array<{ id: string; canDelete: boolean; workspaceId: string }> }).templates;
  assert.deepEqual(templates.map((item) => item.id), [templateId]);
  assert.equal(templates[0].workspaceId, "smt");
  assert.equal(templates[0].canDelete, false);
  const created = await request(`/${templateId}/create-note`, "guest", { parentId: nested.id });
  assert.equal(created.status, 201);
  const result = await created.json() as { noteId: string; node: KnowledgeTreeNode };
  assert.equal(result.node.parentId, nested.id);
  assert.equal(result.node.workspaceId, "smt");
  const { resolveNotePermission, hasPermission } = await import("../src/middleware/acl.js");
  assert.equal(resolveNotePermission(source.resourceId, "guest").permission, null);
  assert.equal(hasPermission(resolveNotePermission(result.noteId, "guest").permission, "write"), true);
  const note = db.prepare("SELECT content, contentText, workspaceId, notebookId FROM notes WHERE id = ?")
    .get(result.noteId) as { content: string; contentText: string; workspaceId: string; notebookId: string };
  const assets = db.prepare("SELECT id, path, size, workspaceId FROM attachments WHERE noteId = ?")
    .all(result.noteId) as Array<{ id: string; path: string; size: number; workspaceId: string }>;
  assert.equal(note.workspaceId, "smt");
  assert.equal(note.notebookId, nested.resourceId);
  assert.equal(note.contentText, "SMT record");
  assert.equal(assets.length, 1);
  assert.equal(assets[0].workspaceId, "smt");
  assert.equal(assets[0].size, attachmentBytes.length);
  assert.match(note.content, new RegExp(`/api/attachments/${assets[0].id}`));
  assert.doesNotMatch(note.content, /note-templates\/assets/);
  assert.equal(note.content.includes(sourceAttachmentId), false);
  const { readAttachmentObject } = await import("../src/services/attachment-storage.js");
  assert.deepEqual(await readAttachmentObject(assets[0].path), attachmentBytes);
  const snapshot = db.prepare("SELECT path FROM note_template_attachments WHERE templateId = ?")
    .get(templateId) as { path: string };
  assert.notEqual(assets[0].path, snapshot.path);
  assert.notEqual(assets[0].path, "fixtures/template.txt");
});

test("DCC-006: template use rejects readonly, unrelated, deleted and mismatched targets without writing notes", async () => {
  const before = (db.prepare("SELECT COUNT(*) AS count FROM notes").get() as { count: number }).count;
  for (const userId of ["viewer", "outsider"]) {
    assert.equal((await request(`/?parentId=${nested.id}`, userId)).status, 403);
    assert.equal((await request(`/${templateId}/create-note`, userId, { parentId: nested.id })).status, 403);
  }
  assert.equal((await request("/?workspaceId=smt")).status, 403);
  assert.equal((await request(`/${templateId}/create-note?workspaceId=smt`, "guest", { parentId: null })).status, 403);
  assert.equal((await request(`/?parentId=${privateFolder.id}`)).status, 403);
  assert.equal((await request(`/${templateId}/create-note`, "guest", { parentId: privateFolder.id })).status, 403);
  assert.equal((await request(`/?workspaceId=other&parentId=${nested.id}`)).status, 409);
  assert.equal((await request(`/?workspaceId=personal&parentId=${nested.id}`)).status, 409);
  assert.equal((await request(`/${templateId}/create-note?workspaceId=other`, "guest", { parentId: nested.id })).status, 409);
  assert.equal((await request(`/${templateId}/create-note?workspaceId=smt`, "owner", { parentId: foreignFolder.id })).status, 409);
  db.prepare("UPDATE notebooks SET isDeleted = 1 WHERE id = ?").run(nested.resourceId);
  assert.equal((await request(`/?parentId=${nested.id}`)).status, 404);
  assert.equal((await request(`/${templateId}/create-note`, "guest", { parentId: nested.id })).status, 404);
  db.prepare("UPDATE notebooks SET isDeleted = 0 WHERE id = ?").run(nested.resourceId);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM notes").get() as { count: number }).count, before);
});

test("DCC-006: folder sharing does not grant template management or private personal templates and revocation takes effect immediately", async () => {
  assert.equal((await request(`/from-note/${source.resourceId}?workspaceId=smt`, "guest", { name: "Guest template" })).status, 403);
  assert.equal((await request(`/${templateId}?workspaceId=smt`, "guest", undefined, "DELETE")).status, 403);
  const personal = await request(`/?parentId=${personalFolder.id}`);
  assert.equal(personal.status, 200);
  assert.deepEqual((await personal.json() as { templates: unknown[] }).templates, []);
  assert.equal((await request("/owner-personal-template/create-note", "guest", { parentId: personalFolder.id })).status, 403);
  const { clearKnowledgeNodeRole } = await import("../src/services/knowledgeCapabilities.js");
  clearKnowledgeNodeRole({ nodeId: shared.id, targetUserId: "guest", actorUserId: "owner", db });
  const before = (db.prepare("SELECT COUNT(*) AS count FROM notes").get() as { count: number }).count;
  assert.equal((await request(`/?parentId=${nested.id}`)).status, 403);
  assert.equal((await request(`/${templateId}/create-note`, "guest", { parentId: nested.id })).status, 403);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM notes").get() as { count: number }).count, before);
  assert.equal((await request("/?workspaceId=smt", "owner")).status, 200);
  assert.ok(db.prepare("SELECT 1 FROM note_templates WHERE id = ?").get(templateId));
});
