import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import type Database from "better-sqlite3";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-block-redirect-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");
process.env.ELECTRON_USER_DATA = tmpDir;

const owner = "block-redirect-owner";
const notebookId = "block-redirect-notebook";
const sourceId = "11111111-1111-4111-8111-111111111111";
const childId = "22222222-2222-4222-8222-222222222222";
const grandchildId = "33333333-3333-4333-8333-333333333333";

let db: Database.Database;
let closeDb: () => void;
let app: Hono;
let syncNoteBlocks: typeof import("../src/lib/noteBlocks").syncNoteBlocks;

function doc(nodes: any[]): string {
  return JSON.stringify({ type: "doc", content: nodes });
}

function heading(text: string, blockId: string): any {
  return {
    type: "heading",
    attrs: { level: 1, blockId },
    content: [{ type: "text", text }],
  };
}

function paragraph(text: string, blockId: string): any {
  return {
    type: "paragraph",
    attrs: { blockId },
    content: [{ type: "text", text }],
  };
}

function insertOperation(options: {
  id: string;
  sourceNoteId: string;
  originalContent: string;
  childNoteId: string;
  title: string;
}) {
  const source = db.prepare("SELECT version, title, contentText, contentFormat FROM notes WHERE id = ?")
    .get(options.sourceNoteId) as any;
  db.prepare(`
    INSERT INTO note_split_operations (
      id, sourceNoteId, actorUserId, originalVersion, directoryVersion,
      originalTitle, originalContent, originalContentText, originalContentFormat,
      headingLevel, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'completed')
  `).run(
    options.id,
    options.sourceNoteId,
    owner,
    source.version,
    source.version + 1,
    source.title,
    options.originalContent,
    source.contentText,
    source.contentFormat,
  );
  db.prepare(`
    INSERT INTO note_split_items (operationId, noteId, sortOrder, createdVersion, title)
    VALUES (?, ?, 0, 1, ?)
  `).run(options.id, options.childNoteId, options.title);
}

test.before(async () => {
  const [schema, noteBlocks, noteSplit] = await Promise.all([
    import("../src/db/schema"),
    import("../src/lib/noteBlocks"),
    import("../src/runtime/note-split"),
  ]);
  // The runtime patch must load before /api/blocks is mounted.
  await import("../src/runtime/block-link-redirect");
  const blockRoute = await import("../src/routes/blocks");

  db = schema.getDb();
  closeDb = schema.closeDb;
  syncNoteBlocks = noteBlocks.syncNoteBlocks;
  noteSplit.ensureNoteSplitTables();
  app = new Hono();
  app.route("/api/blocks", blockRoute.default);

  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)").run(owner, owner, "hash");
  db.prepare("INSERT INTO notebooks (id, userId, name) VALUES (?, ?, ?)").run(notebookId, owner, "Redirects");

  const originalSource = doc([
    heading("Alpha", "blk_heading_alpha"),
    paragraph("Alpha body", "blk_body_alpha"),
    heading("Beta", "blk_heading_beta"),
    paragraph("Beta body", "blk_body_beta"),
  ]);
  const sourceDirectory = doc([paragraph("Directory", "blk_directory")]);
  const childOriginal = doc([
    paragraph("Alpha body", "blk_body_alpha"),
    heading("Nested", "blk_heading_nested"),
    paragraph("Nested body", "blk_nested_body"),
  ]);
  const childDirectory = doc([paragraph("Child directory", "blk_child_directory")]);
  const grandchild = doc([paragraph("Nested body", "blk_nested_body")]);

  const insertNote = db.prepare(`
    INSERT INTO notes (id, userId, notebookId, title, content, contentText, contentFormat, version)
    VALUES (?, ?, ?, ?, ?, ?, 'tiptap-json', ?)
  `);
  insertNote.run(sourceId, owner, notebookId, "Source", sourceDirectory, "Directory", 2);
  insertNote.run(childId, owner, notebookId, "Alpha", childDirectory, "Child directory", 2);
  insertNote.run(grandchildId, owner, notebookId, "Nested", grandchild, "Nested body", 1);

  syncNoteBlocks(db, sourceId, sourceDirectory, "tiptap-json");
  syncNoteBlocks(db, childId, childDirectory, "tiptap-json");
  syncNoteBlocks(db, grandchildId, grandchild, "tiptap-json");

  // Durable split history contains the authoritative pre-split snapshots.
  db.prepare(`
    INSERT INTO note_split_operations (
      id, sourceNoteId, actorUserId, originalVersion, directoryVersion,
      originalTitle, originalContent, originalContentText, originalContentFormat,
      headingLevel, status
    ) VALUES ('op-source', ?, ?, 1, 2, 'Source', ?, 'Alpha body Beta body', 'tiptap-json', 1, 'completed')
  `).run(sourceId, owner, originalSource);
  db.prepare(`INSERT INTO note_split_items (operationId, noteId, sortOrder, createdVersion, title)
              VALUES ('op-source', ?, 0, 1, 'Alpha')`).run(childId);

  db.prepare(`
    INSERT INTO note_split_operations (
      id, sourceNoteId, actorUserId, originalVersion, directoryVersion,
      originalTitle, originalContent, originalContentText, originalContentFormat,
      headingLevel, status
    ) VALUES ('op-child', ?, ?, 1, 2, 'Alpha', ?, 'Alpha body Nested body', 'tiptap-json', 1, 'completed')
  `).run(childId, owner, childOriginal);
  db.prepare(`INSERT INTO note_split_items (operationId, noteId, sortOrder, createdVersion, title)
              VALUES ('op-child', ?, 0, 1, 'Nested')`).run(grandchildId);
});

test.after(() => {
  closeDb?.();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function resolve(noteId: string, blockId: string) {
  return app.request(
    `/api/blocks/resolve?link=${encodeURIComponent(`note:${noteId}#blk:${blockId}`)}`,
    { headers: { "X-User-Id": owner } },
  );
}

test("redirects a moved body block through multiple split operations", async () => {
  const response = await resolve(sourceId, "blk_nested_body");
  assert.equal(response.status, 200);
  const payload = await response.json() as any;
  assert.equal(payload.note.id, grandchildId);
  assert.equal(payload.block.blockId, "blk_nested_body");
  assert.equal(payload.redirect.redirected, true);
  assert.equal(payload.redirect.hops, 2);
});

test("redirects an omitted section heading to the child note top", async () => {
  const response = await resolve(sourceId, "blk_heading_alpha");
  assert.equal(response.status, 200);
  const payload = await response.json() as any;
  assert.equal(payload.note.id, childId);
  assert.equal(payload.block, null);
  assert.equal(payload.redirect.toBlockId, null);
});

test("an undone split stops redirecting and the restored source block wins", async () => {
  const originalSource = doc([
    heading("Alpha", "blk_heading_alpha"),
    paragraph("Alpha body", "blk_body_alpha"),
  ]);
  db.prepare("UPDATE note_split_operations SET status = 'undone' WHERE id = 'op-source'").run();
  db.prepare("UPDATE notes SET content = ?, contentText = 'Alpha Alpha body', version = version + 1 WHERE id = ?")
    .run(originalSource, sourceId);
  syncNoteBlocks(db, sourceId, originalSource, "tiptap-json");

  const response = await resolve(sourceId, "blk_body_alpha");
  assert.equal(response.status, 200);
  const payload = await response.json() as any;
  assert.equal(payload.note.id, sourceId);
  assert.equal(payload.block.blockId, "blk_body_alpha");
  assert.equal(payload.redirect, undefined);
});
