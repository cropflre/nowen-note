import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-legacy-hierarchy-"));
process.env.DB_PATH = path.join(tempDir, "legacy-hierarchy.db");
let closeDatabase: (() => void) | null = null;

test.after(() => {
  closeDatabase?.();
  fs.rmSync(tempDir, { recursive: true, force: true });
  delete process.env.DB_PATH;
});

test("legacy Notes/Notebooks writes stay consistent without sync triggers", async () => {
  await import("../src/runtime/knowledge-tree-migration-bootstrap.js");
  const { getDb, closeDb } = await import("../src/db/schema.js");
  closeDatabase = closeDb;
  const {
    auditLegacyKnowledgeHierarchy,
    LegacyKnowledgeHierarchyError,
    synchronizeLegacyNoteHierarchy,
    synchronizeLegacyNotebookHierarchy,
  } = await import("../src/services/legacyKnowledgeHierarchy.js");

  const db = getDb();
  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
    .run("owner", "owner", "hash");

  // Prove the application coordinator is the writer. Structural guards remain enabled, while the
  // old business-table synchronization triggers are disabled for this test.
  db.exec(`
    DROP TRIGGER IF EXISTS knowledge_tree_notebooks_ai;
    DROP TRIGGER IF EXISTS knowledge_tree_notebooks_au;
    DROP TRIGGER IF EXISTS knowledge_tree_notes_ai;
    DROP TRIGGER IF EXISTS knowledge_tree_notes_au;
  `);

  const insertNotebook = db.prepare(`
    INSERT INTO notebooks (id, userId, workspaceId, parentId, name, icon, sortOrder)
    VALUES (?, 'owner', NULL, ?, ?, '📁', ?)
  `);
  insertNotebook.run("nb-a", null, "A", 0);
  synchronizeLegacyNotebookHierarchy({
    db, notebookId: "nb-a", actorUserId: "owner", reason: "create", parentMode: "resource",
  });
  insertNotebook.run("nb-b", null, "B", 1);
  synchronizeLegacyNotebookHierarchy({
    db, notebookId: "nb-b", actorUserId: "owner", reason: "create", parentMode: "resource",
  });
  insertNotebook.run("nb-child", "nb-a", "A/Child", 0);
  synchronizeLegacyNotebookHierarchy({
    db, notebookId: "nb-child", actorUserId: "owner", reason: "create", parentMode: "resource",
  });

  const insertNote = db.prepare(`
    INSERT INTO notes (
      id, userId, workspaceId, notebookId, title, content, contentText,
      contentFormat, note_type, sortOrder
    ) VALUES (?, 'owner', NULL, ?, ?, '{}', '', ?, 'normal', ?)
  `);
  insertNote.run("note-parent", "nb-a", "Parent document", "tiptap-json", 0);
  synchronizeLegacyNoteHierarchy({
    db, noteId: "note-parent", actorUserId: "owner", reason: "create", parentMode: "resource",
  });
  insertNote.run("note-one", "nb-a", "One", "markdown", 1);
  synchronizeLegacyNoteHierarchy({
    db, noteId: "note-one", actorUserId: "owner", reason: "create", parentMode: "resource",
  });

  assert.equal(
    (db.prepare("SELECT parentId FROM knowledge_tree_nodes WHERE id = 'notebook:nb-child'").get() as { parentId: string }).parentId,
    "notebook:nb-a",
  );
  assert.equal(
    (db.prepare("SELECT parentId FROM knowledge_tree_nodes WHERE id = 'note:note-one'").get() as { parentId: string }).parentId,
    "notebook:nb-a",
  );
  assert.equal(
    (db.prepare("SELECT nodeType FROM knowledge_tree_nodes WHERE id = 'note:note-one'").get() as { nodeType: string }).nodeType,
    "markdown",
  );

  // Metadata-only legacy writes must not flatten a richer document-under-document relationship.
  db.prepare("UPDATE knowledge_tree_nodes SET parentId = 'note:note-parent' WHERE id = 'note:note-one'").run();
  db.prepare("UPDATE notes SET sortOrder = 7 WHERE id = 'note-one'").run();
  synchronizeLegacyNoteHierarchy({
    db, noteId: "note-one", actorUserId: "owner", reason: "reorder", parentMode: "preserve",
  });
  assert.deepEqual(
    db.prepare("SELECT parentId, sortOrder FROM knowledge_tree_nodes WHERE id = 'note:note-one'").get(),
    { parentId: "note:note-parent", sortOrder: 7 },
  );

  // An explicit old-API notebook move intentionally projects the document back to that notebook.
  db.prepare("UPDATE notes SET notebookId = 'nb-b', sortOrder = 2 WHERE id = 'note-one'").run();
  synchronizeLegacyNoteHierarchy({
    db, noteId: "note-one", actorUserId: "owner", reason: "move", parentMode: "resource",
  });
  assert.deepEqual(
    db.prepare("SELECT parentId, sortOrder FROM knowledge_tree_nodes WHERE id = 'note:note-one'").get(),
    { parentId: "notebook:nb-b", sortOrder: 2 },
  );

  db.prepare("UPDATE notebooks SET parentId = 'nb-b', sortOrder = 4 WHERE id = 'nb-child'").run();
  synchronizeLegacyNotebookHierarchy({
    db, notebookId: "nb-child", actorUserId: "owner", reason: "move", parentMode: "resource",
  });
  assert.deepEqual(
    db.prepare("SELECT parentId, sortOrder FROM knowledge_tree_nodes WHERE id = 'notebook:nb-child'").get(),
    { parentId: "notebook:nb-b", sortOrder: 4 },
  );

  // Replays are idempotent and never create another node.
  synchronizeLegacyNoteHierarchy({
    db, noteId: "note-one", actorUserId: "owner", reason: "metadata", parentMode: "preserve",
  });
  synchronizeLegacyNoteHierarchy({
    db, noteId: "note-one", actorUserId: "owner", reason: "metadata", parentMode: "preserve",
  });
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS count FROM knowledge_tree_nodes WHERE resourceType = 'note' AND resourceId = 'note-one'").get() as { count: number }).count,
    1,
  );

  // A synchronization error aborts the caller's business-table transaction as well.
  assert.throws(
    () => db.transaction(() => {
      db.prepare("UPDATE notes SET sortOrder = 99 WHERE id = 'note-one'").run();
      db.prepare(`
        INSERT INTO knowledge_tree_nodes (
          id, userId, workspaceId, scopeKey, parentId, nodeType, resourceType,
          resourceId, sortOrder, isExpanded, isDeleted
        ) VALUES ('duplicate:note-one', 'owner', NULL, 'personal:duplicate', NULL,
                  'note', 'note', 'note-one', 0, 1, 0)
      `).run();
      synchronizeLegacyNoteHierarchy({
        db, noteId: "note-one", actorUserId: "owner", reason: "reorder", parentMode: "preserve",
      });
    })(),
    (error: unknown) => error instanceof LegacyKnowledgeHierarchyError
      && error.code === "LEGACY_KNOWLEDGE_NODE_DUPLICATE",
  );
  assert.equal(
    (db.prepare("SELECT sortOrder FROM notes WHERE id = 'note-one'").get() as { sortOrder: number }).sortOrder,
    2,
  );
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS count FROM knowledge_tree_nodes WHERE id = 'duplicate:note-one'").get() as { count: number }).count,
    0,
  );

  db.prepare("UPDATE notes SET isTrashed = 1, trashedAt = datetime('now') WHERE id = 'note-one'").run();
  synchronizeLegacyNoteHierarchy({
    db, noteId: "note-one", actorUserId: "owner", reason: "delete", parentMode: "preserve",
  });
  assert.equal(
    (db.prepare("SELECT isDeleted FROM knowledge_tree_nodes WHERE id = 'note:note-one'").get() as { isDeleted: number }).isDeleted,
    1,
  );
  db.prepare("UPDATE notes SET isTrashed = 0, trashedAt = NULL WHERE id = 'note-one'").run();
  synchronizeLegacyNoteHierarchy({
    db, noteId: "note-one", actorUserId: "owner", reason: "restore", parentMode: "preserve",
  });

  db.prepare("UPDATE notebooks SET isDeleted = 1, deletedAt = datetime('now') WHERE id = 'nb-child'").run();
  synchronizeLegacyNotebookHierarchy({
    db, notebookId: "nb-child", actorUserId: "owner", reason: "delete", parentMode: "preserve",
  });
  db.prepare("UPDATE notebooks SET isDeleted = 0, deletedAt = NULL WHERE id = 'nb-child'").run();
  synchronizeLegacyNotebookHierarchy({
    db, notebookId: "nb-child", actorUserId: "owner", reason: "restore", parentMode: "preserve",
  });

  assert.deepEqual(auditLegacyKnowledgeHierarchy({ db, userId: "owner", workspaceId: null }), []);

  const historyActions = db.prepare(`
    SELECT DISTINCT action FROM knowledge_tree_history
    WHERE actorUserId = 'owner' AND json_extract(metadata, '$.source') = 'legacy-api'
    ORDER BY action
  `).all() as Array<{ action: string }>;
  assert.deepEqual(
    historyActions.map((row) => row.action),
    ["create", "delete_subtree", "move", "reorder", "restore"],
  );
});

test("legacy routes are wired through the coordinator", () => {
  const notesSource = fs.readFileSync(new URL("../src/routes/notes.ts", import.meta.url), "utf8");
  const notebooksSource = fs.readFileSync(new URL("../src/routes/notebooks.ts", import.meta.url), "utf8");
  assert.match(notesSource, /synchronizeLegacyNoteHierarchy/);
  assert.match(notesSource, /legacyNoteCreateTx/);
  assert.match(notesSource, /legacyNoteUpdateTx/);
  assert.match(notebooksSource, /synchronizeLegacyNotebookHierarchy/);
  assert.match(notebooksSource, /legacyNotebookCreateTx/);
  assert.match(notebooksSource, /legacyNotebookMoveTx/);
  assert.match(notebooksSource, /legacyNotebookDeleteTx/);
});
