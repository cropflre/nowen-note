import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Hono } from "hono";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-block-history-route-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");
process.env.ELECTRON_USER_DATA = tmpDir;

let closeDb: () => void;

test.after(() => {
  closeDb?.();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("block history route enforces read ACL and returns bounded newest-first pages", async () => {
  const [{ getDb, closeDb: close }, { default: notesRouter }, store, noteBlocks] = await Promise.all([
    import("../src/db/schema"),
    import("../src/routes/notes"),
    import("../src/lib/blockAuthorityStore"),
    import("../src/lib/noteBlocks"),
  ]);
  closeDb = close;
  const db = getDb();
  const ownerId = "block-history-owner";
  const strangerId = "block-history-stranger";
  const notebookId = "block-history-notebook";
  const noteId = "91919191-9191-4919-8919-919191919191";
  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, 'hash')").run(ownerId, ownerId);
  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, 'hash')").run(strangerId, strangerId);
  db.prepare("INSERT INTO notebooks (id, userId, name) VALUES (?, ?, 'History')").run(notebookId, ownerId);
  const content = JSON.stringify({
    type: "doc",
    content: [{
      type: "paragraph",
      attrs: { blockId: "blk_history_route" },
      content: [{ type: "text", text: "History" }],
    }],
  });
  db.prepare(`
    INSERT INTO notes (id, userId, notebookId, title, content, contentText, contentFormat, version)
    VALUES (?, ?, ?, 'History', ?, 'History', 'tiptap-json', 2)
  `).run(noteId, ownerId, notebookId, content);
  noteBlocks.syncNoteBlocks(db, noteId, content, "tiptap-json");
  store.rebuildBlockAuthorityStore(db, noteId, content, "tiptap-json", {
    noteVersion: 1,
    operationId: "history-create",
    operationType: "create",
    operationJson: { source: "create" },
  });
  store.rebuildBlockAuthorityStore(db, noteId, content, "tiptap-json", {
    noteVersion: 2,
    operationId: "history-save",
    operationType: "whole-save",
    operationJson: { source: "save" },
  });

  const app = new Hono();
  app.route("/notes", notesRouter);
  const forbidden = await app.request(`/notes/${noteId}/block-history`, {
    headers: { "X-User-Id": strangerId },
  });
  assert.equal(forbidden.status, 404);

  const response = await app.request(`/notes/${noteId}/block-history?limit=1`, {
    headers: { "X-User-Id": ownerId },
  });
  assert.equal(response.status, 200);
  const page = await response.json() as any;
  assert.equal(page.limit, 1);
  assert.equal(page.offset, 0);
  assert.equal(page.hasMore, true);
  assert.deepEqual(page.items[0], {
    noteVersion: 2,
    blockVersion: 1,
    structureVersion: 1,
    type: "whole-save",
    time: page.items[0].time,
    operationId: "history-save",
    operation: { source: "save" },
  });
  assert.equal(typeof page.items[0].time, "string");

  const capped = await app.request(`/notes/${noteId}/block-history?limit=999`, {
    headers: { "X-User-Id": ownerId },
  });
  assert.equal((await capped.json() as any).limit, 100);

  db.prepare("UPDATE note_block_operations SET operationJson = '{broken' WHERE noteId = ?")
    .run(noteId);
  const corrupted = await app.request(`/notes/${noteId}/block-history`, {
    headers: { "X-User-Id": ownerId },
  });
  assert.equal(corrupted.status, 500);
  assert.equal((await corrupted.json() as any).code, "BLOCK_HISTORY_CORRUPTED");
});
