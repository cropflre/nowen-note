import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-roundtrip-batch-test-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");
process.env.ELECTRON_USER_DATA = tmpDir;
process.env.ROUNDTRIP_IMPORT_UNDO_TTL_HOURS = "24";
process.env.NOWEN_INSTANCE_ID = "roundtrip-batch-test-instance";

let closeDb: typeof import("../src/db/schema").closeDb;

test.after(() => {
  closeDb?.();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function modules() {
  const schema = await import("../src/db/schema");
  closeDb = schema.closeDb;
  return {
    ...schema,
    ...(await import("../src/services/nowenPackageExport")),
    ...(await import("../src/services/nowenPackageImport")),
    ...(await import("../src/services/nowenRoundTripSync")),
    ...(await import("../src/services/roundTripImportBatches")),
    ...(await import("../src/services/roundTripImportLinkUndo")),
  };
}

async function seed() {
  const { getDb } = await modules();
  const db = getDb();
  db.exec(`
    DELETE FROM roundtrip_import_batches;
    DELETE FROM roundtrip_import_links;
    DELETE FROM note_import_origins;
    DELETE FROM note_tags;
    DELETE FROM attachments;
    DELETE FROM notes;
    DELETE FROM notebooks;
    DELETE FROM tags;
    DELETE FROM workspaces;
    DELETE FROM users;
  `);
  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
    .run("batch-user", "batch-user", "hash");
  db.prepare(`
    INSERT INTO notebooks (id, userId, name, parentId, sortOrder, isExpanded, createdAt, updatedAt)
    VALUES (?, ?, ?, NULL, 0, 1, ?, ?)
  `).run("batch-root", "batch-user", "Batch Root", "2026-07-20 10:00:00", "2026-07-20 10:00:00");
  db.prepare(`
    INSERT INTO notes (
      id, userId, notebookId, title, content, contentText, contentFormat,
      createdAt, updatedAt, version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `).run(
    "batch-note",
    "batch-user",
    "batch-root",
    "批次测试",
    "初始正文",
    "初始正文",
    "markdown",
    "2026-07-20 10:00:00",
    "2026-07-20 10:00:00",
  );
}

test("formal round-trip import persists a report and can be safely undone", async () => {
  await seed();
  const {
    createNowenPackageExport,
    getDb,
    importNowenPackage,
    getRoundTripImportBatch,
    listRoundTripImportBatches,
    undoRoundTripImportBatchWithLinks,
  } = await modules();
  const db = getDb();

  const exported = await createNowenPackageExport({
    userId: "batch-user",
    workspaceId: null,
    packageKind: "nowen",
  });
  const imported = await importNowenPackage(exported.buffer, {
    userId: "batch-user",
    workspaceId: null,
    importMode: "new-root",
  });
  assert.equal(imported.success, true, imported.errors?.join("; "));
  assert.ok(imported.importBatch?.id);
  assert.equal(imported.importBatch?.undoAvailable, true);

  const batches = listRoundTripImportBatches("batch-user");
  assert.equal(batches.length, 1);
  assert.equal(batches[0].status, "completed");
  assert.equal(batches[0].sourceInstanceId, "roundtrip-batch-test-instance");
  assert.equal(batches[0].counts?.notes, 1);

  const detail = getRoundTripImportBatch("batch-user", imported.importBatch.id);
  assert.equal(detail?.preview?.success, true);
  assert.equal(detail?.result?.success, true);

  const importedRootId = String(imported.rootNotebookId || "");
  assert.ok(importedRootId);
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS count FROM notebooks WHERE id = ?").get(importedRootId) as { count: number }).count,
    1,
  );

  const undone = await undoRoundTripImportBatchWithLinks("batch-user", imported.importBatch.id);
  assert.equal(undone.status, "undone");
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS count FROM notebooks WHERE id = ?").get(importedRootId) as { count: number }).count,
    0,
  );
  const sourceLinkCount = db.prepare("SELECT COUNT(*) AS count FROM roundtrip_import_links WHERE userId = ?")
    .get("batch-user") as { count: number };
  assert.equal(sourceLinkCount.count, 0);
});

test("sync undo restores the pre-sync target and source mappings", async () => {
  await seed();
  const {
    createNowenPackageExport,
    getDb,
    importNowenPackage,
    importNowenPackageWithSync,
    undoRoundTripImportBatchWithLinks,
  } = await modules();
  const db = getDb();

  const firstPackage = await createNowenPackageExport({
    userId: "batch-user",
    workspaceId: null,
    packageKind: "nowen",
  });
  const copied = await importNowenPackage(firstPackage.buffer, {
    userId: "batch-user",
    workspaceId: null,
    importMode: "new-root",
  });
  assert.equal(copied.success, true, copied.errors?.join("; "));
  const copiedNote = db.prepare(`
    SELECT id, title, content FROM notes WHERE notebookId = ? LIMIT 1
  `).get(copied.rootNotebookId) as { id: string; title: string; content: string } | undefined;
  assert.ok(copiedNote);
  const beforeSync = { title: copiedNote!.title, content: copiedNote!.content };

  db.prepare(`
    UPDATE notes
       SET title = ?, content = ?, contentText = ?, updatedAt = ?
     WHERE id = ?
  `).run(
    "来源更新后的标题",
    "来源更新后的正文",
    "来源更新后的正文",
    "2026-07-22 12:00:00",
    "batch-note",
  );
  const updatedPackage = await createNowenPackageExport({
    userId: "batch-user",
    workspaceId: null,
    packageKind: "nowen",
  });
  const synced = await importNowenPackage(updatedPackage.buffer, {
    userId: "batch-user",
    workspaceId: null,
    importMode: "sync",
  });
  assert.equal(synced.success, true, synced.errors?.join("; "));
  assert.equal(synced.counts?.updatedNotes, 1);
  assert.equal(synced.importBatch?.undoAvailable, true);

  const syncedTarget = db.prepare("SELECT title, content FROM notes WHERE id = ?").get(copiedNote!.id) as { title: string; content: string } | undefined;
  assert.equal(syncedTarget?.title, "来源更新后的标题");
  assert.match(syncedTarget?.content || "", /^来源更新后的正文(?: \^blk_[\w-]+)?$/);

  const undone = await undoRoundTripImportBatchWithLinks("batch-user", String(synced.importBatch.id));
  assert.equal(undone.status, "undone");
  const restoredTarget = db.prepare("SELECT title, content FROM notes WHERE id = ?").get(copiedNote!.id) as { title: string; content: string } | undefined;
  assert.deepEqual(restoredTarget, beforeSync);

  const retryPreview = await importNowenPackageWithSync(updatedPackage.buffer, {
    userId: "batch-user",
    workspaceId: null,
    importMode: "sync",
    dryRun: true,
  });
  assert.equal(retryPreview.success, true, retryPreview.errors?.join("; "));
  assert.equal(retryPreview.counts?.updatedNotes, 1, "restored source hashes should make the same package syncable again");
});

test("undo refuses to remove a note edited after the import", async () => {
  await seed();
  const {
    createNowenPackageExport,
    getDb,
    importNowenPackage,
    RoundTripImportUndoError,
    undoRoundTripImportBatchWithLinks,
  } = await modules();
  const db = getDb();

  const exported = await createNowenPackageExport({
    userId: "batch-user",
    workspaceId: null,
    packageKind: "nowen",
  });
  const imported = await importNowenPackage(exported.buffer, {
    userId: "batch-user",
    workspaceId: null,
    importMode: "new-root",
  });
  assert.equal(imported.success, true, imported.errors?.join("; "));
  const importedNote = db.prepare("SELECT id FROM notes WHERE notebookId = ? LIMIT 1")
    .get(imported.rootNotebookId) as { id: string } | undefined;
  assert.ok(importedNote);
  db.prepare("UPDATE notes SET title = ?, updatedAt = datetime('now') WHERE id = ?")
    .run("导入后本地改名", importedNote!.id);

  await assert.rejects(
    () => undoRoundTripImportBatchWithLinks("batch-user", String(imported.importBatch.id)),
    (error: unknown) => {
      assert.ok(error instanceof RoundTripImportUndoError);
      assert.equal(error.code, "IMPORT_BATCH_UNDO_CONFLICT");
      assert.ok(error.conflicts.some((item) => item.includes(importedNote!.id)));
      return true;
    },
  );
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS count FROM notes WHERE id = ?").get(importedNote!.id) as { count: number }).count,
    1,
  );
});
