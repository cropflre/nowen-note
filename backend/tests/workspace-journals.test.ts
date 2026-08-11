import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-workspace-journals-"));
process.env.DB_PATH = path.join(tempDir, "workspace-journals.db");
let closeDatabase: (() => void) | null = null;

test.after(() => {
  closeDatabase?.();
  fs.rmSync(tempDir, { recursive: true, force: true });
  delete process.env.DB_PATH;
});

test("workspace journals are unique per workspace/date and enforce member roles", async () => {
  await import("../src/runtime/knowledge-tree-migration-bootstrap.js");
  const { getDb, closeDb } = await import("../src/db/schema.js");
  const { workspaceJournalsMigration } = await import("../src/db/workspaceJournalsMigration.js");
  const {
    checkWorkspaceJournal,
    getOrCreateWorkspaceJournal,
    WorkspaceJournalError,
    workspaceJournalNotebookId,
  } = await import("../src/services/workspaceJournals.js");
  closeDatabase = closeDb;
  const db = getDb();
  workspaceJournalsMigration.up(db);

  const insertUser = db.prepare(
    "INSERT INTO users (id, username, passwordHash) VALUES (?, ?, 'hash')",
  );
  for (const id of ["owner", "editor", "viewer", "outsider", "owner-two"]) {
    insertUser.run(id, id);
  }

  db.prepare(`
    INSERT INTO workspaces (id, name, description, icon, ownerId, enabledFeatures)
    VALUES ('workspace-one', '项目一', '', '🏢', 'owner', ''),
           ('workspace-two', '项目二', '', '🏢', 'owner-two', '')
  `).run();
  const insertMember = db.prepare(`
    INSERT INTO workspace_members (workspaceId, userId, role)
    VALUES (?, ?, ?)
  `);
  insertMember.run("workspace-one", "owner", "owner");
  insertMember.run("workspace-one", "editor", "editor");
  insertMember.run("workspace-one", "viewer", "viewer");
  insertMember.run("workspace-two", "owner-two", "owner");

  // A personal journal on the same calendar date remains an independent resource.
  db.prepare(`
    INSERT INTO notebooks (id, userId, workspaceId, parentId, name, sortOrder)
    VALUES ('personal-notebook', 'owner', NULL, NULL, '个人', 0)
  `).run();
  db.prepare(`
    INSERT INTO notes (
      id, userId, notebookId, workspaceId, title, content, contentText,
      note_type, journal_date, sortOrder
    ) VALUES (
      'personal-journal', 'owner', 'personal-notebook', NULL, '2026-08-03', '{}', '',
      'journal', '2026-08-03', 0
    )
  `).run();

  const created = getOrCreateWorkspaceJournal({
    db,
    workspaceId: "workspace-one",
    actorUserId: "editor",
    dateKey: "2026-08-03",
  });
  assert.equal(created.existed, false);
  assert.equal(created.canWrite, true);
  assert.equal(created.note.workspaceId, "workspace-one");
  assert.equal(created.note.userId, "owner");
  assert.equal(created.note.note_type, "note");
  assert.equal(created.note.journal_date, null);
  assert.equal(created.note.title, "2026-08-03");
  assert.ok(created.archive);

  const binding = db.prepare(`
    SELECT workspaceId, journalDate, noteId, createdBy
    FROM workspace_journals
    WHERE workspaceId = 'workspace-one' AND journalDate = '2026-08-03'
  `).get() as {
    workspaceId: string;
    journalDate: string;
    noteId: string;
    createdBy: string;
  };
  assert.equal(binding.noteId, created.note.id);
  assert.equal(binding.createdBy, "editor");

  const rootId = workspaceJournalNotebookId("workspace-one", "root");
  const yearId = workspaceJournalNotebookId("workspace-one", "year", "2026");
  const monthId = workspaceJournalNotebookId("workspace-one", "month", "2026-08");
  assert.deepEqual(
    db.prepare(`
      SELECT id, userId, workspaceId, parentId, name
      FROM notebooks
      WHERE id IN (?, ?, ?)
      ORDER BY CASE id WHEN ? THEN 1 WHEN ? THEN 2 ELSE 3 END
    `).all(rootId, yearId, monthId, rootId, yearId),
    [
      { id: rootId, userId: "owner", workspaceId: "workspace-one", parentId: null, name: "工作区日记" },
      { id: yearId, userId: "owner", workspaceId: "workspace-one", parentId: rootId, name: "2026年" },
      { id: monthId, userId: "owner", workspaceId: "workspace-one", parentId: yearId, name: "2026年08月" },
    ],
  );

  const noteNode = db.prepare(`
    SELECT workspaceId, scopeKey, parentId
    FROM knowledge_tree_nodes
    WHERE resourceType = 'note' AND resourceId = ?
  `).get(created.note.id) as {
    workspaceId: string;
    scopeKey: string;
    parentId: string;
  };
  assert.deepEqual(noteNode, {
    workspaceId: "workspace-one",
    scopeKey: "workspace:workspace-one",
    parentId: `notebook:${monthId}`,
  });

  const ownerResult = getOrCreateWorkspaceJournal({
    db,
    workspaceId: "workspace-one",
    actorUserId: "owner",
    dateKey: "2026-08-03",
  });
  assert.equal(ownerResult.existed, true);
  assert.equal(ownerResult.note.id, created.note.id);
  assert.equal(
    (db.prepare(`
      SELECT COUNT(*) AS count FROM workspace_journals
      WHERE workspaceId = 'workspace-one' AND journalDate = '2026-08-03'
    `).get() as { count: number }).count,
    1,
  );

  const historyBeforeViewer = (
    db.prepare("SELECT COUNT(*) AS count FROM knowledge_tree_history").get() as { count: number }
  ).count;
  const viewerCheck = checkWorkspaceJournal({
    db,
    workspaceId: "workspace-one",
    actorUserId: "viewer",
    dateKey: "2026-08-03",
  });
  assert.equal(viewerCheck.exists, true);
  assert.equal(viewerCheck.canWrite, false);
  const viewerOpen = getOrCreateWorkspaceJournal({
    db,
    workspaceId: "workspace-one",
    actorUserId: "viewer",
    dateKey: "2026-08-03",
  });
  assert.equal(viewerOpen.note.id, created.note.id);
  assert.equal(viewerOpen.canWrite, false);
  assert.equal(viewerOpen.archive, null);
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS count FROM knowledge_tree_history").get() as { count: number }).count,
    historyBeforeViewer,
  );

  assert.throws(
    () => getOrCreateWorkspaceJournal({
      db,
      workspaceId: "workspace-one",
      actorUserId: "viewer",
      dateKey: "2026-08-04",
    }),
    (error: unknown) => error instanceof WorkspaceJournalError
      && error.code === "WORKSPACE_JOURNAL_READ_ONLY",
  );
  assert.throws(
    () => checkWorkspaceJournal({
      db,
      workspaceId: "workspace-one",
      actorUserId: "outsider",
      dateKey: "2026-08-03",
    }),
    (error: unknown) => error instanceof WorkspaceJournalError
      && error.code === "WORKSPACE_FORBIDDEN",
  );

  const secondWorkspace = getOrCreateWorkspaceJournal({
    db,
    workspaceId: "workspace-two",
    actorUserId: "owner-two",
    dateKey: "2026-08-03",
  });
  assert.notEqual(secondWorkspace.note.id, created.note.id);
  assert.equal(secondWorkspace.note.workspaceId, "workspace-two");

  db.prepare(`
    UPDATE workspaces
    SET enabledFeatures = '{"diaries":false}'
    WHERE id = 'workspace-one'
  `).run();
  assert.throws(
    () => checkWorkspaceJournal({
      db,
      workspaceId: "workspace-one",
      actorUserId: "owner",
      dateKey: "2026-08-03",
    }),
    (error: unknown) => error instanceof WorkspaceJournalError
      && error.code === "WORKSPACE_DIARIES_DISABLED",
  );

  assert.equal(
    (db.prepare(`
      SELECT COUNT(*) AS count FROM notes
      WHERE (id = 'personal-journal' AND workspaceId IS NULL)
         OR (id = ? AND workspaceId = 'workspace-one')
    `).get(created.note.id) as { count: number }).count,
    2,
  );
});
