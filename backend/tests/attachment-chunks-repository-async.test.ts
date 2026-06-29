/**
 * attachmentChunksRepository async 方法行为测试
 */

import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-att-chunks-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");

import { attachmentChunksRepository } from "../src/repositories/attachmentChunksRepository";
import { getDb } from "../src/db/schema";

const ATT_ID = "att-1";

function seedBase() {
  getDb().prepare("INSERT OR IGNORE INTO users (id, username, passwordHash) VALUES (?, ?, ?)").run("u1", "testuser", "hash");
  getDb().prepare("INSERT OR IGNORE INTO notebooks (id, userId, name) VALUES (?, ?, ?)").run("nb1", "u1", "NB");
  getDb().prepare("INSERT OR IGNORE INTO notes (id, userId, notebookId, title) VALUES (?, ?, ?, ?)").run("n1", "u1", "nb1", "Note");
  getDb().prepare("INSERT OR IGNORE INTO attachments (id, noteId, userId, filename, mimeType, size, path) VALUES (?, ?, ?, ?, ?, ?, ?)").run(ATT_ID, "n1", "u1", "file.txt", "text/plain", 100, "file.txt");
}

function clean() {
  getDb().prepare("DELETE FROM attachment_chunks").run();
}

test("createAsync inserts chunk", async () => {
  clean();
  seedBase();
  await attachmentChunksRepository.createAsync(ATT_ID, 0, "hello world");
  const row = getDb().prepare("SELECT * FROM attachment_chunks WHERE attachmentId = ?").get(ATT_ID) as any;
  assert.ok(row);
  assert.equal(row.chunkIndex, 0);
  assert.equal(row.chunkText, "hello world");
  clean();
});

test("deleteByAttachmentIdAsync deletes all chunks", async () => {
  clean();
  seedBase();
  getDb().prepare("INSERT INTO attachment_chunks (attachmentId, chunkIndex, chunkText) VALUES (?, ?, ?)").run(ATT_ID, 0, "a");
  getDb().prepare("INSERT INTO attachment_chunks (attachmentId, chunkIndex, chunkText) VALUES (?, ?, ?)").run(ATT_ID, 1, "b");
  await attachmentChunksRepository.deleteByAttachmentIdAsync(ATT_ID);
  const rows = getDb().prepare("SELECT * FROM attachment_chunks WHERE attachmentId = ?").all(ATT_ID);
  assert.equal(rows.length, 0);
  clean();
});

test("deleteByAttachmentIdsAsync deletes by ids", async () => {
  clean();
  seedBase();
  // 创建第二个附件
  getDb().prepare("INSERT OR IGNORE INTO attachments (id, noteId, userId, filename, mimeType, size, path) VALUES (?, ?, ?, ?, ?, ?, ?)").run("att-2", "n1", "u1", "file2.txt", "text/plain", 100, "file2.txt");
  getDb().prepare("INSERT INTO attachment_chunks (attachmentId, chunkIndex, chunkText) VALUES (?, ?, ?)").run(ATT_ID, 0, "a");
  getDb().prepare("INSERT INTO attachment_chunks (attachmentId, chunkIndex, chunkText) VALUES (?, ?, ?)").run("att-2", 0, "b");
  await attachmentChunksRepository.deleteByAttachmentIdsAsync([ATT_ID]);
  const rows = getDb().prepare("SELECT * FROM attachment_chunks").all() as any[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].attachmentId, "att-2");
  clean();
});

test("deleteByAttachmentIdsAsync with empty array", async () => {
  clean();
  seedBase();
  getDb().prepare("INSERT INTO attachment_chunks (attachmentId, chunkIndex, chunkText) VALUES (?, ?, ?)").run(ATT_ID, 0, "a");
  await attachmentChunksRepository.deleteByAttachmentIdsAsync([]);
  const rows = getDb().prepare("SELECT * FROM attachment_chunks").all();
  assert.equal(rows.length, 1);
  clean();
});
