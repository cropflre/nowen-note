import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import type Database from "better-sqlite3";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-block-patch-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");
process.env.ELECTRON_USER_DATA = tmpDir;

const owner = "block-patch-owner";
const notebookId = "block-patch-notebook";

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

function tiptap(...nodes: any[]): string {
  return JSON.stringify({ type: "doc", content: nodes });
}

function insertNote(options: {
  id: string;
  content: string;
  format?: string;
  version?: number;
  locked?: boolean;
}) {
  db.prepare(`
    INSERT INTO notes (
      id, userId, notebookId, title, content, contentText, contentFormat, version, isLocked
    ) VALUES (?, ?, ?, ?, ?, '', ?, ?, ?)
  `).run(
    options.id,
    owner,
    notebookId,
    options.id,
    options.content,
    options.format || "tiptap-json",
    options.version || 1,
    options.locked ? 1 : 0,
  );
  syncNoteBlocks(db, options.id, options.content, options.format || "tiptap-json");
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
    .run(notebookId, owner, "Block patches");
});

test.after(() => {
  closeDb?.();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("applies a multi-block patch atomically with one note version increment", async () => {
  const noteId = "11111111-1111-4111-8111-111111111111";
  insertNote({
    id: noteId,
    content: tiptap(
      paragraph("blk_alpha00", "Alpha"),
      paragraph("blk_beta000", "Beta"),
    ),
  });
  const body = {
    expectedNoteVersion: 1,
    operationId: "block-patch-operation-0001",
    operations: [
      { type: "update", blockId: "blk_alpha00", text: "Alpha updated" },
      {
        type: "create",
        clientId: "client-gamma",
        blockId: "blk_gamma00",
        blockType: "paragraph",
        text: "Gamma",
        afterBlockId: "blk_alpha00",
      },
      {
        type: "move",
        blockId: "blk_beta000",
        targetBlockId: "blk_alpha00",
        position: "before",
      },
    ],
  };

  const response = await patch(noteId, body);
  assert.equal(response.status, 200);
  const payload = await response.json() as any;
  assert.equal(payload.version, 2);
  assert.equal(payload.operationCount, 3);
  assert.equal(payload.title, noteId);
  assert.equal(payload.contentFormat, "tiptap-json");
  assert.equal(payload.notebookId, notebookId);
  assert.equal(typeof payload.updatedAt, "string");
  assert.ok(payload.updatedAt.length > 0);
  assert.deepEqual(payload.createdBlocks, [{
    operationIndex: 1,
    clientId: "client-gamma",
    blockId: "blk_gamma00",
  }]);

  const stored = db.prepare(
    "SELECT content, contentText, version, updatedAt FROM notes WHERE id = ?",
  ).get(noteId) as any;
  const parsed = JSON.parse(stored.content);
  assert.equal(stored.version, 2);
  assert.deepEqual(parsed.content.map((node: any) => node.attrs.blockId), [
    "blk_beta000",
    "blk_alpha00",
    "blk_gamma00",
  ]);
  assert.equal(parsed.content[1].content[0].text, "Alpha updated");
  assert.equal(payload.content, stored.content);
  assert.equal(payload.contentText, stored.contentText);
  assert.equal(payload.updatedAt, stored.updatedAt);
  assert.match(payload.contentText, /Alpha updated/);
  assert.match(payload.contentText, /Gamma/);

  const replay = await patch(noteId, body);
  assert.equal(replay.status, 200);
  const replayPayload = await replay.json() as any;
  assert.equal(replayPayload.idempotentReplay, true);
  assert.equal(replayPayload.version, 2);
  assert.equal(replayPayload.content, payload.content);
  assert.equal(replayPayload.contentText, payload.contentText);
  assert.equal(replayPayload.updatedAt, payload.updatedAt);
});

test("rolls back every operation when a later block is missing", async () => {
  const noteId = "22222222-2222-4222-8222-222222222222";
  const original = tiptap(
    paragraph("blk_first000", "First"),
    paragraph("blk_second00", "Second"),
  );
  insertNote({ id: noteId, content: original });

  const response = await patch(noteId, {
    expectedNoteVersion: 1,
    operationId: "block-patch-operation-rollback",
    operations: [
      { type: "update", blockId: "blk_first000", text: "Should rollback" },
      { type: "delete", blockId: "blk_missing00" },
    ],
  });
  assert.equal(response.status, 404);
  const payload = await response.json() as any;
  assert.equal(payload.code, "BLOCK_NOT_FOUND");

  const stored = db.prepare("SELECT content, version FROM notes WHERE id = ?").get(noteId) as any;
  assert.equal(stored.version, 1);
  assert.equal(stored.content, original);
  const operation = db.prepare(`
    SELECT 1 FROM block_operations WHERE operationId = 'block-patch-operation-rollback'
  `).get();
  assert.equal(operation, undefined);
});

test("returns a version conflict without touching the document", async () => {
  const noteId = "33333333-3333-4333-8333-333333333333";
  const original = tiptap(paragraph("blk_version00", "Versioned"));
  insertNote({ id: noteId, content: original, version: 3 });

  const response = await patch(noteId, {
    expectedNoteVersion: 2,
    operationId: "block-patch-operation-version",
    operations: [{ type: "update", blockId: "blk_version00", text: "Stale" }],
  });
  assert.equal(response.status, 409);
  const payload = await response.json() as any;
  assert.equal(payload.code, "VERSION_CONFLICT");
  assert.equal(payload.currentVersion, 3);

  const stored = db.prepare("SELECT content, version FROM notes WHERE id = ?").get(noteId) as any;
  assert.equal(stored.content, original);
  assert.equal(stored.version, 3);
});

test("rejects reuse of one user-level operation ID on another note", async () => {
  const firstNoteId = "55555555-5555-4555-8555-555555555555";
  const secondNoteId = "66666666-6666-4666-8666-666666666666";
  insertNote({ id: firstNoteId, content: tiptap(paragraph("blk_first555", "First")) });
  insertNote({ id: secondNoteId, content: tiptap(paragraph("blk_second66", "Second")) });
  const operationId = "block-patch-shared-operation-id";

  const first = await patch(firstNoteId, {
    expectedNoteVersion: 1,
    operationId,
    operations: [{ type: "update", blockId: "blk_first555", text: "Updated first" }],
  });
  assert.equal(first.status, 200);

  const second = await patch(secondNoteId, {
    expectedNoteVersion: 1,
    operationId,
    operations: [{ type: "update", blockId: "blk_second66", text: "Must not apply" }],
  });
  assert.equal(second.status, 409);
  const payload = await second.json() as any;
  assert.equal(payload.code, "OPERATION_ID_CONFLICT");

  const stored = db.prepare("SELECT content, version FROM notes WHERE id = ?").get(secondNoteId) as any;
  assert.equal(stored.version, 1);
  assert.equal(JSON.parse(stored.content).content[0].content[0].text, "Second");
});

test("rejects Markdown notes until their block patch protocol is format-aware", async () => {
  const noteId = "44444444-4444-4444-8444-444444444444";
  insertNote({
    id: noteId,
    content: "Paragraph ^blk_markdown00\n",
    format: "markdown",
  });

  const response = await patch(noteId, {
    expectedNoteVersion: 1,
    operationId: "block-patch-operation-markdown",
    operations: [{ type: "update", blockId: "blk_markdown00", text: "Updated" }],
  });
  assert.equal(response.status, 400);
  const payload = await response.json() as any;
  assert.equal(payload.code, "BLOCK_FORMAT_UNSUPPORTED");
});
