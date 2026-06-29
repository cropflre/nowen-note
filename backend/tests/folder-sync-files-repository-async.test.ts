/**
 * folderSyncFilesRepository async 方法行为测试
 */

import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-folder-sync-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");

import { folderSyncFilesRepository } from "../src/repositories/folderSyncFilesRepository";
import { getDb } from "../src/db/schema";

const USER_ID = "user-fs";
const NOTE_ID = "note-fs";

function seedBase() {
  getDb().prepare("INSERT OR IGNORE INTO users (id, username, passwordHash) VALUES (?, ?, ?)").run(USER_ID, USER_ID, "hash");
  getDb().prepare("INSERT OR IGNORE INTO notebooks (id, userId, name) VALUES (?, ?, ?)").run("nb-fs", USER_ID, "NB");
  getDb().prepare("INSERT OR IGNORE INTO notes (id, userId, notebookId, title) VALUES (?, ?, ?, ?)").run(NOTE_ID, USER_ID, "nb-fs", "Note");
}

function clean() {
  getDb().prepare("DELETE FROM folder_sync_files").run();
}

function seedRecord(overrides: Partial<{ id: string; sourcePathHash: string; sha256: string }> = {}) {
  const id = overrides.id ?? `fs-${Date.now()}`;
  const hash = overrides.sourcePathHash ?? `hash-${Date.now()}`;
  const sha = overrides.sha256 ?? "abc123";
  getDb().prepare(
    "INSERT INTO folder_sync_files (id, userId, sourcePathHash, relativePath, filename, sha256, noteId) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(id, USER_ID, hash, "/path/file.md", "file.md", sha, NOTE_ID);
  return { id, hash, sha };
}

test("createAsync inserts record", async () => {
  clean();
  seedBase();
  await folderSyncFilesRepository.createAsync({
    id: "fs-create", userId: USER_ID, sourcePathHash: "hash-create",
    relativePath: "/test.md", filename: "test.md", sha256: "sha1", noteId: NOTE_ID,
  });
  const row = getDb().prepare("SELECT * FROM folder_sync_files WHERE id = ?").get("fs-create") as any;
  assert.ok(row);
  assert.equal(row.filename, "test.md");
  clean();
});

test("getBySourcePathHashAsync returns record", async () => {
  clean();
  seedBase();
  const { id, hash, sha } = seedRecord({ id: "fs-find", sourcePathHash: "hash-find", sha256: "mysha" });
  const row = await folderSyncFilesRepository.getBySourcePathHashAsync(USER_ID, "hash-find");
  assert.ok(row);
  assert.equal(row.id, "fs-find");
  assert.equal(row.oldSha, "mysha");
  clean();
});

test("getBySourcePathHashAsync returns undefined when not found", async () => {
  clean();
  const row = await folderSyncFilesRepository.getBySourcePathHashAsync(USER_ID, "no-such-hash");
  assert.equal(row, undefined);
});

test("updateAsync updates record", async () => {
  clean();
  seedBase();
  seedRecord({ id: "fs-update" });
  await folderSyncFilesRepository.updateAsync("fs-update", {
    sha256: "newsha", relativePath: "/new.md", filename: "new.md",
  });
  const row = getDb().prepare("SELECT sha256, filename FROM folder_sync_files WHERE id = ?").get("fs-update") as any;
  assert.equal(row.sha256, "newsha");
  assert.equal(row.filename, "new.md");
  clean();
});

test("deleteAsync removes record", async () => {
  clean();
  seedBase();
  seedRecord({ id: "fs-del" });
  await folderSyncFilesRepository.deleteAsync("fs-del");
  const row = getDb().prepare("SELECT id FROM folder_sync_files WHERE id = ?").get("fs-del");
  assert.equal(row, undefined);
});

test("batchGetNoteIdsAsync returns mapping", async () => {
  clean();
  seedBase();
  seedRecord({ id: "fs-b1", sourcePathHash: "h1" });
  seedRecord({ id: "fs-b2", sourcePathHash: "h2" });
  const result = await folderSyncFilesRepository.batchGetNoteIdsAsync(USER_ID, ["h1", "h2", "h3"]);
  assert.equal(result["h1"], NOTE_ID);
  assert.equal(result["h2"], NOTE_ID);
  assert.equal(result["h3"], undefined);
  clean();
});

test("batchGetNoteIdsAsync with empty hashes", async () => {
  clean();
  const result = await folderSyncFilesRepository.batchGetNoteIdsAsync(USER_ID, []);
  assert.deepEqual(result, {});
});
