const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const folderSync = require("../folder-sync");

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("exclude patterns support path globs and basename wildcards", () => {
  const { matchesExcludePattern } = folderSync._test;
  assert.equal(matchesExcludePattern("private/draft/a.md", "private/**"), true);
  assert.equal(matchesExcludePattern("notes/cache.tmp", "*.tmp"), true);
  assert.equal(matchesExcludePattern("notes/final.md", "*.tmp"), false);
});

test("rename detection preserves stable source identity and note binding", () => {
  const oldIndex = [{
    relativePath: "old/name.md",
    filename: "name.md",
    size: 12,
    mtimeMs: 1,
    sha256: "a".repeat(64),
    sourcePathHash: "b".repeat(64),
    status: "synced",
    noteId: "note-1",
    attachmentId: null,
    lastScannedAt: "2026-01-01T00:00:00.000Z",
    lastSyncedAt: "2026-01-01T00:00:00.000Z",
  }];
  const scan = [{
    relativePath: "new/name.md",
    filename: "name.md",
    size: 12,
    mtimeMs: 2,
    sha256: "a".repeat(64),
    status: "new",
  }];

  const merged = folderSync._test.mergeIndex(oldIndex, scan, { complete: true, folderId: "root-1" });
  assert.equal(merged.length, 1);
  assert.equal(merged[0].status, "renamed");
  assert.equal(merged[0].previousRelativePath, "old/name.md");
  assert.equal(merged[0].sourcePathHash, "b".repeat(64));
  assert.equal(merged[0].noteId, "note-1");
});

test("an incomplete scan never converts unseen indexed files into deletions", () => {
  const oldIndex = [{
    relativePath: "kept.md",
    filename: "kept.md",
    size: 8,
    mtimeMs: 1,
    sha256: "c".repeat(64),
    sourcePathHash: "d".repeat(64),
    status: "synced",
    noteId: "note-safe",
    lastScannedAt: "2026-01-01T00:00:00.000Z",
    lastSyncedAt: "2026-01-01T00:00:00.000Z",
  }];

  const merged = folderSync._test.mergeIndex(oldIndex, [], { complete: false, folderId: "root-2" });
  assert.equal(merged.length, 1);
  assert.equal(merged[0].status, "unchanged");
  assert.equal(merged[0].noteId, "note-safe");
});

test("advanced preference control messages are persisted but never added to logs", () => {
  const dataDir = tempDir("nowen-folder-sync-v2-");
  const sourceDir = path.join(dataDir, "source");
  fs.mkdirSync(sourceDir, { recursive: true });
  folderSync.setDataDir(dataDir);
  const created = folderSync.saveConfig({
    folderPath: sourceDir,
    targetNotebookId: "notebook-1",
    enabled: false,
  });
  assert.equal(created.ok, true);

  const message = "__NOWEN_FOLDER_SYNC_PREFS__:" + JSON.stringify({
    conflictPolicy: "copy",
    deletionPolicy: "detach",
    extractAttachmentText: false,
    excludePatterns: ["private/**", "*.tmp"],
  });
  folderSync.appendLog(created.config.folderId, "sync", message);

  const config = folderSync.readConfigs().find((item) => item.folderId === created.config.folderId);
  assert.equal(config.conflictPolicy, "copy");
  assert.equal(config.deletionPolicy, "detach");
  assert.equal(config.extractAttachmentText, false);
  assert.deepEqual(config.excludePatterns, ["private/**", "*.tmp"]);
  assert.equal(folderSync.getLogs(created.config.folderId).some((log) => log.message.includes("NOWEN_FOLDER_SYNC_PREFS")), false);
});

test("Issue #813: enabling hierarchy reorganizes old synced notes without reading or uploading file contents", () => {
  const dataDir = tempDir("nowen-hierarchy-index-");
  const sourceDir = path.join(dataDir, "source");
  fs.mkdirSync(path.join(sourceDir, "team", "guide"), { recursive: true });
  fs.writeFileSync(path.join(sourceDir, "team", "guide", "manual.md"), "# Manual", "utf8");
  try {
    folderSync.setDataDir(dataDir);
    const configured = folderSync.saveConfig({
      folderPath: sourceDir, targetNotebookId: "target-root-1",
      enabled: true, includeSubfolders: true, fileTypes: [".md"],
    });
    const id = configured.config.folderId;
    const first = folderSync.runNow(id);
    assert.equal(first.ok, true);
    const incoming = folderSync.getPendingUploads(id);
    assert.equal(incoming.pending.length, 1);
    assert.notEqual(incoming.pending[0].action, "organize");
    const rel = "team/guide/manual.md";
    folderSync.markUploadResult(id, rel, { success: true, noteId: "existing-note-1" });

    folderSync.appendLog(id, "sync", "__NOWEN_FOLDER_SYNC_PREFS__:" + JSON.stringify({
      preserveHierarchy: true, conflictPolicy: "protect",
      deletionPolicy: "keep", extractAttachmentText: true, excludePatterns: [],
    }));
    folderSync.runNow(id);
    const migrate = folderSync.getPendingUploads(id);
    assert.equal(migrate.pending.length, 1);
    assert.equal(migrate.pending[0].action, "organize");
    assert.equal(migrate.pending[0].existingNoteId, "existing-note-1");
    assert.equal(migrate.pending[0].contentText, null);
    const checked = folderSync.markUploadResult(id, rel, {
      success: true, noteId: "existing-note-1", hierarchyTarget: "target-root-1:" + id,
    });
    assert.equal(checked.ok, true);
    folderSync.runNow(id);
    assert.equal(folderSync.getPendingUploads(id).pending.length, 0);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
