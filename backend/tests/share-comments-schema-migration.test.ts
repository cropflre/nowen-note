import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-share-comments-migration-"));
const dbPath = path.join(tmpDir, "legacy.db");

process.env.DB_PATH = dbPath;
process.env.ELECTRON_USER_DATA = tmpDir;

const legacyDb = new Database(dbPath);
legacyDb.exec(`
  CREATE TABLE share_comments (
    id TEXT PRIMARY KEY,
    noteId TEXT NOT NULL,
    userId TEXT,
    guestName TEXT,
    guestIpHash TEXT,
    parentId TEXT,
    content TEXT NOT NULL,
    anchorData TEXT,
    isResolved INTEGER DEFAULT 0,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
  );

  INSERT INTO share_comments (id, noteId, content)
  VALUES ('legacy-comment', 'legacy-note', '旧评论');
`);
legacyDb.close();

let closeDb: typeof import("../src/db/schema").closeDb;

test.after(() => {
  closeDb?.();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("getDb upgrades legacy share_comments before creating the source index", async () => {
  const schema = await import("../src/db/schema");
  closeDb = schema.closeDb;

  const db = schema.getDb();
  const columns = db.prepare("PRAGMA table_info(share_comments)").all() as Array<{ name: string }>;
  const columnNames = new Set(columns.map((column) => column.name));
  assert.ok(columnNames.has("sourceType"));
  assert.ok(columnNames.has("sourceId"));
  assert.ok(columnNames.has("isHidden"));

  const index = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_share_comments_source'",
  ).get() as { name: string } | undefined;
  assert.equal(index?.name, "idx_share_comments_source");

  const legacyComment = db.prepare(
    "SELECT id, content, sourceType FROM share_comments WHERE id = ?",
  ).get("legacy-comment");
  assert.deepEqual(legacyComment, {
    id: "legacy-comment",
    content: "旧评论",
    sourceType: "note_share",
  });
});
