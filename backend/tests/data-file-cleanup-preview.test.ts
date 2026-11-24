import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";
import { Hono } from "hono";

import { getDb } from "../src/db/schema";
import dataFileRouter from "../src/routes/data-file";
import { ensureFileSharesTable } from "../src/services/file-shares";

// The file page shows the dry run as "N items · X MB" and asks the user to confirm.
// The preview must count exactly what the real run deletes, including its safety skips.
test("cleanup dry run reports the same items the real cleanup removes", async () => {
  const db = getDb();
  ensureFileSharesTable();
  const suffix = crypto.randomUUID();
  const userId = `cleanup-preview-user-${suffix}`;
  const notebookId = crypto.randomUUID();
  const noteId = crypto.randomUUID();
  const orphanId = crypto.randomUUID();
  const sharedOrphanId = crypto.randomUUID();
  const orphanSize = 4096;
  const sharedSize = 1024;

  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)").run(userId, userId, "hash");
  db.prepare("INSERT INTO notebooks (id, userId, name) VALUES (?, ?, ?)").run(notebookId, userId, "清理预览");
  db.prepare(`INSERT INTO notes (id, userId, notebookId, title, content, contentText)
    VALUES (?, ?, ?, ?, '{}', '')`).run(noteId, userId, notebookId, "清理预览");
  const insertAttachment = db.prepare(`
    INSERT INTO attachments (id, noteId, userId, filename, mimeType, size, path, createdAt, uploadSource)
    VALUES (?, ?, ?, ?, 'image/png', ?, ?, '2020-01-01 00:00:00', NULL)
  `);
  insertAttachment.run(orphanId, noteId, userId, "orphan.png", orphanSize, `${orphanId}.png`);
  insertAttachment.run(sharedOrphanId, noteId, userId, "shared.png", sharedSize, `${sharedOrphanId}.png`);
  // An active public link protects the file from cleanup; the preview must not count it.
  db.prepare(`INSERT INTO file_shares (id, token, attachmentId, noteId, ownerId, isActive)
    VALUES (?, ?, ?, ?, ?, 1)`).run(crypto.randomUUID(), `token-${suffix}`, sharedOrphanId, noteId, userId);

  const app = new Hono();
  app.route("/api/data-file", dataFileRouter);
  const headers = { "X-User-Id": userId };
  try {
    const preview = await (await app.request(
      "http://localhost/api/data-file/cleanup-orphans?dryRun=1&graceHours=0", { method: "POST", headers },
    )).json() as Record<string, number | boolean>;
    assert.equal(preview.dryRun, true);
    assert.equal(preview.contentOrphansRemoved, 1);
    assert.equal(preview.contentOrphanBytes, orphanSize);
    assert.equal(preview.totalRemovedItems, 1);
    assert.equal(preview.totalFreedBytes, orphanSize);
    // Nothing is deleted by the preview.
    assert.ok(db.prepare("SELECT 1 FROM attachments WHERE id = ?").get(orphanId));

    const cleanup = await (await app.request(
      "http://localhost/api/data-file/cleanup-orphans?graceHours=0", { method: "POST", headers },
    )).json() as Record<string, number | boolean>;
    assert.equal(cleanup.contentOrphansRemoved, preview.contentOrphansRemoved);
    assert.equal(cleanup.totalRemovedItems, preview.totalRemovedItems);
    assert.equal(db.prepare("SELECT 1 FROM attachments WHERE id = ?").get(orphanId), undefined);
    assert.ok(db.prepare("SELECT 1 FROM attachments WHERE id = ?").get(sharedOrphanId));
  } finally {
    db.prepare("DELETE FROM file_shares WHERE attachmentId IN (?, ?)").run(orphanId, sharedOrphanId);
    db.prepare("DELETE FROM attachment_references WHERE attachmentId IN (?, ?)").run(orphanId, sharedOrphanId);
    db.prepare("DELETE FROM attachments WHERE id IN (?, ?)").run(orphanId, sharedOrphanId);
    db.prepare("DELETE FROM notes WHERE id = ?").run(noteId);
    db.prepare("DELETE FROM notebooks WHERE id = ?").run(notebookId);
    db.prepare("DELETE FROM users WHERE id = ?").run(userId);
  }
});
