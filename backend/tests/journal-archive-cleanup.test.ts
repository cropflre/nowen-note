import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-journal-cleanup-"));
process.env.DB_PATH = path.join(tempDir, "journal-cleanup.db");
let closeDatabase: (() => void) | null = null;

test.after(() => {
  closeDatabase?.();
  fs.rmSync(tempDir, { recursive: true, force: true });
  delete process.env.DB_PATH;
});

test("journal archive cleanup only removes proven empty leaves and supports rollback", async () => {
  await import("../src/runtime/knowledge-tree-migration-bootstrap.js");
  const { getDb, closeDb } = await import("../src/db/schema.js");
  closeDatabase = closeDb;
  const { organizeJournalArchive } = await import("../src/services/journalArchiveTree.js");
  const {
    applyJournalArchiveCleanup,
    previewJournalArchiveCleanup,
    restoreJournalArchiveCleanup,
  } = await import("../src/services/journalArchiveCleanup.js");

  const db = getDb();
  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
    .run("cleanup-user", "cleanup-user", "hash");

  const insertNotebook = db.prepare(`
    INSERT INTO notebooks (id, userId, workspaceId, parentId, name, sortOrder)
    VALUES (?, 'cleanup-user', NULL, ?, ?, 0)
  `);
  insertNotebook.run("legacy-empty-a", null, "旧日记 A");
  insertNotebook.run("legacy-empty-b", null, "旧日记 B");
  insertNotebook.run("legacy-with-note", null, "保留普通笔记");
  insertNotebook.run("legacy-with-child", null, "保留子目录");
  insertNotebook.run("legacy-child", "legacy-with-child", "空子目录");
  insertNotebook.run("unrelated-empty", null, "无迁移证据的空目录");

  const insertJournal = db.prepare(`
    INSERT INTO notes (
      id, userId, notebookId, workspaceId, title, content, contentText,
      note_type, journal_date, sortOrder
    ) VALUES (?, 'cleanup-user', ?, NULL, ?, '{}', '', 'journal', ?, 0)
  `);
  insertJournal.run("journal-a", "legacy-empty-a", "2026-07-01", "2026-07-01");
  insertJournal.run("journal-b", "legacy-empty-b", "2026-07-02", "2026-07-02");
  insertJournal.run("journal-note", "legacy-with-note", "2026-07-03", "2026-07-03");
  insertJournal.run("journal-child", "legacy-with-child", "2026-07-04", "2026-07-04");

  db.prepare(`
    INSERT INTO notes (
      id, userId, notebookId, workspaceId, title, content, contentText,
      note_type, journal_date, sortOrder
    ) VALUES ('ordinary-note', 'cleanup-user', 'legacy-with-note', NULL,
      '不能删除', '{}', '', 'note', NULL, 0)
  `).run();

  const organized = organizeJournalArchive({ db, userId: "cleanup-user" });
  assert.equal(organized.moved, 4);

  const preview = previewJournalArchiveCleanup({ db, userId: "cleanup-user" });
  assert.deepEqual(preview.candidates.map((item) => item.id), [
    "legacy-empty-a",
    "legacy-empty-b",
  ]);
  assert.equal(preview.candidateCount, 2);
  assert.equal(preview.blockedCount, 2);
  assert.equal(preview.blocked.find((item) => item.id === "legacy-with-note")?.reasons.includes("HAS_NOTES"), true);
  assert.equal(preview.blocked.find((item) => item.id === "legacy-with-child")?.reasons.includes("HAS_CHILD_NOTEBOOKS"), true);
  assert.equal(preview.candidates.some((item) => item.id === "unrelated-empty"), false);

  const applied = applyJournalArchiveCleanup({
    db,
    userId: "cleanup-user",
    previewToken: preview.previewToken,
    candidateIds: ["legacy-empty-a"],
  });
  assert.equal(applied.cleaned, 1);
  assert.equal(applied.cleanedNotebooks[0]?.id, "legacy-empty-a");
  assert.equal(
    (db.prepare("SELECT isDeleted FROM notebooks WHERE id = 'legacy-empty-a'").get() as { isDeleted: number }).isDeleted,
    1,
  );
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS count FROM notes WHERE isTrashed = 1").get() as { count: number }).count,
    0,
  );

  const cleanupHistory = db.prepare(`
    SELECT COUNT(*) AS count
    FROM knowledge_tree_history
    WHERE nodeId = 'notebook:legacy-empty-a'
      AND action = 'delete_subtree'
      AND metadata LIKE '%journal_archive_cleanup%'
  `).get() as { count: number };
  assert.equal(cleanupHistory.count, 1);

  const restored = restoreJournalArchiveCleanup({
    db,
    userId: "cleanup-user",
    cleanupId: applied.cleanupId,
  });
  assert.equal(restored.restored, 1);
  assert.equal(
    (db.prepare("SELECT isDeleted FROM notebooks WHERE id = 'legacy-empty-a'").get() as { isDeleted: number }).isDeleted,
    0,
  );

  const stalePreview = previewJournalArchiveCleanup({ db, userId: "cleanup-user" });
  db.prepare(`
    INSERT INTO notes (
      id, userId, notebookId, workspaceId, title, content, contentText,
      note_type, journal_date, sortOrder
    ) VALUES ('late-note', 'cleanup-user', 'legacy-empty-b', NULL,
      '后来新增', '{}', '', 'note', NULL, 0)
  `).run();

  assert.throws(() => applyJournalArchiveCleanup({
    db,
    userId: "cleanup-user",
    previewToken: stalePreview.previewToken,
    candidateIds: ["legacy-empty-b"],
  }), /JOURNAL_ARCHIVE_CLEANUP_STALE_PREVIEW/);

  const finalPreview = previewJournalArchiveCleanup({ db, userId: "cleanup-user" });
  assert.equal(finalPreview.candidates.some((item) => item.id === "legacy-empty-b"), false);
  assert.equal(finalPreview.blocked.find((item) => item.id === "legacy-empty-b")?.reasons.includes("HAS_NOTES"), true);
});
