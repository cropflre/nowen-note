import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import type Database from "better-sqlite3";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-block-patch-mixed-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");
process.env.ELECTRON_USER_DATA = tmpDir;

const owner = "block-patch-mixed-owner";
const notebookId = "block-patch-mixed-notebook";
const firstTarget = "11111111-1111-4111-8111-111111111111";
const secondTarget = "22222222-2222-4222-8222-222222222222";

let db: Database.Database;
let closeDb: () => void;
let app: Hono;
let syncNoteBlocks: typeof import("../src/lib/noteBlocks").syncNoteBlocks;
let syncNoteLinks: typeof import("../src/lib/noteLinks").syncNoteLinks;

function paragraph(blockId: string, text: string, targetNoteId?: string, bold = false) {
  const marks = [
    ...(bold ? [{ type: "bold" }] : []),
    ...(targetNoteId ? [{
      type: "link",
      attrs: {
        href: `note:${targetNoteId}`,
        target: null,
        rel: "noopener noreferrer nofollow",
        class: null,
      },
    }] : []),
  ];
  return {
    type: "paragraph",
    attrs: { blockId, textAlign: null, lineHeight: null },
    content: text ? [{
      type: "text",
      text,
      ...(marks.length > 0 ? { marks } : {}),
    }] : [],
  };
}

function tiptap(...nodes: unknown[]): string {
  return JSON.stringify({ type: "doc", content: nodes });
}

function insertNote(id: string, content: string) {
  db.prepare(`
    INSERT INTO notes (
      id, userId, notebookId, title, content, contentText, contentFormat, version, isLocked
    ) VALUES (?, ?, ?, ?, ?, '', 'tiptap-json', 1, 0)
  `).run(id, owner, notebookId, id, content);
  const synced = syncNoteBlocks(db, id, content, "tiptap-json");
  syncNoteLinks(db, owner, id, synced.content);
}

async function patch(noteId: string, body: unknown) {
  return app.request(`/api/blocks/${noteId}/patch`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-User-Id": owner,
    },
    body: JSON.stringify(body),
  });
}

function orderedBlockIds(noteId: string): string[] {
  return (db.prepare(`
    SELECT blockId FROM note_blocks_index
    WHERE noteId = ? ORDER BY blockOrder ASC
  `).all(noteId) as Array<{ blockId: string }>).map((row) => row.blockId);
}

function indexRow(noteId: string, blockId: string) {
  return db.prepare(`
    SELECT blockId, blockType, parentBlockId, plainText, path, blockOrder, createdAt, updatedAt
    FROM note_blocks_index WHERE noteId = ? AND blockId = ?
  `).get(noteId, blockId) as Record<string, unknown> | undefined;
}

function linkRow(noteId: string, blockId: string) {
  return db.prepare(`
    SELECT id, targetNoteId, createdAt, updatedAt
    FROM note_links WHERE sourceNoteId = ? AND sourceBlockId = ?
  `).get(noteId, blockId) as {
    id: string;
    targetNoteId: string;
    createdAt: string;
    updatedAt: string;
  } | undefined;
}

test.before(async () => {
  const [schema, noteBlocks, noteLinks] = await Promise.all([
    import("../src/db/schema"),
    import("../src/lib/noteBlocks"),
    import("../src/lib/noteLinks"),
  ]);
  await import("../src/runtime/block-patch");
  const blockRoute = await import("../src/routes/blocks");

  db = schema.getDb();
  closeDb = schema.closeDb;
  syncNoteBlocks = noteBlocks.syncNoteBlocks;
  syncNoteLinks = noteLinks.syncNoteLinks;
  app = new Hono();
  app.route("/api/blocks", blockRoute.default);

  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
    .run(owner, owner, "hash");
  db.prepare("INSERT INTO notebooks (id, userId, name) VALUES (?, ?, ?)")
    .run(notebookId, owner, "Mixed incremental indexes");
  insertNote(firstTarget, tiptap(paragraph("blk_target01", "First target")));
  insertNote(secondTarget, tiptap(paragraph("blk_target02", "Second target")));
});

test.after(() => {
  closeDb?.();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("updates rich content, creates and moves top-level Blocks in one mixed incremental plan", async () => {
  const noteId = "33333333-3333-4333-8333-333333333333";
  const firstBlockId = "blk_mixed001";
  const richBlockId = "blk_mixed002";
  const untouchedBlockId = "blk_mixed003";
  const createdBlockId = "blk_mixed004";
  insertNote(noteId, tiptap(
    paragraph(firstBlockId, "First", firstTarget),
    paragraph(richBlockId, "Beta", firstTarget),
    paragraph(untouchedBlockId, "Untouched", secondTarget),
  ));

  const sentinel = "2005-05-05 00:00:00";
  db.prepare("UPDATE note_blocks_index SET updatedAt = ? WHERE noteId = ?")
    .run(sentinel, noteId);
  db.prepare("UPDATE note_links SET updatedAt = ? WHERE sourceNoteId = ?")
    .run(sentinel, noteId);
  const firstLinkBefore = linkRow(noteId, firstBlockId);
  const untouchedLinkBefore = linkRow(noteId, untouchedBlockId);

  const replacement = paragraph(richBlockId, "Beta", secondTarget, true);
  const response = await patch(noteId, {
    expectedNoteVersion: 1,
    operationId: "block-patch-mixed-index-rich-create-move",
    operations: [
      { type: "replace", blockId: richBlockId, node: replacement },
      {
        type: "create",
        blockId: createdBlockId,
        clientId: createdBlockId,
        blockType: "paragraph",
        text: `[[note:${firstTarget}|Created]]`,
      },
      {
        type: "move",
        blockId: richBlockId,
        targetBlockId: firstBlockId,
        position: "before",
      },
    ],
  });

  assert.equal(response.status, 200);
  const payload = await response.json() as any;
  assert.equal(payload.indexUpdateMode, "incremental");
  assert.equal(payload.indexUpdateKind, "mixed");
  assert.deepEqual(payload.indexedBlockIds, [richBlockId, firstBlockId, createdBlockId]);
  assert.deepEqual(orderedBlockIds(noteId), [richBlockId, firstBlockId, untouchedBlockId, createdBlockId]);
  assert.equal(indexRow(noteId, richBlockId)?.plainText, "Beta");
  assert.equal(indexRow(noteId, richBlockId)?.path, "0");
  assert.equal(indexRow(noteId, firstBlockId)?.path, "1");
  assert.equal(indexRow(noteId, untouchedBlockId)?.updatedAt, sentinel);
  assert.equal(indexRow(noteId, createdBlockId)?.path, "3");

  const firstLinkAfter = linkRow(noteId, firstBlockId);
  const untouchedLinkAfter = linkRow(noteId, untouchedBlockId);
  assert.equal(firstLinkAfter?.id, firstLinkBefore?.id);
  assert.equal(firstLinkAfter?.updatedAt, sentinel);
  assert.equal(untouchedLinkAfter?.id, untouchedLinkBefore?.id);
  assert.equal(untouchedLinkAfter?.updatedAt, sentinel);
  assert.equal(linkRow(noteId, richBlockId)?.targetNoteId, secondTarget);
  assert.equal(linkRow(noteId, createdBlockId)?.targetNoteId, firstTarget);
});

test("updates one Block and deletes another without rebuilding an unrelated link", async () => {
  const noteId = "44444444-4444-4444-8444-444444444444";
  const changedBlockId = "blk_mixdel01";
  const deletedBlockId = "blk_mixdel02";
  const untouchedBlockId = "blk_mixdel03";
  insertNote(noteId, tiptap(
    paragraph(changedBlockId, "Before", firstTarget),
    paragraph(deletedBlockId, "Delete", secondTarget),
    paragraph(untouchedBlockId, "Keep", secondTarget),
  ));

  const sentinel = "2006-06-06 00:00:00";
  db.prepare(`
    UPDATE note_links SET id = 'mixed-keep-link', updatedAt = ?
    WHERE sourceNoteId = ? AND sourceBlockId = ?
  `).run(sentinel, noteId, untouchedBlockId);

  const response = await patch(noteId, {
    expectedNoteVersion: 1,
    operationId: "block-patch-mixed-index-update-delete",
    operations: [
      { type: "update", blockId: changedBlockId, text: "After" },
      { type: "delete", blockId: deletedBlockId },
    ],
  });

  assert.equal(response.status, 200);
  const payload = await response.json() as any;
  assert.equal(payload.indexUpdateKind, "mixed");
  assert.deepEqual(payload.indexedBlockIds, [deletedBlockId, changedBlockId, untouchedBlockId]);
  assert.equal(indexRow(noteId, changedBlockId)?.plainText, "After");
  assert.equal(indexRow(noteId, deletedBlockId), undefined);
  assert.equal(indexRow(noteId, untouchedBlockId)?.path, "1");
  assert.equal(linkRow(noteId, deletedBlockId), undefined);
  assert.equal(linkRow(noteId, untouchedBlockId)?.id, "mixed-keep-link");
  assert.equal(linkRow(noteId, untouchedBlockId)?.updatedAt, sentinel);
});

test("falls back when a mixed batch shifts nested container paths", async () => {
  const noteId = "55555555-5555-4555-8555-555555555555";
  const firstBlockId = "blk_mixnest1";
  const itemBlockId = "blk_mixnest2";
  const nestedBlockId = "blk_mixnest3";
  const createdBlockId = "blk_mixnest4";
  insertNote(noteId, tiptap(
    paragraph(firstBlockId, "First"),
    {
      type: "bulletList",
      content: [{
        type: "listItem",
        attrs: { blockId: itemBlockId },
        content: [paragraph(nestedBlockId, "Nested")],
      }],
    },
  ));

  const response = await patch(noteId, {
    expectedNoteVersion: 1,
    operationId: "block-patch-mixed-index-nested-fallback",
    operations: [
      { type: "update", blockId: nestedBlockId, text: "Nested after" },
      {
        type: "create",
        blockId: createdBlockId,
        blockType: "paragraph",
        text: "Inserted before list",
        afterBlockId: firstBlockId,
      },
    ],
  });

  assert.equal(response.status, 200);
  const payload = await response.json() as any;
  assert.equal(payload.indexUpdateMode, "full");
  assert.equal(payload.indexUpdateKind, "full");
  assert.equal(indexRow(noteId, nestedBlockId)?.plainText, "Nested after");
  assert.equal(indexRow(noteId, itemBlockId)?.path, "2.0");
  assert.equal(indexRow(noteId, nestedBlockId)?.path, "2.0.0");
});
