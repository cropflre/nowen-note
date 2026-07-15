import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { Hono } from "hono";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-nb-transfer-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");
process.env.ELECTRON_USER_DATA = tmpDir;

import { getDb } from "../src/db/schema";
import notebooksRouter from "../src/routes/notebooks";
import notesRouter from "../src/routes/notes";
import { initAuditTables } from "../src/services/audit";
import {
  copyPersonalNotebookToWorkspace,
  rewriteAttachmentUrls,
  rewriteInternalNoteLinks,
  WorkspaceNotebookTransferError,
} from "../src/services/workspaceNotebookTransfer";
import { ensureAttachmentsDir, getAttachmentsDir } from "../src/services/attachment-storage";

const USER = "user-transfer";
const OTHER = "other-transfer";
const WS = "ws-transfer";
const WS2 = "ws-transfer-2";

function resetDb() {
  const db = getDb();
  db.exec(`
    DELETE FROM audit_logs;
    DELETE FROM attachment_references;
    DELETE FROM note_links;
    DELETE FROM note_tags;
    DELETE FROM tags;
    DELETE FROM attachments;
    DELETE FROM favorites;
    DELETE FROM notes;
    DELETE FROM notebooks;
    DELETE FROM workspace_members;
    DELETE FROM workspaces;
    DELETE FROM users;
  `);
  const attachmentsDir = ensureAttachmentsDir();
  fs.rmSync(attachmentsDir, { recursive: true, force: true });
  fs.mkdirSync(attachmentsDir, { recursive: true });
}

function seedUsersAndWorkspaces(role: string = "editor") {
  const db = getDb();
  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)").run(USER, USER, "hash");
  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)").run(OTHER, OTHER, "hash");
  db.prepare("INSERT INTO workspaces (id, name, ownerId) VALUES (?, ?, ?)").run(WS, "Team", USER);
  db.prepare("INSERT INTO workspaces (id, name, ownerId) VALUES (?, ?, ?)").run(WS2, "Team 2", USER);
  db.prepare("INSERT INTO workspace_members (workspaceId, userId, role) VALUES (?, ?, ?)").run(WS, USER, role);
  db.prepare("INSERT INTO workspace_members (workspaceId, userId, role) VALUES (?, ?, ?)").run(WS2, USER, "owner");
}

function seedPersonalNotebookTree() {
  const db = getDb();
  db.prepare("INSERT INTO notebooks (id, userId, workspaceId, parentId, name, icon, color, sortOrder, isExpanded) VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, ?)")
    .run("nb-root", USER, "Root", "R", "#111", 2, 1);
  db.prepare("INSERT INTO notebooks (id, userId, workspaceId, parentId, name, icon, color, sortOrder, isExpanded) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)")
    .run("nb-child", USER, "nb-root", "Child", "C", "#222", 3, 0);
  db.prepare("INSERT INTO notes (id, userId, workspaceId, notebookId, title, content, contentText, contentFormat, isPinned, isLocked, isArchived, isTrashed, version, sortOrder) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("11111111-1111-1111-1111-111111111111", USER, "nb-root", "Root Note", "root", "root", "markdown", 1, 1, 1, 0, 8, 4);
  db.prepare("INSERT INTO notes (id, userId, workspaceId, notebookId, title, content, contentText, contentFormat, isPinned, isLocked, isArchived, isTrashed, version, sortOrder) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("22222222-2222-2222-2222-222222222222", USER, "nb-child", "Child Note", "see [[note:11111111-1111-1111-1111-111111111111|Root]]", "", "markdown", 0, 0, 0, 0, 3, 5);
}

function reducePersonalTreeToRoot() {
  getDb().exec(`
    DELETE FROM notes WHERE notebookId IN ('nb-root', 'nb-child');
    DELETE FROM notebooks WHERE id = 'nb-child';
  `);
}

function copy(input: Partial<Parameters<typeof copyPersonalNotebookToWorkspace>[0]> = {}) {
  return copyPersonalNotebookToWorkspace({
    actorUserId: USER,
    sourceNotebookId: "nb-root",
    targetWorkspaceId: WS,
    mode: "copy",
    includeTags: true,
    includeAttachments: true,
    includeVersions: false,
    ...input,
  });
}

test.beforeEach(() => {
  initAuditTables();
  resetDb();
});

test("pure helpers rewrite attachment urls and note links", () => {
  const attMap = new Map([["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"]]);
  assert.equal(
    rewriteAttachmentUrls('/api/attachments/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa?inline=1', attMap),
    "/api/attachments/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb?inline=1",
  );

  const noteMap = new Map([["11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222"]]);
  const rewritten = rewriteInternalNoteLinks(
    '[[note:11111111-1111-1111-1111-111111111111|A]] note://33333333-3333-3333-3333-333333333333',
    noteMap,
  );
  assert.match(rewritten.content, /22222222-2222-2222-2222-222222222222/);
  assert.equal(rewritten.externalNoteLinkCount, 1);
});

test("mode move is rejected", () => {
  seedUsersAndWorkspaces();
  seedPersonalNotebookTree();
  assert.throws(
    () => copy({ mode: "move" }),
    (err: any) => err instanceof WorkspaceNotebookTransferError && err.status === 400 && err.code === "MOVE_NOT_SUPPORTED",
  );
});

test("source must be personal and owned by actor", () => {
  seedUsersAndWorkspaces();
  seedPersonalNotebookTree();
  reducePersonalTreeToRoot();
  getDb().prepare("UPDATE notebooks SET workspaceId = ? WHERE id = ?").run(WS, "nb-root");
  assert.throws(() => copy(), /source notebook must be in personal workspace/);

  resetDb();
  seedUsersAndWorkspaces();
  seedPersonalNotebookTree();
  reducePersonalTreeToRoot();
  getDb().prepare("UPDATE notebooks SET userId = ? WHERE id = ?").run(OTHER, "nb-root");
  assert.throws(
    () => copy(),
    (err: any) => err instanceof WorkspaceNotebookTransferError && err.status === 403 && err.code === "SOURCE_FORBIDDEN",
  );
});

test("viewer cannot copy into workspace", () => {
  seedUsersAndWorkspaces("viewer");
  seedPersonalNotebookTree();
  assert.throws(
    () => copy(),
    (err: any) => err instanceof WorkspaceNotebookTransferError && err.status === 403 && err.code === "TARGET_WORKSPACE_FORBIDDEN",
  );
});

test("editor can copy notebook tree and notes into workspace root", () => {
  seedUsersAndWorkspaces("editor");
  seedPersonalNotebookTree();
  const result = copy();

  assert.equal(result.success, true);
  assert.equal(result.notebookCount, 2);
  assert.equal(result.noteCount, 2);

  const db = getDb();
  const root = db.prepare("SELECT * FROM notebooks WHERE id = ?").get(result.targetNotebookId) as any;
  assert.equal(root.workspaceId, WS);
  assert.equal(root.userId, USER);
  assert.equal(root.parentId, null);

  const child = db.prepare("SELECT * FROM notebooks WHERE name = ? AND workspaceId = ?").get("Child", WS) as any;
  assert.equal(child.parentId, root.id);

  const notes = db.prepare("SELECT * FROM notes WHERE workspaceId = ? ORDER BY title").all(WS) as any[];
  assert.equal(notes.length, 2);
  assert.equal(notes[0].isLocked, 0);
  assert.equal(notes[0].isArchived, 0);
  assert.equal(notes[0].version, 1);
  const rootNote = notes.find((n) => n.title === "Root Note");
  const childNote = notes.find((n) => n.title === "Child Note");
  assert.match(childNote.content, new RegExp(`note:${rootNote.id}`));
  assert.doesNotMatch(childNote.content, /11111111-1111-1111-1111-111111111111/);
  const noteLink = db.prepare("SELECT * FROM note_links WHERE sourceNoteId = ? AND targetNoteId = ?")
    .get(childNote.id, rootNote.id);
  assert.ok(noteLink);

  const audit = db.prepare("SELECT * FROM audit_logs WHERE action = ?").get("notebook.transfer_copy") as any;
  assert.equal(audit.targetId, result.targetNotebookId);
});

test("targetParentId must belong to target workspace", () => {
  seedUsersAndWorkspaces("editor");
  seedPersonalNotebookTree();
  getDb().prepare("INSERT INTO notebooks (id, userId, workspaceId, name) VALUES (?, ?, ?, ?)").run("other-parent", USER, WS2, "Other Parent");
  assert.throws(
    () => copy({ targetParentId: "other-parent" }),
    (err: any) => err instanceof WorkspaceNotebookTransferError && err.status === 400 && err.code === "TARGET_PARENT_WORKSPACE_MISMATCH",
  );
});

test("attachments are copied and content urls are rewritten", () => {
  seedUsersAndWorkspaces("editor");
  seedPersonalNotebookTree();
  const attachmentsDir = ensureAttachmentsDir();
  fs.mkdirSync(path.join(attachmentsDir, "2026", "07"), { recursive: true });
  fs.writeFileSync(path.join(attachmentsDir, "2026", "07", "old.txt"), "hello");
  getDb().prepare("INSERT INTO attachments (id, noteId, userId, workspaceId, filename, mimeType, size, path, hash) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)")
    .run(
      "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      "11111111-1111-1111-1111-111111111111",
      USER,
      "old.txt",
      "text/plain",
      5,
      "2026/07/old.txt",
      "hash-old",
    );
  getDb().prepare("UPDATE notes SET content = ?, contentText = ? WHERE id = ?")
    .run(
      "/api/attachments/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa?inline=1",
      "/api/attachments/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa?download=1",
      "11111111-1111-1111-1111-111111111111",
    );

  const result = copy();
  assert.equal(result.attachmentCount, 1);

  const newAttachment = getDb().prepare("SELECT * FROM attachments WHERE workspaceId = ?").get(WS) as any;
  assert.ok(newAttachment);
  assert.notEqual(newAttachment.id, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
  assert.equal(newAttachment.noteId !== "11111111-1111-1111-1111-111111111111", true);
  assert.equal(fs.existsSync(path.join(getAttachmentsDir(), newAttachment.path)), true);

  const newNote = getDb().prepare("SELECT * FROM notes WHERE id = ?").get(newAttachment.noteId) as any;
  assert.match(newNote.content, new RegExp(`/api/attachments/${newAttachment.id}\?inline=1`));
  assert.match(newNote.contentText, new RegExp(`/api/attachments/${newAttachment.id}\?download=1`));

  const ref = getDb().prepare("SELECT * FROM attachment_references WHERE attachmentId = ? AND noteId = ?")
    .get(newAttachment.id, newAttachment.noteId);
  assert.ok(ref);
});

test("tags are mapped with existing global tag uniqueness", () => {
  seedUsersAndWorkspaces("editor");
  seedPersonalNotebookTree();
  getDb().prepare("INSERT INTO tags (id, userId, workspaceId, name, color) VALUES (?, ?, NULL, ?, ?)").run("tag-old", USER, "Important", "#f00");
  getDb().prepare("INSERT INTO note_tags (noteId, tagId) VALUES (?, ?)").run("11111111-1111-1111-1111-111111111111", "tag-old");

  const result = copy();
  assert.equal(result.tagCount, 0);
  assert.deepEqual(result.warnings, ["tag_reused_due_unique_constraint:Important"]);
  const tag = getDb().prepare("SELECT * FROM tags WHERE workspaceId IS NULL AND name = ?").get("Important") as any;
  assert.ok(tag);
  const binding = getDb()
    .prepare(`SELECT nt.* FROM note_tags nt JOIN notes n ON n.id = nt.noteId WHERE n.workspaceId = ? AND nt.tagId = ?`)
    .get(WS, tag.id);
  assert.ok(binding);
});

test("attachment copy failure rolls back database and removes copied files", () => {
  seedUsersAndWorkspaces("editor");
  seedPersonalNotebookTree();
  const attachmentsDir = ensureAttachmentsDir();
  fs.mkdirSync(path.join(attachmentsDir, "2026", "07"), { recursive: true });
  fs.writeFileSync(path.join(attachmentsDir, "2026", "07", "ok.txt"), "ok");
  getDb().prepare("INSERT INTO attachments (id, noteId, userId, workspaceId, filename, mimeType, size, path) VALUES (?, ?, ?, NULL, ?, ?, ?, ?)")
    .run("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "11111111-1111-1111-1111-111111111111", USER, "ok.txt", "text/plain", 2, "2026/07/ok.txt");
  getDb().prepare("INSERT INTO attachments (id, noteId, userId, workspaceId, filename, mimeType, size, path) VALUES (?, ?, ?, NULL, ?, ?, ?, ?)")
    .run("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", "22222222-2222-2222-2222-222222222222", USER, "missing.txt", "text/plain", 7, "2026/07/missing.txt");

  assert.throws(
    () => copy(),
    (err: any) => err instanceof WorkspaceNotebookTransferError && err.code === "ATTACHMENT_FILE_MISSING",
  );
  assert.equal((getDb().prepare("SELECT COUNT(*) AS c FROM notebooks WHERE workspaceId = ?").get(WS) as any).c, 0);
  assert.equal((getDb().prepare("SELECT COUNT(*) AS c FROM notes WHERE workspaceId = ?").get(WS) as any).c, 0);
  assert.equal((getDb().prepare("SELECT COUNT(*) AS c FROM attachments WHERE workspaceId = ?").get(WS) as any).c, 0);
  const copiedFiles = fs.readdirSync(path.join(attachmentsDir, "2026", "07")).filter((name) => name !== "ok.txt");
  assert.equal(copiedFiles.length, 0);
});

test("existing cross-workspace move protections are unchanged", async () => {
  seedUsersAndWorkspaces("editor");
  seedPersonalNotebookTree();
  const db = getDb();
  db.prepare("INSERT INTO notebooks (id, userId, workspaceId, name) VALUES (?, ?, ?, ?)").run("team-nb", USER, WS, "Team NB");
  db.prepare("INSERT INTO notes (id, userId, workspaceId, notebookId, title) VALUES (?, ?, NULL, ?, ?)").run("note-move", USER, "nb-root", "Move Me");

  const app = new Hono();
  app.route("/notebooks", notebooksRouter);
  app.route("/notes", notesRouter);

  const nbRes = await app.request("/notebooks/nb-root/move", {
    method: "PUT",
    headers: { "X-User-Id": USER, "Content-Type": "application/json" },
    body: JSON.stringify({ parentId: "team-nb" }),
  });
  assert.equal(nbRes.status, 400);
  assert.match(await nbRes.text(), /cannot move notebook across workspaces/);

  const noteRes = await app.request("/notes/note-move", {
    method: "PUT",
    headers: { "X-User-Id": USER, "Content-Type": "application/json" },
    body: JSON.stringify({ notebookId: "team-nb" }),
  });
  assert.equal(noteRes.status, 400);
  assert.match(await noteRes.text(), /CROSS_WORKSPACE_MOVE_FORBIDDEN/);
});
