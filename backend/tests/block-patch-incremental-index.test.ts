import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import type Database from "better-sqlite3";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-block-patch-index-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");
process.env.ELECTRON_USER_DATA = tmpDir;

const owner = "block-patch-index-owner";
const notebookId = "block-patch-index-notebook";
const firstTarget = "11111111-1111-4111-8111-111111111111";
const secondTarget = "22222222-2222-4222-8222-222222222222";

let db: Database.Database;
let closeDb: () => void;
let app: Hono;
let syncNoteBlocks: typeof import("../src/lib/noteBlocks").syncNoteBlocks;
let syncNoteLinks: typeof import("../src/lib/noteLinks").syncNoteLinks;

function paragraph(blockId: string, text: string, targetNoteId?: string) {
  return {
    type: "paragraph",
    attrs: { blockId, textAlign: null, lineHeight: null },
    content: text ? [{
      type: "text",
      text,
      ...(targetNoteId ? {
        marks: [{
          type: "link",
          attrs: {
            href: `note:${targetNoteId}`,
            target: null,
            rel: "noopener noreferrer nofollow",
            class: null,
          },
        }],
      } : {}),
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

function indexRow(noteId: string, blockId: string) {
  return db.prepare(`
    SELECT blockId, blockType, parentBlockId, plainText, contentHash,
           path, blockOrder, createdAt, updatedAt
    FROM note_blocks_index
    WHERE noteId = ? AND blockId = ?
  `).get(noteId, blockId) as Record<string, unknown> | undefined;
}

function orderedBlockIds(noteId: string): string[] {
  return (db.prepare(`
    SELECT blockId FROM note_blocks_index
    WHERE noteId = ? ORDER BY blockOrder ASC
  `).all(noteId) as Array<{ blockId: string }>).map((row) => row.blockId);
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
    .run(notebookId, owner, "Incremental indexes");
  insertNote(firstTarget, tiptap(paragraph("blk_target01", "First target")));
  insertNote(secondTarget, tiptap(paragraph("blk_target02", "Second target")));
});

test.after(() => {
  closeDb?.();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("updates only the affected Block row and source-Block links", async () => {
  const noteId = "33333333-3333-4333-8333-333333333333";
  const changedBlockId = "blk_changed0";
  const untouchedBlockId = "blk_untouched";
  insertNote(noteId, tiptap(
    paragraph(changedBlockId, "First link", firstTarget),
    paragraph(untouchedBlockId, "Keep link", secondTarget),
  ));

  const sentinel = "2001-01-01 00:00:00";
  db.prepare(`
    UPDATE note_blocks_index SET createdAt = ?, updatedAt = ?
    WHERE noteId = ? AND blockId = ?
  `).run(sentinel, sentinel, noteId, untouchedBlockId);
  db.prepare(`
    UPDATE note_links SET id = 'keep-link-row', createdAt = ?, updatedAt = ?
    WHERE sourceNoteId = ? AND sourceBlockId = ?
  `).run(sentinel, sentinel, noteId, untouchedBlockId);

  const replacement = paragraph(changedBlockId, "Changed link", secondTarget);
  const response = await patch(noteId, {
    expectedNoteVersion: 1,
    operationId: "block-patch-incremental-index-1",
    operations: [{
      type: "replace",
      blockId: changedBlockId,
      node: replacement,
    }],
  });

  assert.equal(response.status, 200);
  const payload = await response.json() as any;
  assert.equal(payload.indexUpdateMode, "incremental");
  assert.deepEqual(payload.indexedBlockIds, [changedBlockId]);
  assert.match(payload.contentText, /Changed link/);
  assert.match(payload.contentText, /Keep link/);

  const untouched = indexRow(noteId, untouchedBlockId);
  assert.equal(untouched?.createdAt, sentinel);
  assert.equal(untouched?.updatedAt, sentinel);
  assert.equal(untouched?.plainText, "Keep link");

  const changed = indexRow(noteId, changedBlockId);
  assert.equal(changed?.plainText, "Changed link");
  assert.notEqual(changed?.contentHash, "");

  const preservedLink = db.prepare(`
    SELECT id, targetNoteId, updatedAt FROM note_links
    WHERE sourceNoteId = ? AND sourceBlockId = ?
  `).get(noteId, untouchedBlockId) as any;
  assert.equal(preservedLink.id, "keep-link-row");
  assert.equal(preservedLink.targetNoteId, secondTarget);
  assert.equal(preservedLink.updatedAt, sentinel);

  const changedLinks = db.prepare(`
    SELECT targetNoteId FROM note_links
    WHERE sourceNoteId = ? AND sourceBlockId = ?
    ORDER BY targetNoteId
  `).all(noteId, changedBlockId) as Array<{ targetNoteId: string }>;
  assert.deepEqual(changedLinks.map((row) => row.targetNoteId), [secondTarget]);
});

test("refreshes indexed ancestors but preserves unrelated rows for nested leaf edits", async () => {
  const noteId = "66666666-6666-4666-8666-666666666666";
  const itemBlockId = "blk_itemnest";
  const nestedBlockId = "blk_paranest";
  const unrelatedBlockId = "blk_unrelated";
  insertNote(noteId, tiptap(
    {
      type: "bulletList",
      content: [{
        type: "listItem",
        attrs: { blockId: itemBlockId },
        content: [paragraph(nestedBlockId, "Nested before")],
      }],
    },
    paragraph(unrelatedBlockId, "Unrelated"),
  ));

  const sentinel = "2002-02-02 00:00:00";
  db.prepare(`
    UPDATE note_blocks_index SET updatedAt = ?
    WHERE noteId = ? AND blockId = ?
  `).run(sentinel, noteId, unrelatedBlockId);

  const response = await patch(noteId, {
    expectedNoteVersion: 1,
    operationId: "block-patch-incremental-index-nested",
    operations: [{ type: "update", blockId: nestedBlockId, text: "Nested after" }],
  });

  assert.equal(response.status, 200);
  const payload = await response.json() as any;
  assert.equal(payload.indexUpdateMode, "incremental");
  assert.deepEqual(payload.indexedBlockIds, [itemBlockId, nestedBlockId]);
  assert.equal(indexRow(noteId, itemBlockId)?.plainText, "Nested after");
  assert.equal(indexRow(noteId, nestedBlockId)?.plainText, "Nested after");
  assert.equal(indexRow(noteId, nestedBlockId)?.parentBlockId, itemBlockId);
  assert.equal(indexRow(noteId, unrelatedBlockId)?.updatedAt, sentinel);
});

test("updates a top-level block type incrementally", async () => {
  const noteId = "77777777-7777-4777-8777-777777777777";
  const blockId = "blk_convert0";
  insertNote(noteId, tiptap(paragraph(blockId, "Convertible")));

  const response = await patch(noteId, {
    expectedNoteVersion: 1,
    operationId: "block-patch-incremental-index-convert",
    operations: [{
      type: "replace",
      blockId,
      node: {
        type: "heading",
        attrs: { blockId, level: 3, textAlign: null, lineHeight: null },
        content: [{ type: "text", text: "Convertible" }],
      },
    }],
  });

  assert.equal(response.status, 200);
  const payload = await response.json() as any;
  assert.equal(payload.indexUpdateMode, "incremental");
  assert.deepEqual(payload.indexedBlockIds, [blockId]);
  assert.equal(indexRow(noteId, blockId)?.blockType, "heading");
});

test("falls back to a full rebuild when the existing index is stale", async () => {
  const noteId = "44444444-4444-4444-8444-444444444444";
  const changedBlockId = "blk_stale001";
  const otherBlockId = "blk_stale002";
  insertNote(noteId, tiptap(
    paragraph(changedBlockId, "Before"),
    paragraph(otherBlockId, "Unchanged"),
  ));
  db.prepare(`
    UPDATE note_blocks_index SET plainText = 'corrupted', contentHash = 'corrupted'
    WHERE noteId = ? AND blockId = ?
  `).run(noteId, otherBlockId);

  const response = await patch(noteId, {
    expectedNoteVersion: 1,
    operationId: "block-patch-incremental-index-stale",
    operations: [{ type: "update", blockId: changedBlockId, text: "After" }],
  });

  assert.equal(response.status, 200);
  const payload = await response.json() as any;
  assert.equal(payload.indexUpdateMode, "full");
  assert.equal(indexRow(noteId, otherBlockId)?.plainText, "Unchanged");
});

test("inserts a top-level simple Block and only shifts the affected suffix", async () => {
  const noteId = "55555555-5555-4555-8555-555555555555";
  const firstBlockId = "blk_struct01";
  const createdBlockId = "blk_struct02";
  const lastBlockId = "blk_struct03";
  insertNote(noteId, tiptap(
    paragraph(firstBlockId, "First"),
    paragraph(lastBlockId, "Last"),
  ));

  const sentinel = "2003-03-03 00:00:00";
  db.prepare("UPDATE note_blocks_index SET updatedAt = ? WHERE noteId = ?")
    .run(sentinel, noteId);

  const response = await patch(noteId, {
    expectedNoteVersion: 1,
    operationId: "block-patch-incremental-index-create",
    operations: [{
      type: "create",
      blockId: createdBlockId,
      clientId: createdBlockId,
      blockType: "paragraph",
      text: `[[note:${firstTarget}|Created]]`,
      afterBlockId: firstBlockId,
    }],
  });

  assert.equal(response.status, 200);
  const payload = await response.json() as any;
  assert.equal(payload.indexUpdateMode, "incremental");
  assert.deepEqual(payload.indexedBlockIds, [createdBlockId, lastBlockId]);
  assert.deepEqual(orderedBlockIds(noteId), [firstBlockId, createdBlockId, lastBlockId]);
  assert.equal(indexRow(noteId, firstBlockId)?.updatedAt, sentinel);
  assert.notEqual(indexRow(noteId, lastBlockId)?.updatedAt, sentinel);
  assert.equal(indexRow(noteId, createdBlockId)?.path, "1");
  assert.equal(indexRow(noteId, lastBlockId)?.path, "2");
  const createdLink = db.prepare(`
    SELECT targetNoteId FROM note_links
    WHERE sourceNoteId = ? AND sourceBlockId = ?
  `).get(noteId, createdBlockId) as { targetNoteId: string } | undefined;
  assert.equal(createdLink?.targetNoteId, firstTarget);
});

test("deletes a top-level simple Block without rebuilding unrelated prefixes or links", async () => {
  const noteId = "88888888-8888-4888-8888-888888888888";
  const firstBlockId = "blk_delete01";
  const deletedBlockId = "blk_delete02";
  const lastBlockId = "blk_delete03";
  insertNote(noteId, tiptap(
    paragraph(firstBlockId, "Keep first", firstTarget),
    paragraph(deletedBlockId, "Delete link", secondTarget),
    paragraph(lastBlockId, "Keep last"),
  ));

  const sentinel = "2004-04-04 00:00:00";
  db.prepare("UPDATE note_blocks_index SET updatedAt = ? WHERE noteId = ?")
    .run(sentinel, noteId);
  db.prepare(`
    UPDATE note_links SET id = 'keep-first-link', updatedAt = ?
    WHERE sourceNoteId = ? AND sourceBlockId = ?
  `).run(sentinel, noteId, firstBlockId);

  const response = await patch(noteId, {
    expectedNoteVersion: 1,
    operationId: "block-patch-incremental-index-delete",
    operations: [{ type: "delete", blockId: deletedBlockId }],
  });

  assert.equal(response.status, 200);
  const payload = await response.json() as any;
  assert.equal(payload.indexUpdateMode, "incremental");
  assert.deepEqual(payload.indexedBlockIds, [deletedBlockId, lastBlockId]);
  assert.deepEqual(orderedBlockIds(noteId), [firstBlockId, lastBlockId]);
  assert.equal(indexRow(noteId, deletedBlockId), undefined);
  assert.equal(indexRow(noteId, firstBlockId)?.updatedAt, sentinel);
  assert.notEqual(indexRow(noteId, lastBlockId)?.updatedAt, sentinel);
  assert.equal(indexRow(noteId, lastBlockId)?.path, "1");
  const deletedLinks = db.prepare(`
    SELECT COUNT(*) AS count FROM note_links
    WHERE sourceNoteId = ? AND sourceBlockId = ?
  `).get(noteId, deletedBlockId) as { count: number };
  assert.equal(deletedLinks.count, 0);
  const keptLink = db.prepare(`
    SELECT id, updatedAt FROM note_links
    WHERE sourceNoteId = ? AND sourceBlockId = ?
  `).get(noteId, firstBlockId) as { id: string; updatedAt: string };
  assert.equal(keptLink.id, "keep-first-link");
  assert.equal(keptLink.updatedAt, sentinel);
});

test("moves top-level simple Blocks while preserving all existing link rows", async () => {
  const noteId = "99999999-9999-4999-8999-999999999999";
  const firstBlockId = "blk_move0001";
  const secondBlockId = "blk_move0002";
  const thirdBlockId = "blk_move0003";
  insertNote(noteId, tiptap(
    paragraph(firstBlockId, "First", firstTarget),
    paragraph(secondBlockId, "Second", secondTarget),
    paragraph(thirdBlockId, "Third"),
  ));

  const linkIdsBefore = db.prepare(`
    SELECT sourceBlockId, id FROM note_links
    WHERE sourceNoteId = ? ORDER BY sourceBlockId
  `).all(noteId) as Array<{ sourceBlockId: string; id: string }>;

  const response = await patch(noteId, {
    expectedNoteVersion: 1,
    operationId: "block-patch-incremental-index-move",
    operations: [{
      type: "move",
      blockId: thirdBlockId,
      targetBlockId: firstBlockId,
      position: "before",
    }],
  });

  assert.equal(response.status, 200);
  const payload = await response.json() as any;
  assert.equal(payload.indexUpdateMode, "incremental");
  assert.deepEqual(payload.indexedBlockIds, [thirdBlockId, firstBlockId, secondBlockId]);
  assert.deepEqual(orderedBlockIds(noteId), [thirdBlockId, firstBlockId, secondBlockId]);
  const linkIdsAfter = db.prepare(`
    SELECT sourceBlockId, id FROM note_links
    WHERE sourceNoteId = ? ORDER BY sourceBlockId
  `).all(noteId) as Array<{ sourceBlockId: string; id: string }>;
  assert.deepEqual(linkIdsAfter, linkIdsBefore);
});

test("falls back when a structural shift would change nested container indexes", async () => {
  const noteId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const firstBlockId = "blk_complex01";
  const itemBlockId = "blk_complex02";
  const nestedBlockId = "blk_complex03";
  const createdBlockId = "blk_complex04";
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
    operationId: "block-patch-incremental-index-complex-fallback",
    operations: [{
      type: "create",
      blockId: createdBlockId,
      blockType: "paragraph",
      text: "Inserted before list",
      afterBlockId: firstBlockId,
    }],
  });

  assert.equal(response.status, 200);
  const payload = await response.json() as any;
  assert.equal(payload.indexUpdateMode, "full");
  assert.equal(indexRow(noteId, createdBlockId)?.plainText, "Inserted before list");
  assert.equal(indexRow(noteId, itemBlockId)?.path, "2.0");
  assert.equal(indexRow(noteId, nestedBlockId)?.path, "2.0.0");
});

test("keeps delete-all identity repair on the full rebuild path", async () => {
  const noteId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const onlyBlockId = "blk_deleteall";
  insertNote(noteId, tiptap(paragraph(onlyBlockId, "Only")));

  const response = await patch(noteId, {
    expectedNoteVersion: 1,
    operationId: "block-patch-incremental-index-delete-all",
    operations: [{ type: "delete", blockId: onlyBlockId }],
  });

  assert.equal(response.status, 200);
  const payload = await response.json() as any;
  assert.equal(payload.indexUpdateMode, "full");
  assert.equal(payload.createdBlocks.length, 1);
  assert.equal(orderedBlockIds(noteId).length, 1);
  assert.notEqual(orderedBlockIds(noteId)[0], onlyBlockId);
});
