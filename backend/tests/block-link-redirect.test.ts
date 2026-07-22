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
const markdownSourceId = "44444444-4444-4444-8444-444444444444";
const markdownChildId = "55555555-5555-4555-8555-555555555555";

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
    heading("Part", "blk_heading_part"),
    paragraph("Alpha body", "blk_body_alpha"),
    heading("Other", "blk_heading_other"),
    paragraph("Other body", "blk_other_body"),
  ]);
  const childDirectory = doc([paragraph("Child directory", "blk_child_directory")]);
  const grandchild = doc([paragraph("Alpha body", "blk_body_alpha")]);

  const insertNote = db.prepare(`
    INSERT INTO notes (id, userId, notebookId, title, content, contentText, contentFormat, version)
    VALUES (?, ?, ?, ?, ?, ?, 'tiptap-json', ?)
  `);
  insertNote.run(sourceId, owner, notebookId, "Source", sourceDirectory, "Directory", 2);
  insertNote.run(childId, owner, notebookId, "Alpha", childDirectory, "Child directory", 2);
  insertNote.run(grandchildId, owner, notebookId, "Part", grandchild, "Alpha body", 1);

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
    ) VALUES ('op-child', ?, ?, 1, 2, 'Alpha', ?, 'Part Alpha body Other body', 'tiptap-json', 1, 'completed')
  `).run(childId, owner, childOriginal);
  db.prepare(`INSERT INTO note_split_items (operationId, noteId, sortOrder, createdVersion, title)
              VALUES ('op-child', ?, 0, 1, 'Part')`).run(grandchildId);

  const originalMarkdown = [
    "# Chapter ^blk_md_heading",
    "",
    "Body text ^blk_md_body",
    "",
    "# Other ^blk_md_other_heading",
    "",
    "Other text ^blk_md_other_body",
    "",
  ].join("\n");
  const markdownDirectory = "Directory ^blk_md_directory\n";
  const markdownChild = "Body text ^blk_md_body\n";
  db.prepare(`
    INSERT INTO notes (id, userId, notebookId, title, content, contentText, contentFormat, version)
    VALUES (?, ?, ?, 'Markdown source', ?, 'Directory', 'markdown', 2)
  `).run(markdownSourceId, owner, notebookId, markdownDirectory);
  db.prepare(`
    INSERT INTO notes (id, userId, notebookId, title, content, contentText, contentFormat, version)
    VALUES (?, ?, ?, 'Chapter', ?, 'Body text', 'markdown', 1)
  `).run(markdownChildId, owner, notebookId, markdownChild);
  syncNoteBlocks(db, markdownSourceId, markdownDirectory, "markdown");
  syncNoteBlocks(db, markdownChildId, markdownChild, "markdown");
  db.prepare(`
    INSERT INTO note_split_operations (
      id, sourceNoteId, actorUserId, originalVersion, directoryVersion,
      originalTitle, originalContent, originalContentText, originalContentFormat,
      headingLevel, status
    ) VALUES ('op-markdown', ?, ?, 1, 2, 'Markdown source', ?, 'Chapter Body text', 'markdown', 1, 'completed')
  `).run(markdownSourceId, owner, originalMarkdown);
  db.prepare(`INSERT INTO note_split_items (operationId, noteId, sortOrder, createdVersion, title)
              VALUES ('op-markdown', ?, 0, 1, 'Chapter')`).run(markdownChildId);
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
  const response = await resolve(sourceId, "blk_body_alpha");
  assert.equal(response.status, 200);
  const payload = await response.json() as any;
  assert.equal(payload.note.id, grandchildId);
  assert.equal(payload.block.blockId, "blk_body_alpha");
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

test("resolves Markdown body and heading anchors without rewriting old links", async () => {
  const bodyResponse = await resolve(markdownSourceId, "blk_md_body");
  assert.equal(bodyResponse.status, 200);
  const bodyPayload = await bodyResponse.json() as any;
  assert.equal(bodyPayload.note.id, markdownChildId);
  assert.equal(bodyPayload.block.blockId, "blk_md_body");

  const headingResponse = await resolve(markdownSourceId, "blk_md_heading");
  assert.equal(headingResponse.status, 200);
  const headingPayload = await headingResponse.json() as any;
  assert.equal(headingPayload.note.id, markdownChildId);
  assert.equal(headingPayload.block, null);
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
