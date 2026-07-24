import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import type Database from "better-sqlite3";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-note-delete-attachments-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");
process.env.ELECTRON_USER_DATA = tmpDir;
process.env.ATTACHMENT_STORAGE = "local";

let app: Hono;
let getDb: () => Database.Database;
let closeDb: () => void;
let getAttachmentsDir: () => string;

const USER_ID = "delete-attachment-user";
const NOTEBOOK_ID = "delete-attachment-notebook";

function db(): Database.Database {
  return getDb();
}

function seedBase(): void {
  db().prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
    .run(USER_ID, USER_ID, "hash");
  db().prepare("INSERT INTO notebooks (id, userId, name) VALUES (?, ?, ?)")
    .run(NOTEBOOK_ID, USER_ID, "Delete attachments");
}

function seedNote(
  id: string,
  options: { trashed?: boolean; locked?: boolean; workspaceId?: string | null; notebookId?: string } = {},
): void {
  db().prepare(`
    INSERT INTO notes (
      id, userId, notebookId, workspaceId, title, content, contentText,
      isTrashed, isLocked, version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `).run(
    id,
    USER_ID,
    options.notebookId || NOTEBOOK_ID,
    options.workspaceId || null,
    id,
    "{}",
    id,
    options.trashed ? 1 : 0,
    options.locked ? 1 : 0,
  );
}

function seedAttachment(
  noteId: string,
  attachmentId: string,
  relativePath: string,
  bytes: Buffer,
  mimeType = "image/png",
): string {
  const absolutePath = path.join(getAttachmentsDir(), relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, bytes);

  db().prepare(`
    INSERT INTO attachments (
      id, noteId, userId, filename, mimeType, size, path
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    attachmentId,
    noteId,
    USER_ID,
    path.basename(relativePath),
    mimeType,
    bytes.length,
    relativePath,
  );

  return absolutePath;
}

function resetData(): void {
  const database = db();
  database.exec(`
    DELETE FROM attachments;
    DELETE FROM notes;
    DELETE FROM notebooks;
    DELETE FROM users;
  `);

  const attachmentsDir = getAttachmentsDir();
  fs.rmSync(attachmentsDir, { recursive: true, force: true });
  fs.mkdirSync(attachmentsDir, { recursive: true });
  seedBase();
}

async function requestJson(method: string, url: string, body?: unknown) {
  const response = await app.request(url, {
    method,
    headers: {
      "X-User-Id": USER_ID,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, json: await response.json() as any };
}

test.before(async () => {
  const [notesModule, attachmentsModule, schemaModule] = await Promise.all([
    import("../src/routes/notes"),
    import("../src/routes/attachments"),
    import("../src/db/schema"),
  ]);

  app = new Hono();
  app.route("/notes", notesModule.default);
  getDb = schemaModule.getDb;
  closeDb = schemaModule.closeDb;
  getAttachmentsDir = attachmentsModule.getAttachmentsDir;
  resetData();
});

test.beforeEach(resetData);

test.after(async () => {
  closeDb();
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      return;
    } catch (error: any) {
      if (error?.code !== "EBUSY") throw error;
      if (attempt === 4) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
});

test("permanently deleting a note removes its image and file attachments", async () => {
  const noteId = "delete-note-with-files";
  seedNote(noteId);
  const imagePath = seedAttachment(
    noteId,
    "11111111-1111-4111-8111-111111111111",
    "2026/07/11111111-1111-4111-8111-111111111111.png",
    Buffer.from([1, 2, 3]),
  );
  const documentPath = seedAttachment(
    noteId,
    "22222222-2222-4222-8222-222222222222",
    "2026/07/22222222-2222-4222-8222-222222222222.pdf",
    Buffer.from("pdf"),
    "application/pdf",
  );

  const { response, json } = await requestJson("DELETE", `/notes/${noteId}`);

  assert.equal(response.status, 200);
  assert.equal(json.success, true);
  assert.equal(db().prepare("SELECT COUNT(*) AS count FROM notes WHERE id = ?").get(noteId).count, 0);
  assert.equal(db().prepare("SELECT COUNT(*) AS count FROM attachments WHERE noteId = ?").get(noteId).count, 0);
  assert.equal(fs.existsSync(imagePath), false);
  assert.equal(fs.existsSync(documentPath), false);
});

test("moving a note to trash keeps attachments so the note remains recoverable", async () => {
  const noteId = "trash-note-with-image";
  seedNote(noteId);
  const imagePath = seedAttachment(
    noteId,
    "33333333-3333-4333-8333-333333333333",
    "2026/07/33333333-3333-4333-8333-333333333333.png",
    Buffer.from([3, 3, 3]),
  );

  const { response } = await requestJson("PUT", `/notes/${noteId}`, { isTrashed: 1 });

  assert.equal(response.status, 200);
  const note = db().prepare("SELECT isTrashed FROM notes WHERE id = ?").get(noteId) as { isTrashed: number };
  assert.equal(note.isTrashed, 1);
  assert.equal(db().prepare("SELECT COUNT(*) AS count FROM attachments WHERE noteId = ?").get(noteId).count, 1);
  assert.equal(fs.existsSync(imagePath), true);
});

test("emptying trash deletes attachments for unlocked notes but preserves locked notes", async () => {
  const deletedNoteId = "trashed-unlocked-note";
  const lockedNoteId = "trashed-locked-note";
  seedNote(deletedNoteId, { trashed: true });
  seedNote(lockedNoteId, { trashed: true, locked: true });

  const deletedPath = seedAttachment(
    deletedNoteId,
    "44444444-4444-4444-8444-444444444444",
    "2026/07/44444444-4444-4444-8444-444444444444.png",
    Buffer.from([4]),
  );
  const lockedPath = seedAttachment(
    lockedNoteId,
    "55555555-5555-4555-8555-555555555555",
    "2026/07/55555555-5555-4555-8555-555555555555.png",
    Buffer.from([5]),
  );

  const { response, json } = await requestJson("DELETE", "/notes/trash/empty");

  assert.equal(response.status, 200);
  assert.equal(json.success, true);
  assert.equal(json.count, 1);
  assert.equal(json.skipped, 1);
  assert.equal(db().prepare("SELECT COUNT(*) AS count FROM notes WHERE id = ?").get(deletedNoteId).count, 0);
  assert.equal(db().prepare("SELECT COUNT(*) AS count FROM notes WHERE id = ?").get(lockedNoteId).count, 1);
  assert.equal(fs.existsSync(deletedPath), false);
  assert.equal(fs.existsSync(lockedPath), true);
});

test("trash summary returns counts without loading every note", async () => {
  seedNote("summary-unlocked-1", { trashed: true });
  seedNote("summary-unlocked-2", { trashed: true });
  seedNote("summary-locked", { trashed: true, locked: true });
  seedNote("summary-active");

  const { response, json } = await requestJson("GET", "/notes/trash/summary");

  assert.equal(response.status, 200);
  assert.deepEqual(json, { count: 2, skipped: 1 });
});

test("emptying more notes than SQLite's common variable limit stays a single bulk operation", async () => {
  const total = 33_000;
  const insert = db().prepare(`
    INSERT INTO notes (
      id, userId, notebookId, title, content, contentText,
      isTrashed, isLocked, version
    ) VALUES (?, ?, ?, ?, '{}', '', 1, 0, 1)
  `);
  db().transaction(() => {
    for (let index = 0; index < total; index++) {
      const id = `large-trash-${String(index).padStart(5, "0")}`;
      insert.run(id, USER_ID, NOTEBOOK_ID, id);
    }
  })();

  const { response, json } = await requestJson("DELETE", "/notes/trash/empty");

  assert.equal(response.status, 200);
  assert.equal(json.count, total);
  assert.equal(json.noteIds.length, total);
  assert.equal(db().prepare("SELECT COUNT(*) AS count FROM notes WHERE isTrashed = 1").get().count, 0);
});

test("workspace trash emptying is scoped to that workspace", async () => {
  const workspaceId = "trash-workspace";
  const workspaceNotebookId = "trash-workspace-notebook";
  db().prepare("INSERT INTO workspaces (id, name, ownerId) VALUES (?, ?, ?)")
    .run(workspaceId, "Trash workspace", USER_ID);
  db().prepare("INSERT INTO workspace_members (workspaceId, userId, role) VALUES (?, ?, 'owner')")
    .run(workspaceId, USER_ID);
  db().prepare("INSERT INTO notebooks (id, userId, workspaceId, name) VALUES (?, ?, ?, ?)")
    .run(workspaceNotebookId, USER_ID, workspaceId, "Workspace trash");

  seedNote("personal-trash-kept", { trashed: true });
  seedNote("workspace-trash-deleted", {
    trashed: true,
    workspaceId,
    notebookId: workspaceNotebookId,
  });

  const summary = await requestJson("GET", `/notes/trash/summary?workspaceId=${workspaceId}`);
  assert.deepEqual(summary.json, { count: 1, skipped: 0 });

  const emptied = await requestJson("DELETE", `/notes/trash/empty?workspaceId=${workspaceId}`);
  assert.equal(emptied.response.status, 200);
  assert.equal(emptied.json.count, 1);
  assert.equal(db().prepare("SELECT COUNT(*) AS count FROM notes WHERE id = 'workspace-trash-deleted'").get().count, 0);
  assert.equal(db().prepare("SELECT COUNT(*) AS count FROM notes WHERE id = 'personal-trash-kept'").get().count, 1);
});

test("deduplicated physical files are retained until the final note reference is deleted", async () => {
  const firstNoteId = "dedup-note-one";
  const secondNoteId = "dedup-note-two";
  const sharedPath = "2026/07/66666666-6666-4666-8666-666666666666.png";
  seedNote(firstNoteId);
  seedNote(secondNoteId);

  const absolutePath = seedAttachment(
    firstNoteId,
    "66666666-6666-4666-8666-666666666661",
    sharedPath,
    Buffer.from([6, 6]),
  );
  db().prepare(`
    INSERT INTO attachments (
      id, noteId, userId, filename, mimeType, size, path
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    "66666666-6666-4666-8666-666666666662",
    secondNoteId,
    USER_ID,
    path.basename(sharedPath),
    "image/png",
    2,
    sharedPath,
  );

  const firstDelete = await requestJson("DELETE", `/notes/${firstNoteId}`);
  assert.equal(firstDelete.response.status, 200);
  assert.equal(fs.existsSync(absolutePath), true);
  assert.equal(db().prepare("SELECT COUNT(*) AS count FROM attachments WHERE noteId = ?").get(secondNoteId).count, 1);

  const secondDelete = await requestJson("DELETE", `/notes/${secondNoteId}`);
  assert.equal(secondDelete.response.status, 200);
  assert.equal(fs.existsSync(absolutePath), false);
});
