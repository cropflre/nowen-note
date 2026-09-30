import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type Database from "better-sqlite3";
import { Hono } from "hono";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-note-duplicates-"));
process.env.DB_PATH = path.join(directory, "test.db");
process.env.ELECTRON_USER_DATA = directory;
process.env.NOWEN_YJS_SUBDOCUMENTS = "1";

let db: Database.Database;
let closeDb: () => void;
let app: Hono;
let tree: typeof import("../src/services/knowledgeTree.js");
let capabilities: typeof import("../src/services/knowledgeCapabilities.js");
let duplicates: typeof import("../src/services/noteDuplicates.js");

test.before(async () => {
  await import("../src/runtime/knowledge-tree-migration-bootstrap.js");
  const schema = await import("../src/db/schema.js");
  db = schema.getDb();
  closeDb = schema.closeDb;
  tree = await import("../src/services/knowledgeTree.js");
  capabilities = await import("../src/services/knowledgeCapabilities.js");
  duplicates = await import("../src/services/noteDuplicates.js");
  const { initAuditTables } = await import("../src/services/audit.js");
  initAuditTables();
  const { default: router } = await import("../src/routes/notes.js");
  app = new Hono();
  app.route("/notes", router);
  for (const user of ["owner", "editor", "readonly", "stranger"]) {
    db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, 'hash')").run(user, user);
  }
  db.prepare("INSERT INTO workspaces (id, name, ownerId) VALUES ('team', 'Team', 'owner')").run();
  db.prepare("INSERT INTO workspaces (id, name, ownerId) VALUES ('other', 'Other', 'stranger')").run();
  db.prepare("INSERT INTO workspace_members (workspaceId, userId, role) VALUES ('other', 'stranger', 'owner')").run();
  for (const [user, role] of [["owner", "owner"], ["editor", "editor"], ["readonly", "viewer"]]) {
    db.prepare("INSERT INTO workspace_members (workspaceId, userId, role) VALUES ('team', ?, ?)").run(user, role);
  }
});

test.after(() => {
  closeDb?.();
  fs.rmSync(directory, { recursive: true, force: true });
});

function create(title: string, parentId: string | null = null, workspaceId: string | null = null, nodeType: "note" | "markdown" | "folder" = "markdown") {
  return tree.createKnowledgeChild({ actorUserId: "owner", title, parentId, workspaceId, nodeType, db });
}

function grant(nodeId: string, user: string, rolePreset: "editor" | "readonly") {
  capabilities.setKnowledgeNodeRole({ nodeId, targetUserId: user, rolePreset, actorUserId: "owner", db });
}

async function request(noteId: string, body?: unknown, user = "owner") {
  const response = await app.request(`/notes/${noteId}/duplicate`, {
    method: "POST",
    headers: { "X-User-Id": user, "Content-Type": "application/json", Accept: "application/vnd.nowen.internal-note+json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() as any };
}

function rowCount(table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
}

test("duplicate API defaults to sibling and creates rich-text/Markdown children directly", async () => {
  const folder = create("API parent", null, null, "folder");
  for (const format of ["note", "markdown"] as const) {
    const source = create(`API ${format}`, folder.id, null, format);
    const legacy = await request(source.resourceId);
    assert.equal(legacy.status, 201);
    assert.equal(legacy.body.treeParentId, folder.id);
    const sibling = await request(source.resourceId, { placement: "sibling" });
    assert.equal(sibling.status, 201);
    assert.equal(sibling.body.treeParentId, folder.id);
    const child = await request(source.resourceId, { placement: "child" });
    assert.equal(child.status, 201);
    assert.equal(child.body.treeParentId, source.id);
    assert.equal(child.body.contentFormat, format === "markdown" ? "markdown" : "tiptap-json");
    if (format === "note") {
      assert.deepEqual(JSON.parse(child.body.content), { type: "doc", content: [] });
      assert.equal((db.prepare("SELECT content FROM notes WHERE id = ?").get(source.resourceId) as any).content, "{}");
    }
    const history = db.prepare("SELECT action, toParentId FROM knowledge_tree_history WHERE nodeId = ?").all(child.body.treeNodeId);
    assert.deepEqual(history, [{ action: "create", toParentId: source.id }]);
  }
});

test("duplicate numbering uses the destination directory, including concurrent child copies", async () => {
  const source = create("Numbering");
  create("Numbering（副本）");
  const first = await duplicates.duplicateNote({ userId: "owner", noteId: source.resourceId, placement: "child" });
  assert.equal(first.note.title, "Numbering（副本）");
  const copies = await Promise.all([1, 2].map(() => duplicates.duplicateNote({ userId: "owner", noteId: source.resourceId, placement: "child" })));
  assert.deepEqual(copies.map((copy) => copy.note.title), ["Numbering（副本 2）", "Numbering（副本 3）"]);
  const sibling = await duplicates.duplicateNote({ userId: "owner", noteId: source.resourceId });
  assert.equal(sibling.note.title, "Numbering（副本 2）");
});

test("shared editors create child copies without move/delete rights, including a shared root document", async () => {
  const folder = create("Shared folder", null, null, "folder");
  grant(folder.id, "editor", "editor");
  for (const source of [create("Shared nested", folder.id), create("Shared root")]) {
    grant(source.id, "editor", "editor");
    const before = rowCount("notes");
    const child = await request(source.resourceId, { placement: "child" }, "editor");
    assert.equal(child.status, 201);
    assert.equal(child.body.treeParentId, source.id);
    assert.equal(rowCount("notes"), before + 1);
    const access = capabilities.resolveKnowledgeNodeAccess(child.body.treeNodeId, "editor", db);
    assert.equal(access.capabilities.canCreate, true);
    assert.equal(access.capabilities.canMove, false);
    assert.equal(access.capabilities.canDelete, false);
    assert.equal(child.body.userId, "owner", "personal copies retain the shared tree owner");
    if (source.parentId === null) {
      const sibling = await request(source.resourceId, undefined, "editor");
      assert.equal(sibling.status, 403);
      assert.equal(sibling.body.code, "NOTE_DUPLICATE_PARENT_FORBIDDEN");
    }
  }
});

test("child creation checks source canCreate rather than sibling creation permission", async () => {
  const folder = create("Restricted sibling", null, null, "folder");
  const source = create("Granted document", folder.id);
  grant(source.id, "editor", "editor");
  assert.equal((await request(source.resourceId, undefined, "editor")).status, 403);
  assert.equal((await request(source.resourceId, { placement: "child" }, "editor")).status, 201);
  const readonly = create("Readonly source");
  grant(readonly.id, "readonly", "readonly");
  const before = rowCount("notes");
  assert.equal((await request(readonly.resourceId, { placement: "child" }, "readonly")).status, 403);
  assert.equal((await request(readonly.resourceId, { placement: "child" }, "stranger")).status, 403);
  assert.equal(rowCount("notes"), before);
});

test("workspace copies inherit ACL and cannot be redirected into another workspace", async () => {
  const source = create("Team source", null, "team");
  const other = tree.createKnowledgeChild({ actorUserId: "stranger", title: "Other workspace destination", parentId: null, workspaceId: "other", nodeType: "markdown", db });
  const child = await request(source.resourceId, { placement: "child", targetParentId: other.id, workspaceId: "other" }, "editor");
  assert.equal(child.status, 201);
  assert.equal(child.body.workspaceId, "team");
  assert.equal(child.body.treeParentId, source.id);
  const node = db.prepare("SELECT scopeKey FROM knowledge_tree_nodes WHERE id = ?").get(child.body.treeNodeId) as { scopeKey: string };
  assert.equal(node.scopeKey, "workspace:team");
  assert.equal(capabilities.resolveKnowledgeNodeAccess(child.body.treeNodeId, "editor", db).capabilities.canMove, false);
  assert.equal((await request(source.resourceId, { placement: "child" }, "readonly")).status, 403);
  assert.equal((await request(source.resourceId, { placement: "child" }, "stranger")).status, 403);
});

test("permissions and source placement are rechecked after asynchronous attachment copying", async () => {
  const source = create("Permission revoked");
  grant(source.id, "editor", "editor");
  const before = rowCount("notes");
  const pending = duplicates.duplicateNote({ userId: "editor", noteId: source.resourceId, placement: "child" });
  grant(source.id, "editor", "readonly");
  await assert.rejects(pending, (error: any) => error.status === 403 && error.code === "NOTE_DUPLICATE_PARENT_FORBIDDEN");
  assert.equal(rowCount("notes"), before);

  const moving = create("Source moved");
  const destination = create("Moved parent", null, null, "folder");
  const pendingMove = duplicates.duplicateNote({ userId: "owner", noteId: moving.resourceId, placement: "child" });
  tree.moveKnowledgeNode({ actorUserId: "owner", nodeId: moving.id, parentId: destination.id, db });
  await assert.rejects(pendingMove, (error: any) => error.status === 409 && error.code === "NOTE_DUPLICATE_SOURCE_CHANGED");
});

test("invalid placement, locked and trashed sources are rejected without creating copies", async () => {
  const source = create("Boundaries");
  const before = rowCount("notes");
  for (const body of [{ placement: "elsewhere" }, { placement: null }, null, []]) {
    const response = await request(source.resourceId, body);
    assert.equal(response.status, 400);
    assert.equal(response.body.code, "NOTE_DUPLICATE_PLACEMENT_INVALID");
  }
  const malformed = await app.request(`/notes/${source.resourceId}/duplicate`, { method: "POST", body: "{" });
  assert.equal(malformed.status, 400);
  db.prepare("UPDATE notes SET isLocked = 1 WHERE id = ?").run(source.resourceId);
  assert.equal((await request(source.resourceId, { placement: "child" })).status, 403);
  db.prepare("UPDATE notes SET isLocked = 0, isTrashed = 1 WHERE id = ?").run(source.resourceId);
  assert.equal((await request(source.resourceId, { placement: "child" })).status, 404);
  assert.equal(rowCount("notes"), before);
});

async function sourceWithAttachment(format: "note" | "markdown") {
  const source = create(`Content ${format}`, null, null, format);
  const target = create(`Linked target ${format}`);
  const attachmentId = randomUUID();
  const storage = await import("../src/services/attachment-storage.js");
  const storagePath = `audit/${attachmentId}.png`;
  await storage.writeAttachmentObject(storagePath, Buffer.from("independent attachment"), "image/png");
  db.prepare(`INSERT INTO attachments (id, noteId, userId, filename, mimeType, size, path)
    VALUES (?, ?, 'owner', 'image.png', 'image/png', 22, ?)`).run(attachmentId, source.resourceId, storagePath);
  const content = format === "markdown"
    ? `# Body\n\n![image](/api/attachments/${attachmentId})\n\n[[note:${target.resourceId}|Target]]`
    : JSON.stringify({ type: "doc", content: [
      { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Body" }] },
      { type: "image", attrs: { src: `/api/attachments/${attachmentId}` } },
      { type: "paragraph", content: [{ type: "text", text: `[[note:${target.resourceId}|Target]]` }] },
    ] });
  const { syncNoteBlocks } = await import("../src/lib/noteBlocks.js");
  const { rebuildBlockAuthorityStore } = await import("../src/lib/blockAuthorityStore.js");
  const synced = syncNoteBlocks(db, source.resourceId, content, format === "markdown" ? "markdown" : "tiptap-json");
  db.prepare("UPDATE notes SET content = ?, contentText = ? WHERE id = ?").run(synced.content, synced.contentText, source.resourceId);
  rebuildBlockAuthorityStore(db, source.resourceId, synced.content, format === "markdown" ? "markdown" : "tiptap-json", { noteVersion: 1, operationType: "create" });
  db.prepare("INSERT INTO tags (id, userId, name) VALUES (?, 'owner', ?)").run(source.resourceId, source.resourceId);
  db.prepare("INSERT INTO note_tags (noteId, tagId) VALUES (?, ?)").run(source.resourceId, source.resourceId);
  return { source, target, attachmentId, storagePath, content: synced.content, storage };
}

test("both formats retain content, independent attachments, tags, blocks, links, references and Yjs", async () => {
  for (const format of ["note", "markdown"] as const) {
    const fixture = await sourceWithAttachment(format);
    const copy = await duplicates.duplicateNote({ userId: "owner", noteId: fixture.source.resourceId, placement: "child" });
    const attachment = db.prepare("SELECT id, path FROM attachments WHERE noteId = ?").get(copy.note.id) as { id: string; path: string };
    assert.notEqual(attachment.id, fixture.attachmentId);
    assert.notEqual(attachment.path, fixture.storagePath);
    assert.deepEqual(await fixture.storage.readAttachmentObject(attachment.path), await fixture.storage.readAttachmentObject(fixture.storagePath));
    assert.equal(copy.note.content, fixture.content.replaceAll(fixture.attachmentId, attachment.id));
    assert.equal(copy.tags[0].id, fixture.source.resourceId);
    assert.ok((db.prepare("SELECT COUNT(*) AS count FROM note_blocks_index WHERE noteId = ?").get(copy.note.id) as any).count > 0);
    assert.ok(db.prepare("SELECT noteId FROM note_block_documents WHERE noteId = ?").get(copy.note.id));
    assert.ok(db.prepare("SELECT noteId FROM attachment_references WHERE noteId = ? AND attachmentId = ?").get(copy.note.id, attachment.id));
    assert.ok(db.prepare("SELECT sourceNoteId FROM note_links WHERE sourceNoteId = ? AND targetNoteId = ?").get(copy.note.id, fixture.target.resourceId));
    if (format === "note") assert.ok(db.prepare("SELECT noteId FROM note_y_subdocument_manifests WHERE noteId = ?").get(copy.note.id));
  }
});

test("a failure after attachment and tree creation rolls back all database rows and copied files", async () => {
  const fixture = await sourceWithAttachment("note");
  const tables = ["notes", "knowledge_tree_nodes", "knowledge_tree_history", "attachments", "note_tags", "note_blocks_index", "note_links", "attachment_references", "note_block_documents", "note_block_records"];
  const before = tables.map(rowCount);
  const filesBefore = fs.readdirSync(path.join(directory, "attachments"), { recursive: true }).filter((entry) => fs.statSync(path.join(directory, "attachments", entry.toString())).isFile()).sort();
  db.exec(`CREATE TEMP TRIGGER fail_duplicate_authority BEFORE INSERT ON note_block_documents
    BEGIN SELECT RAISE(ABORT, 'injected duplicate failure'); END;`);
  try {
    await assert.rejects(duplicates.duplicateNote({ userId: "owner", noteId: fixture.source.resourceId, placement: "child" }), /injected duplicate failure/);
  } finally {
    db.exec("DROP TRIGGER fail_duplicate_authority");
  }
  assert.deepEqual(tables.map(rowCount), before);
  const filesAfter = fs.readdirSync(path.join(directory, "attachments"), { recursive: true }).filter((entry) => fs.statSync(path.join(directory, "attachments", entry.toString())).isFile()).sort();
  assert.deepEqual(filesAfter, filesBefore);
  assert.equal((db.prepare("SELECT content FROM notes WHERE id = ?").get(fixture.source.resourceId) as any).content, fixture.content);
});
