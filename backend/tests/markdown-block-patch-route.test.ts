import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import type Database from "better-sqlite3";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-markdown-block-patch-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");
process.env.ELECTRON_USER_DATA = tmpDir;

const owner = "markdown-block-patch-owner";
const notebookId = "markdown-block-patch-notebook";
let db: Database.Database;
let closeDb: () => void;
let app: Hono;

test.before(async () => {
  const schema = await import("../src/db/schema");
  await import("../src/runtime/block-patch");
  const blockRoute = await import("../src/routes/blocks");
  db = schema.getDb();
  closeDb = schema.closeDb;
  app = new Hono();
  app.route("/api/blocks", blockRoute.default);
  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)").run(owner, owner, "hash");
  db.prepare("INSERT INTO notebooks (id, userId, name) VALUES (?, ?, ?)").run(notebookId, owner, "Markdown Patch");
});

test.after(() => {
  closeDb?.();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("persists Markdown Patch, history and full block index in one version", async () => {
  const noteId = "13131313-1313-4313-8313-131313131313";
  const content = "# Before ^blk_heading00\n\nBody ^blk_body00000";
  db.prepare(`
    INSERT INTO notes (id, userId, notebookId, title, content, contentText, contentFormat, version, isLocked)
    VALUES (?, ?, ?, 'Markdown', ?, '', 'markdown', 1, 0)
  `).run(noteId, owner, notebookId, content);
  const { syncNoteBlocks } = await import("../src/lib/noteBlocks");
  const { parseMarkdownPatchDocument } = await import("../src/lib/markdownBlockPatch");
  syncNoteBlocks(db, noteId, content, "markdown");
  const heading = parseMarkdownPatchDocument(content).blocks[0];

  const response = await app.request(`/api/blocks/${noteId}/patch`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-User-Id": owner },
    body: JSON.stringify({
      expectedNoteVersion: 1,
      operationId: "markdown-patch-route-001",
      operations: [{
        type: "replace",
        blockId: heading.blockId,
        expectedHash: heading.contentHash,
        content: "## After ^blk_heading00",
      }],
    }),
  });
  assert.equal(response.status, 200);
  const payload = await response.json() as any;
  assert.equal(payload.version, 2);
  assert.equal(payload.indexUpdateMode, "full");
  assert.match(payload.content, /## After/);
  assert.equal((db.prepare("SELECT version FROM notes WHERE id = ?").get(noteId) as any).version, 2);
  assert.equal((db.prepare("SELECT COUNT(*) AS c FROM note_versions WHERE noteId = ?").get(noteId) as any).c, 1);
  assert.equal((db.prepare("SELECT plainText FROM note_blocks_index WHERE noteId = ? AND blockId = ?").get(noteId, heading.blockId) as any).plainText, "After");
});

test("rejects a stale Markdown Block hash without writing history", async () => {
  const noteId = "14141414-1414-4414-8414-141414141414";
  const content = "Body ^blk_stale0000";
  db.prepare(`
    INSERT INTO notes (id, userId, notebookId, title, content, contentText, contentFormat, version, isLocked)
    VALUES (?, ?, ?, 'Markdown', ?, '', 'markdown', 1, 0)
  `).run(noteId, owner, notebookId, content);
  const response = await app.request(`/api/blocks/${noteId}/patch`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-User-Id": owner },
    body: JSON.stringify({
      expectedNoteVersion: 1,
      operationId: "markdown-patch-route-stale",
      operations: [{ type: "delete", blockId: "blk_stale0000", expectedHash: "0000000000000000" }],
    }),
  });
  assert.equal(response.status, 409);
  assert.equal((await response.json() as any).code, "BLOCK_HASH_CONFLICT");
  assert.equal((db.prepare("SELECT COUNT(*) AS c FROM note_versions WHERE noteId = ?").get(noteId) as any).c, 0);
});
