/**
 * noteLinksRepository async 方法行为测试（C-A.4）
 *
 * 范围：replaceLinksForSourceAsync（使用 executeStatements）
 */

import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-note-links-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");

import { noteLinksRepository } from "../src/repositories/noteLinksRepository";
import { getDb } from "../src/db/schema";

const USER_ID = "user-nl-1";
const WS_ID = "ws-nl-1";
const NB_ID = "nb-nl-1";
const NOTE_1 = "note-nl-001";
const NOTE_2 = "note-nl-002";
const NOTE_3 = "note-nl-003";
const NOTE_4 = "note-nl-004";

function seedBase() {
  const db = getDb();
  db.prepare("INSERT OR IGNORE INTO users (id, username, passwordHash) VALUES (?, ?, ?)").run(USER_ID, USER_ID, "hash");
  db.prepare("INSERT OR IGNORE INTO workspaces (id, name, ownerId) VALUES (?, ?, ?)").run(WS_ID, "Test WS", USER_ID);
  db.prepare("INSERT OR IGNORE INTO notebooks (id, name, userId, workspaceId) VALUES (?, ?, ?, ?)").run(NB_ID, "Test NB", USER_ID, WS_ID);
  db.prepare("INSERT OR IGNORE INTO notes (id, title, userId, notebookId, workspaceId) VALUES (?, ?, ?, ?, ?)").run(NOTE_1, "Note 1", USER_ID, NB_ID, WS_ID);
  db.prepare("INSERT OR IGNORE INTO notes (id, title, userId, notebookId, workspaceId) VALUES (?, ?, ?, ?, ?)").run(NOTE_2, "Note 2", USER_ID, NB_ID, WS_ID);
  db.prepare("INSERT OR IGNORE INTO notes (id, title, userId, notebookId, workspaceId) VALUES (?, ?, ?, ?, ?)").run(NOTE_3, "Note 3", USER_ID, NB_ID, WS_ID);
  db.prepare("INSERT OR IGNORE INTO notes (id, title, userId, notebookId, workspaceId) VALUES (?, ?, ?, ?, ?)").run(NOTE_4, "Note 4", USER_ID, NB_ID, WS_ID);
}

function clean() {
  getDb().prepare("DELETE FROM note_links").run();
  getDb().prepare("UPDATE notes SET isTrashed = 0 WHERE isTrashed = 1").run();
}

function getLinks(sourceNoteId: string) {
  return getDb().prepare("SELECT * FROM note_links WHERE sourceNoteId = ? AND userId = ?").all(sourceNoteId, USER_ID) as any[];
}

// ============================================================
// replaceLinksForSourceAsync
// ============================================================

test("replaceLinksForSourceAsync inserts new links", async () => {
  clean();
  seedBase();
  await noteLinksRepository.replaceLinksForSourceAsync(USER_ID, NOTE_1, [
    { targetNoteId: NOTE_2, targetBlockId: null, linkType: "note", linkText: "link to 2", excerpt: null },
    { targetNoteId: NOTE_3, targetBlockId: null, linkType: "note", linkText: "link to 3", excerpt: null },
  ]);
  const links = getLinks(NOTE_1);
  assert.equal(links.length, 2);
  clean();
});

test("replaceLinksForSourceAsync replaces old links", async () => {
  clean();
  seedBase();
  // First insert
  await noteLinksRepository.replaceLinksForSourceAsync(USER_ID, NOTE_1, [
    { targetNoteId: NOTE_2, targetBlockId: null, linkType: "note", linkText: "old", excerpt: null },
  ]);
  assert.equal(getLinks(NOTE_1).length, 1);
  // Replace with new
  await noteLinksRepository.replaceLinksForSourceAsync(USER_ID, NOTE_1, [
    { targetNoteId: NOTE_3, targetBlockId: null, linkType: "note", linkText: "new", excerpt: null },
    { targetNoteId: NOTE_4, targetBlockId: null, linkType: "note", linkText: "new2", excerpt: null },
  ]);
  const links = getLinks(NOTE_1);
  assert.equal(links.length, 2);
  const targets = links.map((l: any) => l.targetNoteId).sort();
  assert.deepEqual(targets, [NOTE_3, NOTE_4]);
  clean();
});

test("replaceLinksForSourceAsync with empty links clears old links", async () => {
  clean();
  seedBase();
  await noteLinksRepository.replaceLinksForSourceAsync(USER_ID, NOTE_1, [
    { targetNoteId: NOTE_2, targetBlockId: null, linkType: "note", linkText: "x", excerpt: null },
  ]);
  assert.equal(getLinks(NOTE_1).length, 1);
  // Clear
  await noteLinksRepository.replaceLinksForSourceAsync(USER_ID, NOTE_1, []);
  assert.equal(getLinks(NOTE_1).length, 0);
  clean();
});

test("replaceLinksForSourceAsync with empty validEntries clears old links", async () => {
  clean();
  seedBase();
  await noteLinksRepository.replaceLinksForSourceAsync(USER_ID, NOTE_1, [
    { targetNoteId: NOTE_2, targetBlockId: null, linkType: "note", linkText: "x", excerpt: null },
  ]);
  assert.equal(getLinks(NOTE_1).length, 1);
  // Link to non-existent note
  await noteLinksRepository.replaceLinksForSourceAsync(USER_ID, NOTE_1, [
    { targetNoteId: "non-existent-note", targetBlockId: null, linkType: "note", linkText: "x", excerpt: null },
  ]);
  assert.equal(getLinks(NOTE_1).length, 0, "old links should be cleared even if no valid entries");
  clean();
});

test("replaceLinksForSourceAsync filters non-existent target notes", async () => {
  clean();
  seedBase();
  await noteLinksRepository.replaceLinksForSourceAsync(USER_ID, NOTE_1, [
    { targetNoteId: NOTE_2, targetBlockId: null, linkType: "note", linkText: "valid", excerpt: null },
    { targetNoteId: "non-existent", targetBlockId: null, linkType: "note", linkText: "invalid", excerpt: null },
  ]);
  const links = getLinks(NOTE_1);
  assert.equal(links.length, 1);
  assert.equal(links[0].targetNoteId, NOTE_2);
  clean();
});

test("replaceLinksForSourceAsync does not affect other sourceNoteId", async () => {
  clean();
  seedBase();
  await noteLinksRepository.replaceLinksForSourceAsync(USER_ID, NOTE_1, [
    { targetNoteId: NOTE_2, targetBlockId: null, linkType: "note", linkText: "x", excerpt: null },
  ]);
  await noteLinksRepository.replaceLinksForSourceAsync(USER_ID, NOTE_3, [
    { targetNoteId: NOTE_4, targetBlockId: null, linkType: "note", linkText: "y", excerpt: null },
  ]);
  // Replace NOTE_1 links
  await noteLinksRepository.replaceLinksForSourceAsync(USER_ID, NOTE_1, []);
  assert.equal(getLinks(NOTE_1).length, 0);
  assert.equal(getLinks(NOTE_3).length, 1, "NOTE_3 links should not be affected");
  clean();
});

test("replaceLinksForSourceAsync does not affect other userId", async () => {
  clean();
  seedBase();
  const otherUser = "user-nl-2";
  getDb().prepare("INSERT OR IGNORE INTO users (id, username, passwordHash) VALUES (?, ?, ?)").run(otherUser, otherUser, "hash");
  getDb().prepare("INSERT INTO note_links (id, userId, sourceNoteId, targetNoteId, linkText, linkType) VALUES (?, ?, ?, ?, ?, ?)").run("link-other", otherUser, NOTE_1, NOTE_2, "other", "note");

  await noteLinksRepository.replaceLinksForSourceAsync(USER_ID, NOTE_1, [
    { targetNoteId: NOTE_3, targetBlockId: null, linkType: "note", linkText: "mine", excerpt: null },
  ]);
  // Links are owned by the source note, so replacement removes legacy rows regardless of saver.
  const otherLinks = getDb().prepare("SELECT * FROM note_links WHERE userId = ? AND sourceNoteId = ?").all(otherUser, NOTE_1) as any[];
  assert.equal(otherLinks.length, 0);
  clean();
});

test("replaceLinksForSourceAsync returns void", async () => {
  clean();
  seedBase();
  const result = await noteLinksRepository.replaceLinksForSourceAsync(USER_ID, NOTE_1, [
    { targetNoteId: NOTE_2, targetBlockId: null, linkType: "note", linkText: "x", excerpt: null },
  ]);
  assert.equal(result, undefined);
  clean();
});

test("replaceLinksForSourceAsync INSERT OR IGNORE deduplicates", async () => {
  clean();
  seedBase();
  // Insert same link twice in one call
  await noteLinksRepository.replaceLinksForSourceAsync(USER_ID, NOTE_1, [
    { targetNoteId: NOTE_2, targetBlockId: null, linkType: "note", linkText: "first", excerpt: null },
    { targetNoteId: NOTE_2, targetBlockId: null, linkType: "note", linkText: "duplicate", excerpt: null },
  ]);
  const links = getLinks(NOTE_1);
  // INSERT OR IGNORE should deduplicate based on UNIQUE index (userId, sourceNoteId, targetNoteId)
  assert.equal(links.length, 1);
  clean();
});

test("replaceLinksForSourceAsync DELETE + INSERT atomicity: rollback on INSERT failure", async () => {
  clean();
  seedBase();
  // 1. Insert existing links
  await noteLinksRepository.replaceLinksForSourceAsync(USER_ID, NOTE_1, [
    { targetNoteId: NOTE_2, targetBlockId: null, linkType: "note", linkText: "old link", excerpt: null },
  ]);
  assert.equal(getLinks(NOTE_1).length, 1);

  // 2. Create a trigger that forces INSERT to fail
  getDb().exec(`
    CREATE TEMP TRIGGER IF NOT EXISTS fail_insert_note_links
    BEFORE INSERT ON note_links
    WHEN NEW.linkText = 'FORCE_FAIL'
    BEGIN
      SELECT RAISE(ABORT, 'forced failure for atomicity test');
    END;
  `);

  // 3. Attempt replaceLinksForSourceAsync with a link that triggers failure
  await assert.rejects(
    () => noteLinksRepository.replaceLinksForSourceAsync(USER_ID, NOTE_1, [
      { targetNoteId: NOTE_3, targetBlockId: null, linkType: "note", linkText: "FORCE_FAIL", excerpt: null },
    ]),
    (err: Error) => err.message.includes("forced failure"),
  );

  // 4. Verify old links still exist (DELETE was rolled back)
  const links = getLinks(NOTE_1);
  assert.equal(links.length, 1, "old link should be preserved after rollback");
  assert.equal(links[0].targetNoteId, NOTE_2);
  assert.equal(links[0].linkText, "old link");

  // Cleanup trigger
  getDb().exec("DROP TRIGGER IF EXISTS fail_insert_note_links");
  clean();
});

// ============================================================
// getBacklinksAsync
// ============================================================

test("getBacklinksAsync returns backlinks for target note", async () => {
  clean();
  seedBase();
  // NOTE_2 and NOTE_3 link to NOTE_1
  await noteLinksRepository.replaceLinksForSourceAsync(USER_ID, NOTE_2, [
    { targetNoteId: NOTE_1, targetBlockId: null, linkType: "note", linkText: "link from 2", excerpt: null },
  ]);
  await noteLinksRepository.replaceLinksForSourceAsync(USER_ID, NOTE_3, [
    { targetNoteId: NOTE_1, targetBlockId: null, linkType: "note", linkText: "link from 3", excerpt: null },
  ]);
  const backlinks = await noteLinksRepository.getBacklinksAsync(USER_ID, NOTE_1);
  assert.equal(backlinks.length, 2);
  clean();
});

test("getBacklinksAsync returns correct fields", async () => {
  clean();
  seedBase();
  await noteLinksRepository.replaceLinksForSourceAsync(USER_ID, NOTE_2, [
    { targetNoteId: NOTE_1, targetBlockId: null, linkType: "note", linkText: "my link", excerpt: null },
  ]);
  const backlinks = await noteLinksRepository.getBacklinksAsync(USER_ID, NOTE_1);
  assert.equal(backlinks.length, 1);
  const bl = backlinks[0];
  assert.equal(bl.sourceNoteId, NOTE_2);
  assert.ok(bl.title);
  assert.ok(bl.updatedAt);
  assert.equal(bl.linkText, "my link");
  assert.equal(bl.linkType, "note");
  clean();
});

test("getBacklinksAsync excludes trashed source notes", async () => {
  clean();
  seedBase();
  await noteLinksRepository.replaceLinksForSourceAsync(USER_ID, NOTE_2, [
    { targetNoteId: NOTE_1, targetBlockId: null, linkType: "note", linkText: "link", excerpt: null },
  ]);
  // Trash NOTE_2
  getDb().prepare("UPDATE notes SET isTrashed = 1 WHERE id = ?").run(NOTE_2);
  const backlinks = await noteLinksRepository.getBacklinksAsync(USER_ID, NOTE_1);
  assert.equal(backlinks.length, 0);
  clean();
});

test("getBacklinksAsync does not return links for other targetNoteId", async () => {
  clean();
  seedBase();
  await noteLinksRepository.replaceLinksForSourceAsync(USER_ID, NOTE_2, [
    { targetNoteId: NOTE_1, targetBlockId: null, linkType: "note", linkText: "to 1", excerpt: null },
    { targetNoteId: NOTE_3, targetBlockId: null, linkType: "note", linkText: "to 3", excerpt: null },
  ]);
  const backlinks = await noteLinksRepository.getBacklinksAsync(USER_ID, NOTE_1);
  assert.equal(backlinks.length, 1);
  assert.equal(backlinks[0].sourceNoteId, NOTE_2);
  clean();
});

test("getBacklinksAsync does not return links for other userId", async () => {
  clean();
  seedBase();
  const otherUser = "user-nl-2";
  getDb().prepare("INSERT OR IGNORE INTO users (id, username, passwordHash) VALUES (?, ?, ?)").run(otherUser, otherUser, "hash");
  getDb().prepare("INSERT INTO note_links (id, userId, sourceNoteId, targetNoteId, linkText, linkType) VALUES (?, ?, ?, ?, ?, ?)").run("link-other", otherUser, NOTE_2, NOTE_1, "other", "note");

  const backlinks = await noteLinksRepository.getBacklinksAsync(USER_ID, NOTE_1);
  assert.equal(backlinks.length, 1);
  assert.equal(backlinks[0].sourceNoteId, NOTE_2);
  clean();
});

test("getBacklinksAsync returns empty array for no backlinks", async () => {
  clean();
  seedBase();
  const backlinks = await noteLinksRepository.getBacklinksAsync(USER_ID, NOTE_1);
  assert.deepEqual(backlinks, []);
});

// ============================================================
// deleteByNoteIdAsync
// ============================================================

test("deleteByNoteIdAsync deletes links where sourceNoteId matches", async () => {
  clean();
  seedBase();
  await noteLinksRepository.replaceLinksForSourceAsync(USER_ID, NOTE_1, [
    { targetNoteId: NOTE_2, targetBlockId: null, linkType: "note", linkText: "link", excerpt: null },
  ]);
  assert.equal(getLinks(NOTE_1).length, 1);
  await noteLinksRepository.deleteByNoteIdAsync(NOTE_1);
  assert.equal(getLinks(NOTE_1).length, 0);
  clean();
});

test("deleteByNoteIdAsync deletes links where targetNoteId matches", async () => {
  clean();
  seedBase();
  await noteLinksRepository.replaceLinksForSourceAsync(USER_ID, NOTE_1, [
    { targetNoteId: NOTE_2, targetBlockId: null, linkType: "note", linkText: "link", excerpt: null },
  ]);
  // Delete by target
  await noteLinksRepository.deleteByNoteIdAsync(NOTE_2);
  assert.equal(getLinks(NOTE_1).length, 0);
  clean();
});

test("deleteByNoteIdAsync does not delete unrelated links", async () => {
  clean();
  seedBase();
  await noteLinksRepository.replaceLinksForSourceAsync(USER_ID, NOTE_1, [
    { targetNoteId: NOTE_2, targetBlockId: null, linkType: "note", linkText: "link 1->2", excerpt: null },
  ]);
  await noteLinksRepository.replaceLinksForSourceAsync(USER_ID, NOTE_3, [
    { targetNoteId: NOTE_4, targetBlockId: null, linkType: "note", linkText: "link 3->4", excerpt: null },
  ]);
  // Delete NOTE_1 links
  await noteLinksRepository.deleteByNoteIdAsync(NOTE_1);
  assert.equal(getLinks(NOTE_1).length, 0);
  assert.equal(getLinks(NOTE_3).length, 1, "unrelated links should not be deleted");
  clean();
});

test("deleteByNoteIdAsync no-op for non-existent noteId", async () => {
  clean();
  // should not throw
  await noteLinksRepository.deleteByNoteIdAsync("non-existent");
});

test("deleteByNoteIdAsync returns void", async () => {
  clean();
  seedBase();
  const result = await noteLinksRepository.deleteByNoteIdAsync(NOTE_1);
  assert.equal(result, undefined);
});
