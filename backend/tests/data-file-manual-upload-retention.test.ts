import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";
import { Hono } from "hono";

import { getDb } from "../src/db/schema";
import dataFileRouter from "../src/routes/data-file";

test("orphan cleanup never removes files uploaded manually from file manager", async () => {
  const db = getDb();
  const suffix = crypto.randomUUID();
  const userId = `manual-retention-user-${suffix}`;
  const notebookId = crypto.randomUUID();
  const noteId = crypto.randomUUID();
  const manualAttachmentId = crypto.randomUUID();
  const editorAttachmentId = crypto.randomUUID();
  const manualSize = 2048;
  const editorSize = 4096;

  db.prepare(
    "INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)",
  ).run(userId, userId, "hash");
  db.prepare(
    "INSERT INTO notebooks (id, userId, name) VALUES (?, ?, ?)",
  ).run(notebookId, userId, "保留策略测试");
  db.prepare(
    `INSERT INTO notes (id, userId, notebookId, title, content, contentText)
     VALUES (?, ?, ?, ?, '{}', '')`,
  ).run(noteId, userId, notebookId, "附件保留策略");

  const insertAttachment = db.prepare(`
    INSERT INTO attachments (
      id, noteId, userId, filename, mimeType, size, path, createdAt, uploadSource
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertAttachment.run(
    manualAttachmentId,
    noteId,
    userId,
    "manual.png",
    "image/png",
    manualSize,
    `${manualAttachmentId}.png`,
    "2020-01-01 00:00:00",
    "file_manager",
  );
  insertAttachment.run(
    editorAttachmentId,
    noteId,
    userId,
    "editor.png",
    "image/png",
    editorSize,
    `${editorAttachmentId}.png`,
    "2020-01-01 00:00:00",
    null,
  );

  const app = new Hono();
  app.route("/api/data-file", dataFileRouter);
  const headers = { "X-User-Id": userId };

  try {
    const dryRunResponse = await app.request(
      "http://localhost/api/data-file/cleanup-orphans?dryRun=1&graceHours=0",
      { method: "POST", headers },
    );
    assert.equal(dryRunResponse.status, 200);
    const dryRun = await dryRunResponse.json() as any;
    assert.equal(dryRun.contentOrphanBytes, editorSize);
    assert.equal(dryRun.dbOrphanBytes, 0);

    const cleanupResponse = await app.request(
      "http://localhost/api/data-file/cleanup-orphans?graceHours=0",
      { method: "POST", headers },
    );
    assert.equal(cleanupResponse.status, 200);
    const cleanup = await cleanupResponse.json() as any;
    assert.equal(cleanup.contentOrphansRemoved, 1);

    const manualRow = db.prepare(
      "SELECT uploadSource FROM attachments WHERE id = ?",
    ).get(manualAttachmentId) as { uploadSource: string } | undefined;
    const editorRow = db.prepare(
      "SELECT id FROM attachments WHERE id = ?",
    ).get(editorAttachmentId) as { id: string } | undefined;

    assert.equal(manualRow?.uploadSource, "file_manager");
    assert.equal(editorRow, undefined);
  } finally {
    db.prepare("DELETE FROM attachment_references WHERE attachmentId IN (?, ?)")
      .run(manualAttachmentId, editorAttachmentId);
    db.prepare("DELETE FROM attachments WHERE id IN (?, ?)")
      .run(manualAttachmentId, editorAttachmentId);
    db.prepare("DELETE FROM notes WHERE id = ?").run(noteId);
    db.prepare("DELETE FROM notebooks WHERE id = ?").run(notebookId);
    db.prepare("DELETE FROM users WHERE id = ?").run(userId);
  }
});
