import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before, beforeEach } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-note-transfer-hardening-"));
process.env.DB_PATH = path.join(tempDir, "test.db");
process.env.ELECTRON_USER_DATA = tempDir;
process.env.JWT_SECRET = "note-transfer-hardening-test-secret";

let closeDb: () => void;
let db: any;
let getAttachmentsDir: () => string;
let executeNoteTransferSafe: (input: any) => Promise<any>;
let NoteTransferError: any;
let noteTransfersRouter: any;

const NOTE_ONE = "11111111-1111-4111-8111-111111111111";
const NOTE_TWO = "22222222-2222-4222-8222-222222222222";
const ATTACHMENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

before(async () => {
  const schema = await import("../src/db/schema.js");
  const audit = await import("../src/services/audit.js");
  const storage = await import("../src/services/attachment-storage.js");
  const safety = await import("../src/services/noteTransferSafety.js");
  const transfer = await import("../src/services/noteTransfer.js");
  const routes = await import("../src/routes/note-transfers.js");

  closeDb = schema.closeDb;
  db = schema.getDb();
  getAttachmentsDir = storage.getAttachmentsDir;
  executeNoteTransferSafe = safety.executeNoteTransferSafe;
  NoteTransferError = transfer.NoteTransferError;
  noteTransfersRouter = routes.default;
  audit.initAuditTables();
});

function resetDb() {
  db.pragma("foreign_keys = OFF");
  for (const table of [
    "audit_logs",
    "note_links",
    "attachment_references",
    "note_tags",
    "tags",
    "attachments",
    "notes",
    "notebooks",
    "workspace_members",
    "workspaces",
    "users",
  ]) {
    try { db.prepare(`DELETE FROM ${table}`).run(); } catch { /* optional table */ }
  }
  db.pragma("foreign_keys = ON");
  fs.rmSync(getAttachmentsDir(), { recursive: true, force: true });
  fs.mkdirSync(getAttachmentsDir(), { recursive: true });
}

function seedBase() {
  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES ('u1', 'u1', 'x')").run();
  db.prepare("INSERT INTO workspaces (id, name, ownerId) VALUES ('w1', 'Team', 'u1')").run();
  db.prepare("INSERT INTO workspace_members (workspaceId, userId, role) VALUES ('w1', 'u1', 'owner')").run();
  db.prepare("INSERT INTO notebooks (id, userId, workspaceId, name) VALUES ('personal', 'u1', NULL, 'Personal')").run();
  db.prepare("INSERT INTO notebooks (id, userId, workspaceId, name) VALUES ('team', 'u1', 'w1', 'Team')").run();
}

function seedNote(id: string, workspaceId: string | null, notebookId: string, content: string, version = 1) {
  db.prepare(`
    INSERT INTO notes (
      id, userId, workspaceId, notebookId, title, content, contentText, contentFormat, version
    ) VALUES (?, 'u1', ?, ?, ?, ?, ?, 'markdown', ?)
  `).run(id, workspaceId, notebookId, id, content, content, version);
}

beforeEach(() => {
  resetDb();
  seedBase();
});

after(() => {
  closeDb?.();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("move execution rejects an empty or partial preview version map", async () => {
  seedNote(NOTE_ONE, "w1", "team", "body", 7);

  await assert.rejects(
    () => executeNoteTransferSafe({
      actorUserId: "u1",
      sourceNoteIds: [NOTE_ONE],
      targetWorkspaceId: null,
      targetNotebookId: "personal",
      mode: "move",
      expectedVersions: {},
    }),
    (error: unknown) => error instanceof NoteTransferError
      && error.code === "TRANSFER_PREVIEW_REQUIRED"
      && error.status === 409,
  );
  const source = db.prepare("SELECT isTrashed, version FROM notes WHERE id = ?").get(NOTE_ONE) as any;
  assert.equal(source.isTrashed, 0);
  assert.equal(source.version, 7);
});

test("copied contentText follows rewritten note and attachment ids", async () => {
  const sourceContent = `[[note:${NOTE_TWO}|Two]] /api/attachments/${ATTACHMENT}`;
  seedNote(NOTE_ONE, null, "personal", sourceContent);
  seedNote(NOTE_TWO, null, "personal", "Two");

  const relativePath = `2026/07/${ATTACHMENT}.txt`;
  const absolutePath = path.join(getAttachmentsDir(), relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, "hello");
  db.prepare(`
    INSERT INTO attachments (
      id, noteId, userId, workspaceId, filename, mimeType, size, path, uploadSource
    ) VALUES (?, ?, 'u1', NULL, 'hello.txt', 'text/plain', 5, ?, 'test')
  `).run(ATTACHMENT, NOTE_ONE, relativePath);

  const result = await executeNoteTransferSafe({
    actorUserId: "u1",
    sourceNoteIds: [NOTE_ONE, NOTE_TWO],
    targetWorkspaceId: "w1",
    targetNotebookId: "team",
    mode: "copy",
  });
  const copiedOne = result.items.find((item: any) => item.sourceNoteId === NOTE_ONE)!;
  const copiedTwo = result.items.find((item: any) => item.sourceNoteId === NOTE_TWO)!;
  const target = db.prepare("SELECT content, contentText FROM notes WHERE id = ?").get(copiedOne.targetNoteId) as any;
  const copiedAttachment = db.prepare("SELECT id FROM attachments WHERE noteId = ?").get(copiedOne.targetNoteId) as any;

  assert.match(target.content, new RegExp(copiedTwo.targetNoteId));
  assert.match(target.contentText, new RegExp(copiedTwo.targetNoteId));
  assert.match(target.content, new RegExp(copiedAttachment.id));
  assert.match(target.contentText, new RegExp(copiedAttachment.id));
  assert.doesNotMatch(target.contentText, new RegExp(ATTACHMENT));
});

test("personal API tokens cannot preview or execute cross-space transfers", async () => {
  const response = await noteTransfersRouter.request("http://localhost/preview", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-User-Id": "u1",
      "X-Auth-Mode": "api-token",
    },
    body: JSON.stringify({
      sourceNoteIds: [NOTE_ONE],
      targetWorkspaceId: "w1",
      targetNotebookId: "team",
      mode: "copy",
    }),
  });
  assert.equal(response.status, 403);
  assert.equal((await response.json() as any).code, "INTERACTIVE_LOGIN_REQUIRED");
});
