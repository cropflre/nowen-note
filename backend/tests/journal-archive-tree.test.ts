import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-journal-archive-"));
process.env.DB_PATH = path.join(tempDir, "journal-archive.db");
let closeDatabase: (() => void) | null = null;

test.after(() => {
  closeDatabase?.();
  fs.rmSync(tempDir, { recursive: true, force: true });
  delete process.env.DB_PATH;
});

test("journal archive creates real year/month folders and migrates existing journals idempotently", async () => {
  await import("../src/runtime/knowledge-tree-migration-bootstrap.js");
  const { getDb, closeDb } = await import("../src/db/schema.js");
  closeDatabase = closeDb;
  const {
    ensureJournalArchiveFolders,
    ensureJournalArchivePlacement,
    journalArchiveNotebookId,
    organizeJournalArchive,
    parseJournalDateKey,
  } = await import("../src/services/journalArchiveTree.js");

  const db = getDb();
  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
    .run("journal-user", "journal-user", "hash");
  db.prepare(`
    INSERT INTO notebooks (id, userId, workspaceId, parentId, name, sortOrder)
    VALUES (?, ?, NULL, NULL, ?, ?)
  `).run("legacy-notebook", "journal-user", "旧笔记本", 10);

  const insertJournal = db.prepare(`
    INSERT INTO notes (
      id, userId, notebookId, workspaceId, title, content, contentText,
      note_type, journal_date, sortOrder
    ) VALUES (?, ?, ?, NULL, ?, '{}', '', 'journal', ?, 0)
  `);
  insertJournal.run("journal-2026-07-29", "journal-user", "legacy-notebook", "自定义标题保留", "2026-07-29");
  insertJournal.run("journal-2026-08-01", "journal-user", "legacy-notebook", "2026-08-01", "2026-08-01");
  insertJournal.run("journal-invalid", "journal-user", "legacy-notebook", "错误日期", "2026-02-30");

  assert.deepEqual(parseJournalDateKey("2028-02-29"), {
    dateKey: "2028-02-29",
    year: "2028",
    month: "02",
    day: "29",
  });
  assert.throws(() => parseJournalDateKey("2026-02-30"), /INVALID_JOURNAL_DATE/);

  const emptyPath = ensureJournalArchiveFolders({
    db,
    userId: "journal-user",
    dateKey: "2025-12-31",
  });
  assert.equal(emptyPath.foldersCreated, 3);
  assert.equal(
    (db.prepare("SELECT name FROM notebooks WHERE id = ?").get(emptyPath.rootNotebookId) as { name: string }).name,
    "个人日记",
  );

  const first = ensureJournalArchivePlacement({
    db,
    userId: "journal-user",
    noteId: "journal-2026-07-29",
  });
  assert.equal(first.moved, true);
  assert.equal(first.yearTitle, "2026年");
  assert.equal(first.monthTitle, "2026年07月");
  assert.equal(first.rootNotebookId, journalArchiveNotebookId("journal-user", "root"));

  const noteAfterMove = db.prepare(`
    SELECT notebookId, title, sortOrder, updatedAt
    FROM notes WHERE id = ?
  `).get("journal-2026-07-29") as {
    notebookId: string;
    title: string;
    sortOrder: number;
    updatedAt: string;
  };
  assert.equal(noteAfterMove.notebookId, first.monthNotebookId);
  assert.equal(noteAfterMove.title, "自定义标题保留");
  assert.equal(noteAfterMove.sortOrder, -20260729);

  const noteTree = db.prepare(`
    SELECT parentId, scopeKey, isDeleted
    FROM knowledge_tree_nodes
    WHERE resourceType = 'note' AND resourceId = ?
  `).get("journal-2026-07-29") as {
    parentId: string;
    scopeKey: string;
    isDeleted: number;
  };
  assert.equal(noteTree.parentId, first.monthNodeId);
  assert.equal(noteTree.scopeKey, "personal:journal-user");
  assert.equal(noteTree.isDeleted, 0);

  const second = ensureJournalArchivePlacement({
    db,
    userId: "journal-user",
    noteId: "journal-2026-07-29",
  });
  assert.equal(second.moved, false);
  assert.equal(second.foldersCreated, 0);

  const migration = organizeJournalArchive({ db, userId: "journal-user" });
  assert.equal(migration.total, 3);
  assert.equal(migration.organized, 2);
  assert.equal(migration.moved, 1);
  assert.equal(migration.alreadyOrganized, 1);
  assert.equal(migration.skippedInvalidDate, 1);
  assert.equal(migration.skippedWorkspaceJournal, 0);

  const august = db.prepare(`
    SELECT nb.name AS monthName, parent.name AS yearName, root.name AS rootName
    FROM notes note
    JOIN notebooks nb ON nb.id = note.notebookId
    JOIN notebooks parent ON parent.id = nb.parentId
    JOIN notebooks root ON root.id = parent.parentId
    WHERE note.id = ?
  `).get("journal-2026-08-01") as {
    monthName: string;
    yearName: string;
    rootName: string;
  };
  assert.deepEqual(august, {
    monthName: "2026年08月",
    yearName: "2026年",
    rootName: "个人日记",
  });

  const rerun = organizeJournalArchive({ db, userId: "journal-user" });
  assert.equal(rerun.moved, 0);
  assert.equal(rerun.alreadyOrganized, 2);
  assert.equal(rerun.foldersCreated, 0);

  const duplicates = db.prepare(`
    SELECT parentId, name, COUNT(*) AS count
    FROM notebooks
    WHERE userId = ? AND workspaceId IS NULL AND isDeleted = 0
      AND (name = '个人日记' OR name LIKE '____年' OR name LIKE '____年__月')
    GROUP BY parentId, name
    HAVING COUNT(*) > 1
  `).all("journal-user") as Array<{ parentId: string | null; name: string; count: number }>;
  assert.deepEqual(duplicates, []);

  const moveHistory = db.prepare(`
    SELECT COUNT(*) AS count
    FROM knowledge_tree_history
    WHERE nodeId = ? AND action = 'move' AND metadata LIKE '%journal_archive%'
  `).get("note:journal-2026-07-29") as { count: number };
  assert.equal(moveHistory.count, 1);
});

test("journal archive adopts an existing exact folder path instead of duplicating it", async () => {
  const { getDb } = await import("../src/db/schema.js");
  const { ensureJournalArchiveFolders } = await import("../src/services/journalArchiveTree.js");
  const db = getDb();

  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
    .run("adopt-user", "adopt-user", "hash");
  db.prepare(`
    INSERT INTO notebooks (id, userId, workspaceId, parentId, name, icon, sortOrder)
    VALUES
      ('manual-journal-root', 'adopt-user', NULL, NULL, '个人日记', '📒', 0),
      ('manual-journal-year', 'adopt-user', NULL, 'manual-journal-root', '2026年', '📒', 0),
      ('manual-journal-month', 'adopt-user', NULL, 'manual-journal-year', '2026年09月', '📒', 0)
  `).run();

  const pathResult = ensureJournalArchiveFolders({
    db,
    userId: "adopt-user",
    dateKey: "2026-09-12",
  });
  assert.equal(pathResult.rootNotebookId, "manual-journal-root");
  assert.equal(pathResult.yearNotebookId, "manual-journal-year");
  assert.equal(pathResult.monthNotebookId, "manual-journal-month");
  assert.equal(pathResult.foldersCreated, 0);
  assert.equal(pathResult.foldersAdopted, 3);
});
