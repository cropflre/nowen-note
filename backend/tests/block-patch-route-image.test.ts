import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import type Database from "better-sqlite3";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-block-patch-image-route-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");
process.env.ELECTRON_USER_DATA = tmpDir;

const owner = "block-patch-image-owner";
const notebookId = "block-patch-image-notebook";

let db: Database.Database;
let closeDb: () => void;
let app: Hono;
let syncNoteBlocks: typeof import("../src/lib/noteBlocks").syncNoteBlocks;

function paragraph(blockId: string, content: unknown[]) {
  return {
    type: "paragraph",
    attrs: { blockId, textAlign: null, lineHeight: null },
    content,
  };
}

function documentWith(...nodes: unknown[]): string {
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

async function patch(noteId: string, operationId: string, node: unknown) {
  return app.request(`/api/blocks/${noteId}/patch`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-User-Id": owner,
    },
    body: JSON.stringify({
      expectedNoteVersion: 1,
      operationId,
      operations: [{ type: "replace", blockId: "blk_image_route", node }],
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
    .run(notebookId, owner, "Image Block Patch");
});

test.after(() => {
  closeDb?.();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("persists safe image presentation attrs through one incremental leaf transaction", async () => {
  const noteId = "11111111-aaaa-4111-8111-111111111111";
  const src = "/api/attachments/22222222-bbbb-4222-8222-222222222222/content";
  const originalNode = paragraph("blk_image_route", [
    { type: "text", text: "Before " },
    {
      type: "image",
      attrs: {
        src,
        alt: "Diagram",
        title: null,
        width: 320,
        height: 180,
        rotation: 0,
        flipX: false,
      },
    },
    { type: "text", text: " after" },
  ]);
  const outside = paragraph("blk_image_outside", [{ type: "text", text: "Outside" }]);
  const original = documentWith(originalNode, outside);
  insertNote(noteId, original);
  db.prepare(`
    UPDATE note_blocks_index
    SET createdAt = '2000-01-01 00:00:00', updatedAt = '2000-01-01 00:00:00'
    WHERE noteId = ?
  `).run(noteId);

  const nextNode = paragraph("blk_image_route", [
    { type: "text", text: "Before " },
    {
      type: "image",
      attrs: {
        src,
        alt: "Diagram",
        title: "Rotated diagram",
        width: 640,
        height: 360,
        rotation: 90,
        flipX: true,
      },
    },
    { type: "text", text: " after" },
  ]);
  const response = await patch(noteId, "block-patch-image-route-safe", nextNode);

  assert.equal(response.status, 200);
  const payload = await response.json() as any;
  assert.equal(payload.version, 2);
  assert.equal(payload.indexUpdateMode, "incremental");
  assert.equal(payload.indexUpdateKind, "leaf");
  assert.deepEqual(payload.affectedBlockIds, ["blk_image_route"]);
  assert.ok(payload.indexedBlockIds.includes("blk_image_route"));

  const stored = db.prepare(
    "SELECT content, contentText, version FROM notes WHERE id = ?",
  ).get(noteId) as any;
  const parsed = JSON.parse(stored.content);
  assert.equal(stored.version, 2);
  assert.equal(stored.contentText, "Before  after\n\nOutside");
  assert.deepEqual(parsed.content[0], nextNode);
  assert.equal(payload.content, stored.content);

  const imageRow = db.prepare(`
    SELECT plainText FROM note_blocks_index WHERE noteId = ? AND blockId = ?
  `).get(noteId, "blk_image_route") as any;
  assert.equal(imageRow.plainText, "Before  after");

  const outsideRow = db.prepare(`
    SELECT updatedAt FROM note_blocks_index WHERE noteId = ? AND blockId = ?
  `).get(noteId, "blk_image_outside") as any;
  assert.equal(outsideRow.updatedAt, "2000-01-01 00:00:00");

  const version = db.prepare(`
    SELECT content, version FROM note_versions WHERE noteId = ?
  `).get(noteId) as any;
  assert.equal(version.content, original);
  assert.equal(version.version, 1);
});

test("rejects an unsafe image source before persistence", async () => {
  const noteId = "33333333-cccc-4333-8333-333333333333";
  const originalNode = paragraph("blk_image_route", [
    { type: "image", attrs: { src: "https://example.com/safe.png", width: 320 } },
  ]);
  const original = documentWith(originalNode);
  insertNote(noteId, original);

  const unsafeNode = paragraph("blk_image_route", [
    { type: "image", attrs: { src: "javascript:alert(1)", width: 640 } },
  ]);
  const response = await patch(noteId, "block-patch-image-route-unsafe", unsafeNode);

  assert.equal(response.status, 400);
  const payload = await response.json() as any;
  assert.equal(payload.code, "INVALID_BLOCK_NODE");

  const stored = db.prepare("SELECT content, version FROM notes WHERE id = ?").get(noteId) as any;
  assert.equal(stored.content, original);
  assert.equal(stored.version, 1);
  assert.equal(count("SELECT COUNT(*) AS c FROM note_versions WHERE noteId = ?", noteId), 0);
  assert.equal(count(
    "SELECT COUNT(*) AS c FROM block_operations WHERE operationId = ?",
    "block-patch-image-route-unsafe",
  ), 0);
});
