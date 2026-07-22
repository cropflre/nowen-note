import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-package-roundtrip-test-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");
process.env.ELECTRON_USER_DATA = tmpDir;
process.env.NOWEN_INSTANCE_ID = "roundtrip-source-instance-test";

let closeDb: typeof import("../src/db/schema").closeDb;

test.after(() => {
  closeDb?.();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("Nowen package supports copy, merge and conflict-safe incremental sync round trips", async () => {
  const schema = await import("../src/db/schema");
  const { createNowenPackageExport } = await import("../src/services/nowenPackageExport");
  const { importNowenPackage } = await import("../src/services/nowenPackageImport");
  closeDb = schema.closeDb;
  const db = schema.getDb();

  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
    .run("roundtrip-user", "roundtrip-user", "hash");
  db.prepare(`
    INSERT INTO notebooks (id, userId, parentId, name, sortOrder, isExpanded)
    VALUES (?, ?, NULL, ?, ?, 1)
  `).run("root-source", "roundtrip-user", "产品资料", 10);
  db.prepare(`
    INSERT INTO notebooks (id, userId, parentId, name, sortOrder, isExpanded)
    VALUES (?, ?, ?, ?, ?, 1)
  `).run("empty-source", "roundtrip-user", "root-source", "空目录", 20);
  db.prepare(`
    INSERT INTO notes (
      id, userId, notebookId, title, content, contentText, contentFormat,
      sortOrder, createdAt, updatedAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "note-source",
    "roundtrip-user",
    "root-source",
    "生产记录",
    "[检测报告](/api/attachments/att-source)",
    "生产记录",
    "markdown",
    30,
    "2026-07-22 10:00:00",
    "2026-07-22 11:00:00",
  );

  const attachmentDir = path.join(tmpDir, "attachments");
  fs.mkdirSync(attachmentDir, { recursive: true });
  fs.writeFileSync(path.join(attachmentDir, "source.pdf"), Buffer.from("pdf bytes"));
  db.prepare(`
    INSERT INTO attachments (id, userId, noteId, filename, mimeType, size, path, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "att-source",
    "roundtrip-user",
    "note-source",
    "检测报告.pdf",
    "application/pdf",
    9,
    "source.pdf",
    "2026-07-22 10:30:00",
  );

  const exportSource = () => createNowenPackageExport({
    userId: "roundtrip-user",
    workspaceId: null,
    notebookId: "root-source",
    includeSubNotebooks: true,
    packageKind: "nowen",
  });

  const exported = await exportSource();
  assert.equal(exported.stats.notebooks, 2);
  assert.equal(exported.stats.notes, 1);
  assert.equal(exported.stats.attachments, 1);

  const preview = await importNowenPackage(exported.buffer, {
    userId: "roundtrip-user",
    workspaceId: null,
    importMode: "new-root",
    dryRun: true,
  });
  assert.equal(preview.success, true, preview.errors.join("; "));
  assert.equal(preview.strategy, "copy");
  assert.equal(preview.conflicts?.length, 1);
  assert.equal(preview.conflicts?.[0].action, "rename-root");
  assert.equal(preview.conflicts?.[0].importedName, "产品资料 (2)");
  assert.equal(preview.package?.sync?.available, false);

  const imported = await importNowenPackage(exported.buffer, {
    userId: "roundtrip-user",
    workspaceId: null,
    importMode: "new-root",
  });
  assert.equal(imported.success, true, imported.errors.join("; "));
  assert.equal(imported.counts?.renamedRoots, 1);
  assert.equal(imported.counts?.notebooks, 2);
  assert.equal(imported.counts?.notes, 1);
  assert.equal(imported.counts?.attachments, 1);
  assert.equal(imported.package?.sync?.available, true);

  const importedRoot = db.prepare(`
    SELECT id, name, sortOrder FROM notebooks
     WHERE userId = ? AND workspaceId IS NULL AND parentId IS NULL AND name = ?
  `).get("roundtrip-user", "产品资料 (2)") as { id: string; name: string; sortOrder: number } | undefined;
  assert.ok(importedRoot);
  assert.equal(importedRoot.sortOrder, 10);

  const importedEmpty = db.prepare(`
    SELECT id, name, sortOrder FROM notebooks WHERE parentId = ? AND name = ?
  `).get(importedRoot!.id, "空目录") as { id: string; name: string; sortOrder: number } | undefined;
  assert.ok(importedEmpty, "empty child notebook must survive round-trip");
  assert.equal(importedEmpty!.sortOrder, 20);

  const importedNote = db.prepare(`
    SELECT id, notebookId, title, content, contentFormat, sortOrder, createdAt, updatedAt
      FROM notes
     WHERE notebookId = ? AND title = ?
  `).get(importedRoot!.id, "生产记录") as {
    id: string;
    notebookId: string;
    title: string;
    content: string;
    contentFormat: string;
    sortOrder: number;
    createdAt: string;
    updatedAt: string;
  } | undefined;
  assert.ok(importedNote);
  assert.equal(importedNote!.contentFormat, "markdown");
  assert.equal(importedNote!.sortOrder, 30);
  assert.notEqual(importedNote!.id, "note-source");
  assert.doesNotMatch(importedNote!.content, /att-source/);

  const importedAttachment = db.prepare(`
    SELECT id, noteId, filename, mimeType, size, path
      FROM attachments
     WHERE noteId = ? AND filename = ?
  `).get(importedNote!.id, "检测报告.pdf") as {
    id: string;
    noteId: string;
    filename: string;
    mimeType: string;
    size: number;
    path: string;
  } | undefined;
  assert.ok(importedAttachment);
  assert.match(importedNote!.content, new RegExp(`/api/attachments/${importedAttachment!.id}`));
  assert.equal(importedAttachment!.size, 9);
  assert.equal(fs.readFileSync(path.join(attachmentDir, importedAttachment!.path), "utf8"), "pdf bytes");

  const linkCounts = db.prepare(`
    SELECT resourceType, COUNT(*) AS count
      FROM roundtrip_import_links
     WHERE sourceInstanceId = ?
     GROUP BY resourceType
  `).all("roundtrip-source-instance-test") as Array<{ resourceType: string; count: number }>;
  assert.deepEqual(Object.fromEntries(linkCounts.map((item) => [item.resourceType, item.count])), {
    attachment: 1,
    note: 1,
    notebook: 2,
  });

  // Source changed, target copy untouched: sync updates the mapped target in place.
  db.prepare(`
    UPDATE notes SET title = ?, content = ?, contentText = ?, updatedAt = ? WHERE id = ?
  `).run(
    "生产记录（来源更新）",
    "来源第二版 [检测报告](/api/attachments/att-source)",
    "来源第二版",
    "2026-07-22 12:00:00",
    "note-source",
  );
  const secondPackage = await exportSource();
  const syncPreview = await importNowenPackage(secondPackage.buffer, {
    userId: "roundtrip-user",
    workspaceId: null,
    importMode: "sync",
    dryRun: true,
  });
  assert.equal(syncPreview.success, true, syncPreview.errors.join("; "));
  assert.equal(syncPreview.strategy, "sync");
  assert.equal(syncPreview.counts?.updatedNotes, 1);
  assert.equal(syncPreview.counts?.localConflicts, 0);

  const synced = await importNowenPackage(secondPackage.buffer, {
    userId: "roundtrip-user",
    workspaceId: null,
    importMode: "sync",
  });
  assert.equal(synced.success, true, synced.errors.join("; "));
  assert.equal(synced.counts?.updatedNotes, 1);
  const afterSync = db.prepare("SELECT title, content FROM notes WHERE id = ?").get(importedNote!.id) as { title: string; content: string };
  assert.equal(afterSync.title, "生产记录（来源更新）");
  assert.match(afterSync.content, /来源第二版/);
  assert.match(afterSync.content, new RegExp(`/api/attachments/${importedAttachment!.id}`));

  // Both source and target changed: keep local content and report a conflict.
  db.prepare("UPDATE notes SET title = ?, content = ?, contentText = ?, updatedAt = ? WHERE id = ?")
    .run("本地人工修改", "本地必须保留", "本地必须保留", "2026-07-22 12:30:00", importedNote!.id);
  db.prepare("UPDATE notes SET title = ?, content = ?, contentText = ?, updatedAt = ? WHERE id = ?")
    .run("来源第三版", "来源第三版", "来源第三版", "2026-07-22 13:00:00", "note-source");
  const thirdPackage = await exportSource();
  const conflictPreview = await importNowenPackage(thirdPackage.buffer, {
    userId: "roundtrip-user",
    workspaceId: null,
    importMode: "sync",
    dryRun: true,
  });
  assert.equal(conflictPreview.success, true, conflictPreview.errors.join("; "));
  assert.equal(conflictPreview.counts?.localConflicts, 1);
  assert.ok(conflictPreview.conflicts?.some((item: any) => item.action === "sync-local-conflict" && item.resourceType === "note"));

  const conflictSync = await importNowenPackage(thirdPackage.buffer, {
    userId: "roundtrip-user",
    workspaceId: null,
    importMode: "sync",
  });
  assert.equal(conflictSync.success, true, conflictSync.errors.join("; "));
  assert.equal(conflictSync.counts?.localConflicts, 1);
  const preserved = db.prepare("SELECT title, content FROM notes WHERE id = ?").get(importedNote!.id) as { title: string; content: string };
  assert.equal(preserved.title, "本地人工修改");
  assert.equal(preserved.content, "本地必须保留");

  // Restore the original source title before exercising explicit merge behavior with the first package.
  db.prepare("UPDATE notes SET title = ?, content = ?, contentText = ?, updatedAt = ? WHERE id = ?")
    .run("生产记录", "[检测报告](/api/attachments/att-source)", "生产记录", "2026-07-22 11:00:00", "note-source");

  const mergePreview = await importNowenPackage(exported.buffer, {
    userId: "roundtrip-user",
    workspaceId: null,
    importMode: "merge",
    dryRun: true,
  });
  assert.equal(mergePreview.success, true, mergePreview.errors.join("; "));
  assert.equal(mergePreview.strategy, "merge");
  assert.equal(mergePreview.counts?.notebooks, 0, "all package folders already exist in the matching root");
  assert.equal(mergePreview.counts?.mergedNotebooks, 2);
  assert.equal(mergePreview.counts?.renamedNotes, 1);
  assert.ok(mergePreview.conflicts?.some((item: any) => item.action === "merge-directory" && item.originalName === "产品资料"));
  assert.ok(mergePreview.conflicts?.some((item: any) => item.action === "rename-note" && item.importedName === "生产记录 (2)"));

  const merged = await importNowenPackage(exported.buffer, {
    userId: "roundtrip-user",
    workspaceId: null,
    importMode: "merge",
  });
  assert.equal(merged.success, true, merged.errors.join("; "));
  assert.equal(merged.counts?.notebooks, 0);
  assert.equal(merged.counts?.mergedNotebooks, 2);
  assert.equal(merged.counts?.renamedNotes, 1);
  assert.equal(merged.rootNotebookId, "root-source", "merge reuses the deterministic existing root");

  const mergedNote = db.prepare(`
    SELECT id, notebookId, title, content FROM notes
     WHERE notebookId = ? AND title = ?
  `).get("root-source", "生产记录 (2)") as {
    id: string;
    notebookId: string;
    title: string;
    content: string;
  } | undefined;
  assert.ok(mergedNote, "merge creates a numbered note instead of overwriting the original");
  assert.notEqual(mergedNote!.id, "note-source");
  const sourceStillPresent = db.prepare("SELECT content FROM notes WHERE id = ?").get("note-source") as { content: string } | undefined;
  assert.equal(sourceStillPresent?.content, "[检测报告](/api/attachments/att-source)");
  const mergedAttachment = db.prepare("SELECT id, path FROM attachments WHERE noteId = ?").get(mergedNote!.id) as { id: string; path: string } | undefined;
  assert.ok(mergedAttachment);
  assert.match(mergedNote!.content, new RegExp(`/api/attachments/${mergedAttachment!.id}`));
  assert.equal(fs.readFileSync(path.join(attachmentDir, mergedAttachment!.path), "utf8"), "pdf bytes");
});
