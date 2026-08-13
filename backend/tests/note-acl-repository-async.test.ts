/**
 * noteAclRepository async 方法行为测试
 */

import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-note-acl-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");

import { noteAclRepository } from "../src/repositories/noteAclRepository";
import { getDb } from "../src/db/schema";

const USER_ID = "user-acl";
const NOTE_ID = "note-acl";

function seedBase() {
  getDb().prepare("INSERT OR IGNORE INTO users (id, username, passwordHash) VALUES (?, ?, ?)").run(USER_ID, USER_ID, "hash");
  getDb().prepare("INSERT OR IGNORE INTO notebooks (id, userId, name) VALUES (?, ?, ?)").run("nb-acl", USER_ID, "NB");
  getDb().prepare("INSERT OR IGNORE INTO notes (id, userId, notebookId, title) VALUES (?, ?, ?, ?)").run(NOTE_ID, USER_ID, "nb-acl", "Note");
}

function clean() {
  getDb().prepare("DELETE FROM note_acl").run();
}

test("getPermissionAsync returns permission", async () => {
  clean();
  seedBase();
  getDb().prepare("INSERT INTO note_acl (noteId, userId, permission, grantedBy) VALUES (?, ?, ?, ?)").run(NOTE_ID, USER_ID, "write", USER_ID);
  const row = await noteAclRepository.getPermissionAsync(NOTE_ID, USER_ID);
  assert.ok(row);
  assert.equal(row.permission, "write");
  clean();
});

test("getPermissionAsync returns undefined when not found", async () => {
  clean();
  const row = await noteAclRepository.getPermissionAsync("no-such-note", "no-such-user");
  assert.equal(row, undefined);
});

test("getPermissionAsync returns undefined for wrong user", async () => {
  clean();
  seedBase();
  getDb().prepare("INSERT INTO note_acl (noteId, userId, permission, grantedBy) VALUES (?, ?, ?, ?)").run(NOTE_ID, USER_ID, "read", USER_ID);
  const row = await noteAclRepository.getPermissionAsync(NOTE_ID, "other-user");
  assert.equal(row, undefined);
  clean();
});

test("deleteByNoteAndUserAsync removes acl entry", async () => {
  clean();
  seedBase();
  getDb().prepare("INSERT INTO note_acl (noteId, userId, permission, grantedBy) VALUES (?, ?, ?, ?)").run(NOTE_ID, USER_ID, "read", USER_ID);
  await noteAclRepository.deleteByNoteAndUserAsync(NOTE_ID, USER_ID);
  const row = getDb().prepare("SELECT * FROM note_acl WHERE noteId = ? AND userId = ?").get(NOTE_ID, USER_ID);
  assert.equal(row, undefined);
  clean();
});

test("deleteByNoteAndUserAsync no-op when not exists", async () => {
  clean();
  seedBase();
  await noteAclRepository.deleteByNoteAndUserAsync(NOTE_ID, USER_ID);
  // should not throw
  clean();
});

test("deleteByUserAndWorkspaceAsync removes acl entries in workspace", async () => {
  clean();
  seedBase();
  const wsId = "ws-acl";
  getDb().prepare("INSERT OR IGNORE INTO workspaces (id, name, ownerId) VALUES (?, ?, ?)").run(wsId, "WS", USER_ID);
  // Create a scope-consistent notebook and note in the workspace.
  const notebookWs = "nb-ws-acl";
  getDb().prepare("INSERT OR IGNORE INTO notebooks (id, userId, name, workspaceId) VALUES (?, ?, ?, ?)")
    .run(notebookWs, USER_ID, "WS NB", wsId);
  const noteWs = "note-ws-acl";
  getDb().prepare("INSERT OR IGNORE INTO notes (id, userId, notebookId, title, workspaceId) VALUES (?, ?, ?, ?, ?)")
    .run(noteWs, USER_ID, notebookWs, "WS Note", wsId);
  // Create another user with ACL on that note
  const user2 = "user-acl2";
  getDb().prepare("INSERT OR IGNORE INTO users (id, username, passwordHash) VALUES (?, ?, ?)").run(user2, user2, "hash");
  getDb().prepare("INSERT INTO note_acl (noteId, userId, permission, grantedBy) VALUES (?, ?, ?, ?)").run(noteWs, user2, "read", USER_ID);
  // Also add ACL on a non-workspace note for user2
  getDb().prepare("INSERT INTO note_acl (noteId, userId, permission, grantedBy) VALUES (?, ?, ?, ?)").run(NOTE_ID, user2, "read", USER_ID);
  // Delete user2's ACL in workspace
  await noteAclRepository.deleteByUserAndWorkspaceAsync(user2, wsId);
  // The workspace note ACL should be gone
  const wsAcl = getDb().prepare("SELECT * FROM note_acl WHERE noteId = ? AND userId = ?").get(noteWs, user2);
  assert.equal(wsAcl, undefined);
  // The non-workspace note ACL should remain
  const nonWsAcl = getDb().prepare("SELECT * FROM note_acl WHERE noteId = ? AND userId = ?").get(NOTE_ID, user2);
  assert.ok(nonWsAcl);
  clean();
});

test("transferOwnershipAsync transfers acl entries", async () => {
  clean();
  seedBase();
  const newUserId = "user-acl-new";
  getDb().prepare("INSERT OR IGNORE INTO users (id, username, passwordHash) VALUES (?, ?, ?)").run(newUserId, newUserId, "hash");
  getDb().prepare("INSERT INTO note_acl (noteId, userId, permission, grantedBy) VALUES (?, ?, ?, ?)").run(NOTE_ID, USER_ID, "manage", USER_ID);
  const transferred = await noteAclRepository.transferOwnershipAsync(USER_ID, newUserId);
  assert.ok(transferred >= 1);
  const row = getDb().prepare("SELECT userId FROM note_acl WHERE noteId = ?").get(NOTE_ID) as any;
  assert.equal(row.userId, newUserId);
  clean();
});

test("transferOwnershipAsync returns 0 when no entries", async () => {
  clean();
  const transferred = await noteAclRepository.transferOwnershipAsync("no-such-user", "other-user");
  assert.equal(transferred, 0);
});

test("listCommonNotesAsync returns common notes", async () => {
  clean();
  seedBase();
  const user2 = "user-acl2";
  getDb().prepare("INSERT OR IGNORE INTO users (id, username, passwordHash) VALUES (?, ?, ?)").run(user2, user2, "hash");
  const note2 = "note-acl2";
  getDb().prepare("INSERT OR IGNORE INTO notes (id, userId, notebookId, title) VALUES (?, ?, ?, ?)").run(note2, USER_ID, "nb-acl", "Note2");
  // Both users have ACL on NOTE_ID
  getDb().prepare("INSERT INTO note_acl (noteId, userId, permission, grantedBy) VALUES (?, ?, ?, ?)").run(NOTE_ID, USER_ID, "read", USER_ID);
  getDb().prepare("INSERT INTO note_acl (noteId, userId, permission, grantedBy) VALUES (?, ?, ?, ?)").run(NOTE_ID, user2, "read", USER_ID);
  // Only user2 has ACL on note2
  getDb().prepare("INSERT INTO note_acl (noteId, userId, permission, grantedBy) VALUES (?, ?, ?, ?)").run(note2, user2, "read", USER_ID);
  const common = await noteAclRepository.listCommonNotesAsync(USER_ID, user2);
  assert.ok(common.includes(NOTE_ID));
  assert.equal(common.length, 1); // only NOTE_ID is common
  clean();
});

test("listCommonNotesAsync returns empty when no common notes", async () => {
  clean();
  seedBase();
  const user2 = "user-acl2";
  getDb().prepare("INSERT OR IGNORE INTO users (id, username, passwordHash) VALUES (?, ?, ?)").run(user2, user2, "hash");
  getDb().prepare("INSERT INTO note_acl (noteId, userId, permission, grantedBy) VALUES (?, ?, ?, ?)").run(NOTE_ID, USER_ID, "read", USER_ID);
  const common = await noteAclRepository.listCommonNotesAsync(USER_ID, user2);
  assert.deepEqual(common, []);
  clean();
});
