import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-nb-perm-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");

import {
  listSharedNotebookIds,
  resolveNoteNotebookMemberPermission,
  resolveNotebookMemberPermission,
} from "../src/services/notebook-permissions";
import { getDb } from "../src/db/schema";

function seed() {
  const db = getDb();
  db.exec(`
    INSERT OR IGNORE INTO users (id, username, passwordHash)
    VALUES
      ('owner', 'owner', 'hash'),
      ('editor', 'editor', 'hash'),
      ('viewer', 'viewer', 'hash'),
      ('removed', 'removed', 'hash');

    INSERT OR IGNORE INTO notebooks (id, userId, name, updatedAt)
    VALUES
      ('nb-1', 'owner', 'Shared notebook', '2026-01-01 00:00:00'),
      ('nb-2', 'viewer', 'Own notebook', '2026-01-02 00:00:00'),
      ('nb-deleted', 'owner', 'Deleted notebook', '2026-01-03 00:00:00');

    INSERT OR IGNORE INTO notes (id, userId, notebookId, title)
    VALUES ('note-1', 'owner', 'nb-1', 'Shared note');

    INSERT OR IGNORE INTO notebook_members (id, notebookId, userId, role, status)
    VALUES
      ('nb-1:owner', 'nb-1', 'owner', 'owner', 'active'),
      ('nb-1:editor', 'nb-1', 'editor', 'editor', 'active'),
      ('nb-1:viewer', 'nb-1', 'viewer', 'viewer', 'active'),
      ('nb-1:removed', 'nb-1', 'removed', 'viewer', 'removed'),
      ('nb-2:viewer', 'nb-2', 'viewer', 'owner', 'active'),
      ('nb-deleted:viewer', 'nb-deleted', 'viewer', 'viewer', 'active');

    UPDATE notebooks SET isDeleted = 1 WHERE id = 'nb-deleted';
  `);
}

test("resolves notebook member roles to permissions", () => {
  seed();
  assert.equal(resolveNotebookMemberPermission("nb-1", "owner"), "manage");
  assert.equal(resolveNotebookMemberPermission("nb-1", "editor"), "write");
  assert.equal(resolveNotebookMemberPermission("nb-1", "viewer"), "read");
  assert.equal(resolveNotebookMemberPermission("nb-1", "removed"), null);
});

test("resolves note permissions from its notebook membership", () => {
  seed();
  assert.equal(resolveNoteNotebookMemberPermission("note-1", "editor"), "write");
  assert.equal(resolveNoteNotebookMemberPermission("note-1", "viewer"), "read");
  assert.equal(resolveNoteNotebookMemberPermission("note-1", "removed"), null);
});

test("lists active notebooks shared by other owners", () => {
  seed();
  assert.deepEqual(listSharedNotebookIds("viewer"), ["nb-1"]);
});
