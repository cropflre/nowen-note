import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import type Database from "better-sqlite3";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-block-list-structure-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");
process.env.ELECTRON_USER_DATA = tmpDir;

const owner = "block-list-structure-owner";
const notebookId = "block-list-structure-notebook";

let db: Database.Database;
let closeDb: () => void;
let app: Hono;
let syncNoteBlocks: typeof import("../src/lib/noteBlocks").syncNoteBlocks;
let syncNoteLinks: typeof import("../src/lib/noteLinks").syncNoteLinks;

function paragraph(blockId: string, text: string, marks?: unknown[]) {
  return {
    type: "paragraph",
    attrs: { blockId, textAlign: null, lineHeight: null },
    content: text ? [{ type: "text", text, ...(marks ? { marks } : {}) }] : [],
  };
}

function item(blockId: string, paragraphId: string, text: string, marks?: unknown[]) {
  return {
    type: "listItem",
    attrs: { blockId },
    content: [paragraph(paragraphId, text, marks)],
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
  syncNoteLinks(db, owner, id, content);
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

function row(noteId: string, blockId: string) {
  return db.prepare(`
    SELECT blockId, parentBlockId, blockOrder, path, createdAt, updatedAt
    FROM note_blocks_index WHERE noteId = ? AND blockId = ?
  `).get(noteId, blockId) as any;
}

function count(sql: string, ...values: unknown[]): number {
  const result = db.prepare(sql).get(...values) as { c: number } | undefined;
  return result?.c ?? 0;
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
    .run(notebookId, owner, "List structure patch");
});

test.after(() => {
  closeDb?.();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("creates one list item with incremental indexes and links", async () => {
  const noteId = "45454545-4545-4454-8454-454545454545";
  const targetNoteId = "56565656-5656-4565-8565-565656565656";
  insertNote(targetNoteId, tiptap(paragraph("blk_target00", "Target")));
  insertNote(noteId, tiptap(
    paragraph("blk_outside0", "Outside"),
    {
      type: "bulletList",
      content: [
        item("blk_item_a0", "blk_para_a0", "A"),
        item("blk_item_c0", "blk_para_c0", "C"),
      ],
    },
  ));
  db.prepare(`
    UPDATE note_blocks_index SET createdAt = '2000-01-01 00:00:00', updatedAt = '2000-01-01 00:00:00'
    WHERE noteId = ?
  `).run(noteId);

  const response = await patch(noteId, "list-structure-create-route", [{
    type: "create",
    scope: "listItem",
    clientId: "blk_item_b0",
    blockId: "blk_item_b0",
    targetBlockId: "blk_item_a0",
    position: "after",
    node: item("blk_item_b0", "blk_para_b0", "Linked", [{
      type: "link",
      attrs: {
        href: `note:${targetNoteId}`,
        target: null,
        rel: "noopener noreferrer nofollow",
        class: null,
      },
    }]),
  }]);

  assert.equal(response.status, 200);
  const payload = await response.json() as any;
  assert.equal(payload.version, 2);
  assert.equal(payload.indexUpdateMode, "incremental");
  assert.equal(payload.indexUpdateKind, "list-structural");
  assert.deepEqual(payload.createdBlocks, [{
    operationIndex: 0,
    clientId: "blk_item_b0",
    blockId: "blk_item_b0",
  }]);
  assert.deepEqual(payload.deletedBlockIds, []);

  const parsed = JSON.parse(payload.content);
  assert.deepEqual(parsed.content[1].content.map((entry: any) => entry.attrs.blockId), [
    "blk_item_a0",
    "blk_item_b0",
    "blk_item_c0",
  ]);
  assert.equal(row(noteId, "blk_para_b0").parentBlockId, "blk_item_b0");
  assert.equal(row(noteId, "blk_outside0").updatedAt, "2000-01-01 00:00:00");
  assert.equal(count(
    "SELECT COUNT(*) AS c FROM note_links WHERE sourceNoteId = ? AND sourceBlockId = ? AND targetNoteId = ?",
    noteId,
    "blk_para_b0",
    targetNoteId,
  ), 1);
  assert.equal(count("SELECT COUNT(*) AS c FROM note_versions WHERE noteId = ?", noteId), 1);

  const replay = await patch(noteId, "list-structure-create-route", []);
  assert.equal(replay.status, 200);
  const replayPayload = await replay.json() as any;
  assert.equal(replayPayload.idempotentReplay, true);
  assert.equal(replayPayload.indexUpdateKind, "list-structural");
  assert.equal(count("SELECT COUNT(*) AS c FROM note_versions WHERE noteId = ?", noteId), 1);
});

test("deletes one leaf list item and its link rows incrementally", async () => {
  const noteId = "67676767-6767-4676-8676-676767676767";
  const targetNoteId = "78787878-7878-4787-8787-787878787878";
  insertNote(targetNoteId, tiptap(paragraph("blk_target10", "Target")));
  insertNote(noteId, tiptap(
    paragraph("blk_outside1", "Outside"),
    {
      type: "bulletList",
      content: [
        item("blk_item_d0", "blk_para_d0", "D"),
        item("blk_item_e0", "blk_para_e0", "Linked", [{
          type: "link",
          attrs: {
            href: `note:${targetNoteId}`,
            target: null,
            rel: "noopener noreferrer nofollow",
            class: null,
          },
        }]),
        item("blk_item_f0", "blk_para_f0", "F"),
      ],
    },
  ));
  db.prepare(`
    UPDATE note_blocks_index SET createdAt = '2000-01-01 00:00:00', updatedAt = '2000-01-01 00:00:00'
    WHERE noteId = ?
  `).run(noteId);

  const response = await patch(noteId, "list-structure-delete-route", [{
    type: "delete",
    scope: "listItem",
    blockId: "blk_item_e0",
  }]);

  assert.equal(response.status, 200);
  const payload = await response.json() as any;
  assert.equal(payload.indexUpdateMode, "incremental");
  assert.equal(payload.indexUpdateKind, "list-structural");
  assert.deepEqual(payload.deletedBlockIds.sort(), ["blk_item_e0", "blk_para_e0"].sort());
  assert.equal(row(noteId, "blk_item_e0"), undefined);
  assert.equal(row(noteId, "blk_para_e0"), undefined);
  assert.equal(row(noteId, "blk_outside1").updatedAt, "2000-01-01 00:00:00");
  assert.equal(count(
    "SELECT COUNT(*) AS c FROM note_links WHERE sourceNoteId = ? AND sourceBlockId = ?",
    noteId,
    "blk_para_e0",
  ), 0);
});

test("persists an Enter split as one mixed list transaction", async () => {
  const noteId = "79797979-7979-4797-8797-797979797979";
  insertNote(noteId, tiptap(
    paragraph("blk_outside2", "Outside"),
    {
      type: "bulletList",
      content: [item("blk_split_a", "blk_split_pa", "Alpha Beta")],
    },
  ));
  db.prepare(`
    UPDATE note_blocks_index SET createdAt = '2000-01-01 00:00:00', updatedAt = '2000-01-01 00:00:00'
    WHERE noteId = ?
  `).run(noteId);

  const response = await patch(noteId, "list-structure-split-route", [
    {
      type: "replace",
      blockId: "blk_split_pa",
      node: paragraph("blk_split_pa", "Alpha"),
    },
    {
      type: "create",
      scope: "listItem",
      clientId: "blk_split_b",
      blockId: "blk_split_b",
      targetBlockId: "blk_split_a",
      position: "after",
      node: item("blk_split_b", "blk_split_pb", "Beta"),
    },
  ]);

  assert.equal(response.status, 200);
  const payload = await response.json() as any;
  assert.equal(payload.version, 2);
  assert.equal(payload.operationCount, 2);
  assert.equal(payload.indexUpdateMode, "incremental");
  assert.equal(payload.indexUpdateKind, "list-mixed");
  const parsed = JSON.parse(payload.content);
  assert.deepEqual(parsed.content[1].content.map((entry: any) => entry.attrs.blockId), [
    "blk_split_a",
    "blk_split_b",
  ]);
  assert.equal(parsed.content[1].content[0].content[0].content[0].text, "Alpha");
  assert.equal(row(noteId, "blk_outside2").updatedAt, "2000-01-01 00:00:00");
  assert.equal(count("SELECT COUNT(*) AS c FROM note_versions WHERE noteId = ?", noteId), 1);
});

test("lifts a root list item with incremental structural indexes", async () => {
  const noteId = "81818181-8181-4818-8818-818181818181";
  insertNote(noteId, tiptap({
    type: "bulletList",
    content: [
      item("blk_lift_a0", "blk_lift_pa", "A"),
      item("blk_lift_b0", "blk_lift_pb", "B"),
    ],
  }));

  const response = await patch(noteId, "list-structure-top-lift", [{
    type: "lift",
    scope: "listItem",
    blockId: "blk_lift_b0",
    position: "after",
  }]);

  assert.equal(response.status, 200);
  const payload = await response.json() as any;
  assert.equal(payload.indexUpdateMode, "incremental");
  assert.equal(payload.indexUpdateKind, "list-structural");
  assert.deepEqual(payload.deletedBlockIds, ["blk_lift_b0"]);
  assert.equal(row(noteId, "blk_lift_b0"), undefined);
  assert.equal(row(noteId, "blk_lift_pb").parentBlockId, null);
  const parsed = JSON.parse(payload.content);
  assert.equal(parsed.content[1].type, "paragraph");
  assert.equal(parsed.content[1].attrs.blockId, "blk_lift_pb");
});

test("falls back to full synchronization when the pre-patch index is stale", async () => {
  const noteId = "89898989-8989-4898-8989-898989898989";
  insertNote(noteId, tiptap({
    type: "bulletList",
    content: [
      item("blk_item_g0", "blk_para_g0", "G"),
      item("blk_item_h0", "blk_para_h0", "H"),
    ],
  }));
  db.prepare("DELETE FROM note_blocks_index WHERE noteId = ? AND blockId = ?")
    .run(noteId, "blk_para_g0");

  const response = await patch(noteId, "list-structure-stale-route", [{
    type: "create",
    scope: "listItem",
    clientId: "blk_item_i0",
    blockId: "blk_item_i0",
    targetBlockId: "blk_item_h0",
    position: "after",
    node: item("blk_item_i0", "blk_para_i0", "I"),
  }]);

  assert.equal(response.status, 200);
  const payload = await response.json() as any;
  assert.equal(payload.indexUpdateMode, "full");
  assert.equal(payload.indexUpdateKind, "full");
  assert.ok(row(noteId, "blk_para_g0"));
  assert.ok(row(noteId, "blk_para_i0"));
});

test("rejects deleting the final list item before persistence", async () => {
  const noteId = "90909090-9090-4909-8909-909090909090";
  const original = tiptap({
    type: "bulletList",
    content: [item("blk_item_z0", "blk_para_z0", "Only")],
  });
  insertNote(noteId, original);

  const response = await patch(noteId, "list-structure-final-delete", [{
    type: "delete",
    scope: "listItem",
    blockId: "blk_item_z0",
  }]);

  assert.equal(response.status, 400);
  const payload = await response.json() as any;
  assert.equal(payload.code, "LIST_STRUCTURE_INVALID");
  const stored = db.prepare("SELECT content, version FROM notes WHERE id = ?").get(noteId) as any;
  assert.equal(stored.content, original);
  assert.equal(stored.version, 1);
  assert.equal(count("SELECT COUNT(*) AS c FROM note_versions WHERE noteId = ?", noteId), 0);
});
