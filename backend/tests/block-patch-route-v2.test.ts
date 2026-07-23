import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import type Database from "better-sqlite3";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-block-patch-v2-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");
process.env.ELECTRON_USER_DATA = tmpDir;

const owner = "block-patch-v2-owner";
const notebookId = "block-patch-v2-notebook";

let db: Database.Database;
let closeDb: () => void;
let app: Hono;
let syncNoteBlocks: typeof import("../src/lib/noteBlocks").syncNoteBlocks;

function paragraph(blockId: string, text: string) {
  return {
    type: "paragraph",
    attrs: { blockId, textAlign: null, lineHeight: null },
    content: text ? [{ type: "text", text }] : [],
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
  syncNoteBlocks(db, id, content, "tiptap-json");
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

function countRows(sql: string, value: string): number {
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
    .run(notebookId, owner, "Block patch V2");
});

test.after(() => {
  closeDb?.();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("persists a rich block replacement and refreshes block/link indexes transactionally", async () => {
  const noteId = "77777777-7777-4777-8777-777777777777";
  const targetNoteId = "88888888-8888-4888-8888-888888888888";
  const blockId = "blk_routev200";
  const original = tiptap(paragraph(blockId, "Before"));
  insertNote(noteId, original);
  insertNote(targetNoteId, tiptap(paragraph("blk_target00", "Target")));

  const response = await patch(noteId, {
    expectedNoteVersion: 1,
    operationId: "block-patch-v2-rich-route",
    operations: [{
      type: "replace",
      blockId,
      node: {
        type: "heading",
        attrs: { blockId, level: 3, textAlign: "center", lineHeight: "1.6" },
        content: [
          { type: "text", text: "Linked ", marks: [{ type: "bold" }] },
          {
            type: "text",
            text: "target",
            marks: [{
              type: "link",
              attrs: {
                href: `note:${targetNoteId}`,
                target: null,
                rel: "noopener noreferrer nofollow",
                class: null,
              },
            }],
          },
        ],
      },
    }],
  });

  assert.equal(response.status, 200);
  const payload = await response.json() as any;
  assert.equal(payload.version, 2);
  assert.deepEqual(payload.affectedBlockIds, [blockId]);

  const stored = db.prepare(
    "SELECT content, contentText, version FROM notes WHERE id = ?",
  ).get(noteId) as any;
  const parsed = JSON.parse(stored.content);
  assert.equal(stored.version, 2);
  assert.equal(parsed.content[0].type, "heading");
  assert.equal(parsed.content[0].attrs.level, 3);
  assert.equal(parsed.content[0].content[0].marks[0].type, "bold");
  assert.match(stored.contentText, /Linked target/);
  assert.equal(payload.content, stored.content);

  const blockRow = db.prepare(`
    SELECT blockType, plainText FROM note_blocks_index
    WHERE noteId = ? AND blockId = ?
  `).get(noteId, blockId) as any;
  assert.equal(blockRow.blockType, "heading");
  assert.equal(blockRow.plainText, "Linked target");

  const linkRow = db.prepare(`
    SELECT targetNoteId FROM note_links
    WHERE sourceNoteId = ? AND targetNoteId = ?
  `).get(noteId, targetNoteId) as any;
  assert.equal(linkRow.targetNoteId, targetNoteId);

  const version = db.prepare(`
    SELECT content, version, changeType FROM note_versions
    WHERE noteId = ?
  `).get(noteId) as any;
  assert.equal(version.content, original);
  assert.equal(version.version, 1);
  assert.equal(version.changeType, "edit");
});

test("rejects an unsafe rich replacement before content, history or idempotency changes", async () => {
  const noteId = "99999999-9999-4999-8999-999999999999";
  const blockId = "blk_unsafe00";
  const original = tiptap(paragraph(blockId, "Safe"));
  insertNote(noteId, original);

  const response = await patch(noteId, {
    expectedNoteVersion: 1,
    operationId: "block-patch-v2-unsafe-route",
    operations: [{
      type: "replace",
      blockId,
      node: {
        type: "paragraph",
        attrs: { blockId, textAlign: null, lineHeight: null },
        content: [{
          type: "text",
          text: "Unsafe",
          marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }],
        }],
      },
    }],
  });

  assert.equal(response.status, 400);
  const payload = await response.json() as any;
  assert.equal(payload.code, "INVALID_BLOCK_NODE");

  const stored = db.prepare("SELECT content, version FROM notes WHERE id = ?").get(noteId) as any;
  assert.equal(stored.content, original);
  assert.equal(stored.version, 1);
  assert.equal(countRows("SELECT COUNT(*) AS c FROM note_versions WHERE noteId = ?", noteId), 0);
  assert.equal(countRows(
    "SELECT COUNT(*) AS c FROM block_operations WHERE operationId = ?",
    "block-patch-v2-unsafe-route",
  ), 0);
});
