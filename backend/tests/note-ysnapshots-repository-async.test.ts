/**
 * noteYsnapshotsRepository async 方法行为测试
 */

import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-ysnapshots-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");

import { noteYsnapshotsRepository } from "../src/repositories/noteYsnapshotsRepository";
import { getDb } from "../src/db/schema";

const NOTE_ID = "note-ys";

function seedBase() {
  getDb().prepare("INSERT OR IGNORE INTO users (id, username, passwordHash) VALUES (?, ?, ?)").run("u1", "testuser", "hash");
  getDb().prepare("INSERT OR IGNORE INTO notebooks (id, userId, name) VALUES (?, ?, ?)").run("nb1", "u1", "NB");
  getDb().prepare("INSERT OR IGNORE INTO notes (id, userId, notebookId, title) VALUES (?, ?, ?, ?)").run(NOTE_ID, "u1", "nb1", "Note");
}

function clean() {
  getDb().prepare("DELETE FROM note_ysnapshots").run();
}

test("upsertAsync creates snapshot", async () => {
  clean();
  seedBase();
  const blob = Buffer.from("snapshot-data");
  await noteYsnapshotsRepository.upsertAsync(NOTE_ID, blob, 42);
  const row = getDb().prepare("SELECT * FROM note_ysnapshots WHERE noteId = ?").get(NOTE_ID) as any;
  assert.ok(row);
  assert.equal(row.updatesMergedTo, 42);
  clean();
});

test("upsertAsync updates existing snapshot", async () => {
  clean();
  seedBase();
  const blob1 = Buffer.from("v1");
  const blob2 = Buffer.from("v2");
  await noteYsnapshotsRepository.upsertAsync(NOTE_ID, blob1, 10);
  await noteYsnapshotsRepository.upsertAsync(NOTE_ID, blob2, 20);
  const rows = getDb().prepare("SELECT * FROM note_ysnapshots WHERE noteId = ?").all(NOTE_ID);
  assert.equal(rows.length, 1);
  const row = rows[0] as any;
  assert.equal(row.updatesMergedTo, 20);
  clean();
});

test("getByNoteIdAsync returns snapshot", async () => {
  clean();
  seedBase();
  const blob = Buffer.from("test-blob");
  await noteYsnapshotsRepository.upsertAsync(NOTE_ID, blob, 5);
  const row = await noteYsnapshotsRepository.getByNoteIdAsync(NOTE_ID);
  assert.ok(row);
  assert.equal(row.updatesMergedTo, 5);
  assert.ok(Buffer.isBuffer(row.snapshot_blob));
  clean();
});

test("getByNoteIdAsync returns undefined when not found", async () => {
  clean();
  const row = await noteYsnapshotsRepository.getByNoteIdAsync("nonexistent");
  assert.equal(row, undefined);
});

test("getUpdatesMergedToAsync returns value", async () => {
  clean();
  seedBase();
  await noteYsnapshotsRepository.upsertAsync(NOTE_ID, Buffer.from("x"), 99);
  const row = await noteYsnapshotsRepository.getUpdatesMergedToAsync(NOTE_ID);
  assert.ok(row);
  assert.equal(row.updatesMergedTo, 99);
  clean();
});

test("deleteByNoteIdAsync removes snapshot", async () => {
  clean();
  seedBase();
  await noteYsnapshotsRepository.upsertAsync(NOTE_ID, Buffer.from("del"), 1);
  await noteYsnapshotsRepository.deleteByNoteIdAsync(NOTE_ID);
  const row = getDb().prepare("SELECT noteId FROM note_ysnapshots WHERE noteId = ?").get(NOTE_ID);
  assert.equal(row, undefined);
});
