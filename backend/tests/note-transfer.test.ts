import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before, beforeEach } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-note-transfer-"));
process.env.DB_PATH = path.join(tempDir, "test.db");
process.env.ELECTRON_USER_DATA = tempDir;
process.env.JWT_SECRET = "note-transfer-test-secret";

let closeDb: () => void;
let db: any;
let previewNoteTransfer: (input: any) => Promise<any>;
let executeNoteTransfer: (input: any) => Promise<any>;
let NoteTransferError: any;
let getAttachmentsDir: () => string;

const NOTE_ONE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NOTE_TWO = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ATTACHMENT = "11111111-1111-4111-8111-111111111111";

before(async () => {
  const schema = await import("../src/db/schema.js");
  const audit = await import("../src/services/audit.js");
  const transfer = await import("../src/services/noteTransfer.js");
  const storage = await import("../src/services/attachment-storage.js");

  closeDb = schema.closeDb;
  db = schema.getDb();
  previewNoteTransfer = transfer.previewNoteTransfer;
  executeNoteTransfer = transfer.executeNoteTransfer;
  NoteTransferError = transfer.NoteTransferError;
  getAttachmentsDir = storage.getAttachmentsDir;
  audit.initAuditTables();
});

function resetDb() {
  db.pragma("foreign_keys = OFF");
  for (const table of [
    "audit_logs", "note_links", "attachment_references", "note_tags", "tags",
    "attachments", "notes", "notebooks", "workspace_members", "workspaces", "users",
  ]) {
    try { db.prepare(`DELETE FROM ${table}`).run(); } catch { /* optional table */ }
  }
  db.pragma("foreign_keys = ON");
  fs.rmSync(getAttachmentsDir(), { recursive: true, force: true });
  fs.mkdirSync(getAttachmentsDir(), { recursive: true });
}

function seedUser(id: string, username = id) {
  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, 'x')").run(id, username);
}

function seedWorkspace(id: string, ownerId: string, role: "owner" | "admin" | "editor" = "owner") {
  db.prepare("INSERT INTO workspaces (id, name, ownerId) VALUES (?, ?, ?)").run(id, id, ownerId);
  db.prepare("INSERT INTO workspace_members (workspaceId, userId, role) VALUES (?, ?, ?)").run(id, ownerId, role);
}

function seedNotebook(id: string, userId: string, workspaceId: string | null, name = id) {
  db.prepare("INSERT INTO notebooks (id, userId, workspaceId, name) VALUES (?, ?, ?, ?)")
    .run(id, userId, workspaceId, name);
}

function seedNote(input: {
  id: string; userId: string; workspaceId: string | null; notebookId: string;
  title?: string; content?: string; version?: number; locked?: boolean;
}) {
  db.prepare(`
    INSERT INTO notes (
      id, userId, workspaceId, notebookId, title, content, contentText,
      contentFormat, version, isLocked
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'tiptap', ?, ?)
  `).run(
    input.id,
    input.userId,
    input.workspaceId,
    input.notebookId,
    input.title || input.id,
    input.content || JSON.stringify({ type: "doc", content: [] }),
    input.title || input.id,
    input.version || 1,
    input.locked ? 1 : 0,
  );
}

function seedAttachment(noteId: string, userId: string, workspaceId: string | null, id: string, body = "file") {
  const rel = `2026/07/${id}.txt`;
  const abs = path.join(getAttachmentsDir(), rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
  db.prepare(`
    INSERT INTO attachments (
      id, noteId, userId, workspaceId, filename, mimeType, size, path, uploadSource
    ) VALUES (?, ?, ?, ?, ?, 'text/plain', ?, ?, 'test')
  `).run(id, noteId, userId, workspaceId, `${id}.txt`, Buffer.byteLength(body), rel);
}

beforeEach(resetDb);

after(() => {
  closeDb?.();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("preview rejects a mixed-source batch", async () => {
  seedUser("u1");
  seedWorkspace("w1", "u1");
  seedNotebook("p", "u1", null);
  seedNotebook("team", "u1", "w1");
  seedNote({ id: "personal-note", userId: "u1", workspaceId: null, notebookId: "p" });
  seedNote({ id: "team-note", userId: "u1", workspaceId: "w1", notebookId: "team" });

  await assert.rejects(
    () => previewNoteTransfer({
      actorUserId: "u1",
      sourceNoteIds: ["personal-note", "team-note"],
      targetWorkspaceId: "w1",
      targetNotebookId: "team",
      mode: "copy",
    }),
    (error: unknown) => error instanceof NoteTransferError && error.code === "MIXED_SOURCE_WORKSPACES",
  );
});

test("copies a personal batch to a team with new ids, attachments, tags and internal links", async () => {
  seedUser("u1");
  seedWorkspace("w1", "u1");
  seedNotebook("personal", "u1", null);
  seedNotebook("target", "u1", "w1");
  seedNote({
    id: NOTE_ONE, userId: "u1", workspaceId: null, notebookId: "personal",
    title: "One", content: `note://${NOTE_TWO} /api/attachments/${ATTACHMENT}`,
  });
  seedNote({ id: NOTE_TWO, userId: "u1", workspaceId: null, notebookId: "personal", title: "Two" });
  seedAttachment(NOTE_ONE, "u1", null, ATTACHMENT, "hello");
  db.prepare("INSERT INTO tags (id, userId, workspaceId, name, color) VALUES ('tag-1', 'u1', NULL, '迁移', '#123456')").run();
  db.prepare("INSERT INTO note_tags (noteId, tagId) VALUES (?, 'tag-1')").run(NOTE_ONE);

  const preview = await previewNoteTransfer({
    actorUserId: "u1", sourceNoteIds: [NOTE_ONE, NOTE_TWO], targetWorkspaceId: "w1",
    targetNotebookId: "target", mode: "copy",
  });
  assert.equal(preview.canExecute, true);
  assert.equal(preview.noteCount, 2);
  assert.equal(preview.attachmentCount, 1);
  assert.equal(preview.internalNoteLinkCount, 1);

  const result = await executeNoteTransfer({
    actorUserId: "u1", sourceNoteIds: [NOTE_ONE, NOTE_TWO], targetWorkspaceId: "w1",
    targetNotebookId: "target", mode: "copy", expectedVersions: preview.sourceVersions,
  });

  assert.equal(result.copiedNoteCount, 2);
  assert.equal(result.copiedAttachmentCount, 1);
  assert.equal(result.internalNoteLinkCount, 1);
  const one = result.items.find((item: any) => item.sourceNoteId === NOTE_ONE)!;
  const two = result.items.find((item: any) => item.sourceNoteId === NOTE_TWO)!;
  assert.notEqual(one.targetNoteId, NOTE_ONE);
  const copiedOne = db.prepare("SELECT * FROM notes WHERE id = ?").get(one.targetNoteId) as any;
  assert.equal(copiedOne.workspaceId, "w1");
  assert.equal(copiedOne.notebookId, "target");
  assert.match(copiedOne.content, new RegExp(`note://${two.targetNoteId}`));
  assert.doesNotMatch(copiedOne.content, new RegExp(ATTACHMENT));

  const copiedAttachment = db.prepare("SELECT * FROM attachments WHERE noteId = ?").get(one.targetNoteId) as any;
  assert.ok(copiedAttachment);
  assert.equal(copiedAttachment.workspaceId, "w1");
  assert.equal(fs.readFileSync(path.join(getAttachmentsDir(), copiedAttachment.path), "utf8"), "hello");
  assert.equal((db.prepare("SELECT COUNT(*) AS c FROM note_tags WHERE noteId = ?").get(one.targetNoteId) as any).c, 1);
  assert.equal((db.prepare("SELECT isTrashed FROM notes WHERE id = ?").get(NOTE_ONE) as any).isTrashed, 0);
});

test("moves a team note to personal only after the target copy verifies", async () => {
  seedUser("u1");
  seedWorkspace("w1", "u1");
  seedNotebook("source", "u1", "w1");
  seedNotebook("personal", "u1", null);
  seedNote({ id: "team-note", userId: "u1", workspaceId: "w1", notebookId: "source", version: 7 });

  const preview = await previewNoteTransfer({
    actorUserId: "u1", sourceNoteIds: ["team-note"], targetWorkspaceId: null,
    targetNotebookId: "personal", mode: "move",
  });
  assert.equal(preview.canExecute, true);
  assert.deepEqual(preview.sourceVersions, { "team-note": 7 });

  const result = await executeNoteTransfer({
    actorUserId: "u1", sourceNoteIds: ["team-note"], targetWorkspaceId: null,
    targetNotebookId: "personal", mode: "move", expectedVersions: preview.sourceVersions,
  });
  assert.equal(result.movedSourceNoteCount, 1);
  const source = db.prepare("SELECT isTrashed, version FROM notes WHERE id = 'team-note'").get() as any;
  assert.equal(source.isTrashed, 1);
  assert.equal(source.version, 8);
  const target = db.prepare("SELECT workspaceId, notebookId, isTrashed FROM notes WHERE id = ?")
    .get(result.items[0].targetNoteId) as any;
  assert.equal(target.workspaceId, null);
  assert.equal(target.notebookId, "personal");
  assert.equal(target.isTrashed, 0);
});

test("blocks move when an attachment object is missing and leaves the source untouched", async () => {
  seedUser("u1");
  seedWorkspace("w1", "u1");
  seedNotebook("personal", "u1", null);
  seedNotebook("target", "u1", "w1");
  seedNote({ id: "n1", userId: "u1", workspaceId: null, notebookId: "personal", version: 3 });
  db.prepare(`
    INSERT INTO attachments (
      id, noteId, userId, workspaceId, filename, mimeType, size, path, uploadSource
    ) VALUES ('missing-att', 'n1', 'u1', NULL, 'missing.txt', 'text/plain', 1, 'missing/file.txt', 'test')
  `).run();

  const preview = await previewNoteTransfer({
    actorUserId: "u1", sourceNoteIds: ["n1"], targetWorkspaceId: "w1",
    targetNotebookId: "target", mode: "move",
  });
  assert.equal(preview.canExecute, false);
  assert.ok(preview.blockers.some((item: any) => item.code === "ATTACHMENT_FILE_MISSING"));
  await assert.rejects(
    () => executeNoteTransfer({
      actorUserId: "u1", sourceNoteIds: ["n1"], targetWorkspaceId: "w1",
      targetNotebookId: "target", mode: "move", expectedVersions: preview.sourceVersions,
    }),
    NoteTransferError,
  );
  assert.equal((db.prepare("SELECT isTrashed FROM notes WHERE id = 'n1'").get() as any).isTrashed, 0);
  assert.equal((db.prepare("SELECT COUNT(*) AS c FROM notes WHERE notebookId = 'target'").get() as any).c, 0);
});
