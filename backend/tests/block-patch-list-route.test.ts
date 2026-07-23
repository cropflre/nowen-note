import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import type Database from "better-sqlite3";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-block-list-route-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");
process.env.ELECTRON_USER_DATA = tmpDir;

const owner = "block-list-owner";
const notebookId = "block-list-notebook";

let db: Database.Database;
let closeDb: () => void;
let app: Hono;
let syncNoteBlocks: typeof import("../src/lib/noteBlocks").syncNoteBlocks;

function paragraph(blockId: string, text: string) {
  return {
    type: "paragraph",
    attrs: { blockId },
    content: text ? [{ type: "text", text }] : [],
  };
}

function item(blockId: string, paragraphId: string, text: string) {
  return {
    type: "listItem",
    attrs: { blockId },
    content: [paragraph(paragraphId, text)],
  };
}

function documentContent(): string {
  return JSON.stringify({
    type: "doc",
    content: [{
      type: "bulletList",
      content: [
        item("blk_item_a0", "blk_para_a0", "A"),
        item("blk_item_b0", "blk_para_b0", "B"),
        item("blk_item_c0", "blk_para_c0", "C"),
      ],
    }],
  });
}

function insertNote(id: string, content: string) {
  db.prepare(`
    INSERT INTO notes (
      id, userId, notebookId, title, content, contentText, contentFormat, version, isLocked
    ) VALUES (?, ?, ?, ?, ?, '', 'tiptap-json', 1, 0)
  `).run(id, owner, notebookId, id, content);
  syncNoteBlocks(db, id, content, "tiptap-json");
}

async function patch(noteId: string, operationId: string, operations: unknown[]) {
  return app.request(`/api/blocks/${noteId}/patch`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-User-Id": owner,
    },
    body: JSON.stringify({
      expectedNoteVersion: 1,
      operationId,
      operations,
    }),
  });
}

function count(sql: string, value: string): number {
  const row = db.prepare(sql).get(value) as { c: number } | undefined;
  return row?.c ?? 0;
}

test.before(async () => {
  const [schema, noteBlocks] = await Promise.all([
    import("../src/db/schema"),
    import("../src/lib/noteBlocks"),
  ]);
  await import("../src/runtime/block-patch");
  const blockRoute = await import("../src/routes/blocks");

  db = schema.getDb();
  closeDb = schema.closeDb;
  syncNoteBlocks = noteBlocks.syncNoteBlocks;
  app = new Hono();
  app.route("/api/blocks", blockRoute.default);

  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
    .run(owner, owner, "hash");
  db.prepare("INSERT INTO notebooks (id, userId, name) VALUES (?, ?, ?)")
    .run(notebookId, owner, "List patch");
});

test.after(() => {
  closeDb?.();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("persists a controlled sink with one version and incremental list-subtree indexes", async () => {
  const noteId = "12121212-1212-4212-8212-121212121212";
  const targetNoteId = "56565656-5656-4565-8565-565656565656";
  const original = documentContent();
  insertNote(noteId, original);
  insertNote(targetNoteId, JSON.stringify({
    type: "doc",
    content: [paragraph("blk_target00", "Target")],
  }));

  db.prepare(`
    UPDATE note_blocks_index
    SET createdAt = '2000-01-01 00:00:00', updatedAt = '2000-01-01 00:00:00'
    WHERE noteId = ?
  `).run(noteId);
  db.prepare(`
    INSERT INTO note_links (
      id, userId, sourceNoteId, targetNoteId, targetBlockId, sourceBlockId,
      linkType, linkText, excerpt, createdAt, updatedAt
    ) VALUES (?, ?, ?, ?, NULL, ?, 'note', NULL, 'stable', ?, ?)
  `).run(
    "list-link-stable",
    owner,
    noteId,
    targetNoteId,
    "blk_para_b0",
    "2000-01-01 00:00:00",
    "2000-01-01 00:00:00",
  );

  const operations = [{
    type: "move",
    scope: "listItem",
    blockId: "blk_item_b0",
    targetBlockId: "blk_item_a0",
    position: "inside",
  }];
  const response = await patch(noteId, "block-list-sink-route", operations);

  assert.equal(response.status, 200);
  const payload = await response.json() as any;
  assert.equal(payload.version, 2);
  assert.equal(payload.indexUpdateMode, "incremental");
  assert.equal(payload.indexUpdateKind, "list-subtree");
  assert.deepEqual(payload.affectedBlockIds.sort(), ["blk_item_a0", "blk_item_b0"].sort());
  assert.deepEqual(new Set(payload.indexedBlockIds), new Set([
    "blk_item_a0",
    "blk_item_b0",
    "blk_para_b0",
    "blk_item_c0",
    "blk_para_c0",
  ]));

  const parsed = JSON.parse(payload.content);
  assert.deepEqual(parsed.content[0].content.map((node: any) => node.attrs.blockId), [
    "blk_item_a0",
    "blk_item_c0",
  ]);
  assert.equal(parsed.content[0].content[0].content[1].content[0].attrs.blockId, "blk_item_b0");

  const rows = db.prepare(`
    SELECT blockId, parentBlockId, path, updatedAt
    FROM note_blocks_index
    WHERE noteId = ?
  `).all(noteId) as Array<{
    blockId: string;
    parentBlockId: string | null;
    path: string;
    updatedAt: string;
  }>;
  const byId = new Map(rows.map((row) => [row.blockId, row]));
  assert.equal(byId.get("blk_item_a0")?.parentBlockId, null);
  assert.equal(byId.get("blk_item_b0")?.parentBlockId, "blk_item_a0");
  assert.match(byId.get("blk_item_b0")?.path || "", /^0\.0\./);
  assert.equal(byId.get("blk_para_b0")?.parentBlockId, "blk_item_b0");
  assert.equal(byId.get("blk_para_a0")?.updatedAt, "2000-01-01 00:00:00");
  assert.notEqual(byId.get("blk_item_a0")?.updatedAt, "2000-01-01 00:00:00");

  const link = db.prepare(`
    SELECT id, createdAt, updatedAt FROM note_links
    WHERE sourceNoteId = ? AND sourceBlockId = ?
  `).get(noteId, "blk_para_b0") as {
    id: string;
    createdAt: string;
    updatedAt: string;
  } | undefined;
  assert.deepEqual(link, {
    id: "list-link-stable",
    createdAt: "2000-01-01 00:00:00",
    updatedAt: "2000-01-01 00:00:00",
  });

  const stored = db.prepare("SELECT content, version FROM notes WHERE id = ?").get(noteId) as any;
  assert.equal(stored.content, payload.content);
  assert.equal(stored.version, 2);
  assert.equal(count("SELECT COUNT(*) AS c FROM note_versions WHERE noteId = ?", noteId), 1);

  const replay = await patch(noteId, "block-list-sink-route", operations);
  assert.equal(replay.status, 200);
  const replayPayload = await replay.json() as any;
  assert.equal(replayPayload.idempotentReplay, true);
  assert.equal(replayPayload.content, payload.content);
  assert.equal(replayPayload.indexUpdateKind, "list-subtree");
  assert.equal(count("SELECT COUNT(*) AS c FROM note_versions WHERE noteId = ?", noteId), 1);
});

test("falls back to full synchronization when the persisted list index is stale", async () => {
  const noteId = "78787878-7878-4787-8787-787878787878";
  insertNote(noteId, documentContent());
  db.prepare(`
    UPDATE note_blocks_index SET path = 'broken.path'
    WHERE noteId = ? AND blockId = 'blk_item_b0'
  `).run(noteId);

  const response = await patch(noteId, "block-list-stale-index", [{
    type: "move",
    scope: "listItem",
    blockId: "blk_item_b0",
    targetBlockId: "blk_item_a0",
    position: "inside",
  }]);

  assert.equal(response.status, 200);
  const payload = await response.json() as any;
  assert.equal(payload.indexUpdateMode, "full");
  assert.equal(payload.indexUpdateKind, "full");
  const row = db.prepare(`
    SELECT parentBlockId, path FROM note_blocks_index
    WHERE noteId = ? AND blockId = 'blk_item_b0'
  `).get(noteId) as { parentBlockId: string | null; path: string };
  assert.equal(row.parentBlockId, "blk_item_a0");
  assert.notEqual(row.path, "broken.path");
});

test("rejects an unsafe non-adjacent sink without changing persistence", async () => {
  const noteId = "34343434-3434-4434-8434-343434343434";
  const original = documentContent();
  insertNote(noteId, original);

  const response = await patch(noteId, "block-list-invalid-route", [{
    type: "move",
    scope: "listItem",
    blockId: "blk_item_c0",
    targetBlockId: "blk_item_a0",
    position: "inside",
  }]);

  assert.equal(response.status, 400);
  const payload = await response.json() as any;
  assert.equal(payload.code, "LIST_MOVE_INVALID");

  const stored = db.prepare("SELECT content, version FROM notes WHERE id = ?").get(noteId) as any;
  assert.equal(stored.content, original);
  assert.equal(stored.version, 1);
  assert.equal(count("SELECT COUNT(*) AS c FROM note_versions WHERE noteId = ?", noteId), 0);
  assert.equal(count(
    "SELECT COUNT(*) AS c FROM block_operations WHERE operationId = ?",
    "block-list-invalid-route",
  ), 0);
});
