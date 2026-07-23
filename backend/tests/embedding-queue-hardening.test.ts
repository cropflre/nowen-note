import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-embedding-queue-hardening-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");
process.env.NODE_ENV = "test";

let closeDb: () => void;
let getDb: typeof import("../src/db/schema").getDb;
let recoverInterruptedEmbeddingJobs: typeof import("../src/runtime/embedding-queue-hardening").recoverInterruptedEmbeddingJobs;
let recoverStaleEmbeddingJobs: typeof import("../src/runtime/embedding-queue-hardening").recoverStaleEmbeddingJobs;
let wakeAttachmentOnlyQueue: typeof import("../src/runtime/embedding-queue-hardening").wakeAttachmentOnlyQueue;

function createNote(id: string): void {
  const db = getDb();
  db.prepare("INSERT OR IGNORE INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
    .run("queue-user", "queue-user", "hash");
  db.prepare("INSERT OR IGNORE INTO notebooks (id, userId, name) VALUES (?, ?, ?)")
    .run("queue-notebook", "queue-user", "Queue");
  db.prepare("INSERT INTO notes (id, userId, notebookId, title, contentText) VALUES (?, ?, ?, ?, ?)")
    .run(id, "queue-user", "queue-notebook", `Title ${id}`, "Long enough body for embedding queue tests");
}

function insertAttachmentQueue(id: string, noteId: string, status: string, updatedAt = "2000-01-01 00:00:00"): void {
  const db = getDb();
  db.pragma("foreign_keys = OFF");
  db.prepare(`
    INSERT OR REPLACE INTO attachment_embedding_queue
      (attachmentId, userId, workspaceId, noteId, status, retries, enqueuedAt, updatedAt)
    VALUES (?, 'queue-user', NULL, ?, ?, 0, ?, ?)
  `).run(id, noteId, status, updatedAt, updatedAt);
  db.pragma("foreign_keys = ON");
}

test.before(async () => {
  const [schema, hardening] = await Promise.all([
    import("../src/db/schema"),
    import("../src/runtime/embedding-queue-hardening"),
  ]);
  closeDb = schema.closeDb;
  getDb = schema.getDb;
  recoverInterruptedEmbeddingJobs = hardening.recoverInterruptedEmbeddingJobs;
  recoverStaleEmbeddingJobs = hardening.recoverStaleEmbeddingJobs;
  wakeAttachmentOnlyQueue = hardening.wakeAttachmentOnlyQueue;
});

test.after(() => {
  closeDb?.();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("startup recovery returns interrupted note and attachment jobs to pending", () => {
  createNote("queue-restart-note");
  getDb().prepare("UPDATE embedding_queue SET status = 'processing' WHERE noteId = ?")
    .run("queue-restart-note");
  insertAttachmentQueue("queue-restart-attachment", "queue-restart-note", "processing");

  assert.deepEqual(recoverInterruptedEmbeddingJobs(), { notes: 1, attachments: 1 });
  assert.equal(
    (getDb().prepare("SELECT status FROM embedding_queue WHERE noteId = ?").get("queue-restart-note") as { status: string }).status,
    "pending",
  );
  assert.equal(
    (getDb().prepare("SELECT status FROM attachment_embedding_queue WHERE attachmentId = ?").get("queue-restart-attachment") as { status: string }).status,
    "pending",
  );
});

test("lease recovery only requeues stale processing jobs", () => {
  createNote("queue-stale-note");
  createNote("queue-active-note");
  getDb().prepare("UPDATE embedding_queue SET status = 'processing', updatedAt = '2000-01-01 00:00:00' WHERE noteId = ?")
    .run("queue-stale-note");
  getDb().prepare("UPDATE embedding_queue SET status = 'processing', updatedAt = datetime('now') WHERE noteId = ?")
    .run("queue-active-note");
  insertAttachmentQueue("queue-stale-attachment", "queue-stale-note", "processing");
  insertAttachmentQueue("queue-active-attachment", "queue-active-note", "processing", new Date().toISOString());

  assert.deepEqual(recoverStaleEmbeddingJobs(), { notes: 1, attachments: 1 });
  assert.equal(
    (getDb().prepare("SELECT status FROM embedding_queue WHERE noteId = ?").get("queue-stale-note") as { status: string }).status,
    "pending",
  );
  assert.equal(
    (getDb().prepare("SELECT status FROM embedding_queue WHERE noteId = ?").get("queue-active-note") as { status: string }).status,
    "processing",
  );
});

test("pending attachment work wakes the legacy worker when the note queue is idle", () => {
  createNote("queue-attachment-only-note");
  getDb().prepare("UPDATE embedding_queue SET status = 'done' WHERE noteId = ?")
    .run("queue-attachment-only-note");
  insertAttachmentQueue("queue-attachment-only", "queue-attachment-only-note", "pending", new Date().toISOString());

  assert.equal(wakeAttachmentOnlyQueue(), 1);
  const row = getDb().prepare("SELECT status, lastError FROM embedding_queue WHERE noteId = ?")
    .get("queue-attachment-only-note") as { status: string; lastError: string | null };
  assert.equal(row.status, "pending");
  assert.equal(row.lastError, "wakeup: pending attachment queue");
});
