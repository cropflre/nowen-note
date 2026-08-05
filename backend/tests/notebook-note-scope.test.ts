import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { resolveNotebookNoteScopeIds } from "../src/lib/notebookNoteScope";

test("notebook note scope separates direct folder contents from recursive subtree contents", () => {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE notebooks (
      id TEXT PRIMARY KEY,
      parentId TEXT
    );
    INSERT INTO notebooks (id, parentId) VALUES
      ('root', NULL),
      ('child-a', 'root'),
      ('child-b', 'root'),
      ('grandchild', 'child-a'),
      ('other', NULL);
  `);

  assert.deepEqual(resolveNotebookNoteScopeIds(db, "root", false), ["root"]);
  assert.deepEqual(
    new Set(resolveNotebookNoteScopeIds(db, "root", true)),
    new Set(["root", "child-a", "child-b", "grandchild"]),
  );
  assert.deepEqual(resolveNotebookNoteScopeIds(db, "missing", false), []);
  assert.deepEqual(resolveNotebookNoteScopeIds(db, "missing", true), []);
  db.close();
});
