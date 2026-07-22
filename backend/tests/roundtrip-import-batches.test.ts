import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-import-batch-test-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");
process.env.ELECTRON_USER_DATA = tmpDir;
process.env.ROUNDTRIP_IMPORT_UNDO_TTL_HOURS = "24";

let closeDb: typeof import("../src/db/schema").closeDb;

test.after(() => {
  closeDb?.();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function seedSource() {
  const schema = await import("../src/db/schema");
  closeDb = schema.closeDb;
  const db = schema.getDb();
  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
    .run("batch-user", "batch-user", "hash");
  db.prepare(`
    INSERT INTO notebooks (id, userId, parentId, name, sortOrder, isExpanded)
    VALUES (?, ?, NULL, ?, ?, 1)
  `).run("batch-root", "batch-user", "批次资料", 10);
  db.prepare(`
    INSERT INTO notes (
      id, userId, notebookId, title, content, contentText, contentFormat,
      sortOrder, createdAt, updatedAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "batch-note",
    "batch-user",
    "batch-root",
    "批次记录",
    "[附件](/api/attachments/batch-attachment)",
    "批次记录",
    "markdown",
    20,
    "2026-07-22 10:00:00",
    "2026-07-22 10:30:00",
  );
  const attachmentDir = path.join(tmpDir, "attachments");
  fs.mkdirSync(attachmentDir, { recursive: true });
  fs.writeFileSync(path.join(attachmentDir, "batch-source.txt"), "batch attachment");
  db.prepare(`
    INSERT INTO attachments (id, userId, noteId, filename, mimeType, size, path, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "batch-attachment",
    "batch-user",
    "batch-note",
    "批次附件.txt",
    "text/plain",
    16,
    "batch-source.txt",
    "2026-07-22 10:15:00",
  );
  return { schema, db };
}

test("formal round-trip import persists a report and can be safely undone", async () => {
  const { db } = await seedSource();
  const { createNowenPackageExport } = await import("../src/services/nowenPackageExport");
  const { importNowenPackage } = await import("../src/services/nowenPackageImport");
  const {
    getRoundTripImportBatch,
    listRoundTripImportBatches,
  } = await import("../src/services/roundTripImportBatches");
  const { undoRoundTripImportBatchWithLinks } = await import("../src/services/roundTripImportLinkUndo");

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

  const batchId = String(imported.importBatch.id);
  const list = listRoundTripImportBatches("batch-user", { workspaceId: null });
  assert.equal(list[0]?.id, batchId);
  assert.equal(list[0]?.status, "completed");
  assert.equal(list[0]?.undo.available, true);

  const detail = getRoundTripImportBatch("batch-user", batchId);
  assert.equal(detail?.result?.success, true);
  assert.equal(detail?.counts?.notes, 1);

  const importedRootId = String(imported.rootNotebookId || "");
  assert.ok(importedRootId);
  const importedNote = db.prepare("SELECT id FROM notes WHERE notebookId = ?").get(importedRootId) as { id: string } | undefined;
  assert.ok(importedNote);
  const importedAttachment = db.prepare("SELECT id, path FROM attachments WHERE noteId = ?").get(importedNote!.id) as { id: string; path: string } | undefined;
  assert.ok(importedAttachment);
  assert.equal(fs.existsSync(path.join(tmpDir, "attachments", importedAttachment!.path)), true);

  const undone = await undoRoundTripImportBatchWithLinks("batch-user", batchId);
  assert.equal(undone.status, "undone");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM notebooks WHERE id = ?").get(importedRootId)?.count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM notes WHERE id = ?").get(importedNote!.id)?.count, 0);
  assert.equal(fs.existsSync(path.join(tmpDir, "attachments", importedAttachment!.path)), false);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM notes WHERE id = 'batch-note'").get()?.count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM roundtrip_import_links").get()?.count, 0);
});

test("undo refuses to remove a note edited after the import", async () => {
  const { createNowenPackageExport } = await import("../src/services/nowenPackageExport");
  const { importNowenPackage } = await import("../src/services/nowenPackageImport");
  const { undoRoundTripImportBatchWithLinks } = await import("../src/services/roundTripImportLinkUndo");
  const { RoundTripImportUndoError } = await import("../src/services/roundTripImportBatches");
  const { getDb } = await import("../src/db/schema");
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
  assert.equal(imported.success, true);
  const batchId = String(imported.importBatch?.id || "");
  const importedNote = db.prepare("SELECT id FROM notes WHERE notebookId = ?").get(imported.rootNotebookId) as { id: string } | undefined;
  assert.ok(importedNote);
  db.prepare("UPDATE notes SET title = ?, updatedAt = datetime('now') WHERE id = ?")
    .run("用户导入后修改", importedNote!.id);

  await assert.rejects(
    () => undoRoundTripImportBatchWithLinks("batch-user", batchId),
    (error: unknown) => {
      assert.ok(error instanceof RoundTripImportUndoError);
      assert.equal(error.code, "IMPORT_BATCH_UNDO_CONFLICT");
      assert.ok(error.conflicts.some((item) => item.includes("笔记")));
      return true;
    },
  );
  assert.equal(db.prepare("SELECT title FROM notes WHERE id = ?").get(importedNote!.id)?.title, "用户导入后修改");
});
