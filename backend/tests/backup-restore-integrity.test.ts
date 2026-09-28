import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import {
  auditAttachmentBackup,
  getDirectoryStats,
  replaceDirectoriesFromStagingSafe,
  verifyStagedAttachmentStats,
} from "../src/services/backup-restore-integrity";

function createAuditDb(root: string, paths: string[], objectStorageEnabled = false): string {
  const dbPath = path.join(root, "backup.db");
  const db = new Database(dbPath);
  db.exec("CREATE TABLE attachments (id TEXT PRIMARY KEY, path TEXT); CREATE TABLE system_settings (key TEXT PRIMARY KEY, value TEXT);");
  const insert = db.prepare("INSERT INTO attachments (id, path) VALUES (?, ?)");
  paths.forEach((attachmentPath, index) => insert.run("a-" + index, attachmentPath));
  if (objectStorageEnabled) {
    db.prepare("INSERT INTO system_settings (key, value) VALUES (?, ?)")
      .run("attachmentStorage:config", JSON.stringify({ enabled: true }));
  }
  db.close();
  return dbPath;
}

test("attachment audit rejects meta/archive count mismatch before touching live data", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-restore-audit-"));
  try {
    const dbPath = createAuditDb(root, []);
    assert.throws(
      () => auditAttachmentBackup(dbPath, ["one.bin"], { count: 2, bytes: 3 }),
      /附件归档数量校验失败/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("attachment audit accepts empty and matching local attachment sets", () => {
  const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-restore-empty-"));
  const matchingRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-restore-match-"));
  try {
    const emptyDb = createAuditDb(emptyRoot, []);
    const emptyAudit = auditAttachmentBackup(emptyDb, [], { count: 0, bytes: 0 });
    assert.equal(emptyAudit.archiveCount, 0);
    assert.equal(emptyAudit.dbRows, 0);
    assert.equal(emptyAudit.dbDistinctPaths, 0);

    const matchingDb = createAuditDb(matchingRoot, ["2026/09/one.bin"]);
    const matchingAudit = auditAttachmentBackup(
      matchingDb,
      ["2026/09/one.bin"],
      { count: 1, bytes: 3 },
    );
    assert.equal(matchingAudit.archiveCount, 1);
    assert.equal(matchingAudit.dbRows, 1);
    assert.equal(matchingAudit.dbDistinctPaths, 1);
    assert.deepEqual(matchingAudit.missingDbPaths, []);
  } finally {
    fs.rmSync(emptyRoot, { recursive: true, force: true });
    fs.rmSync(matchingRoot, { recursive: true, force: true });
  }
});

test("attachment audit rejects local DB paths missing from full ZIP", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-restore-audit-"));
  try {
    const dbPath = createAuditDb(root, ["2026/09/missing.bin"]);
    assert.throws(
      () => auditAttachmentBackup(dbPath, ["2026/09/present.bin"], { count: 1 }),
      /附件一致性校验失败/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("object-storage backups do not require remote object paths inside the local ZIP", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-restore-audit-"));
  try {
    const dbPath = createAuditDb(root, ["remote-only.bin"], true);
    const audit = auditAttachmentBackup(dbPath, [], { count: 0, bytes: 0 });
    assert.equal(audit.objectStorageEnabled, true);
    assert.equal(audit.dbRows, 1);
    assert.equal(audit.dbDistinctPaths, 1);
    assert.deepEqual(audit.missingDbPaths, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("staging count and bytes must match archive metadata", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-restore-stage-"));
  try {
    const staged = path.join(root, "attachments");
    fs.mkdirSync(staged, { recursive: true });
    fs.writeFileSync(path.join(staged, "one.bin"), "abc");
    const audit = {
      metaCount: 1,
      metaBytes: 3,
      archiveCount: 1,
      dbRows: 0,
      dbDistinctPaths: 0,
      missingDbPaths: [],
      objectStorageEnabled: false,
    };
    const verified = verifyStagedAttachmentStats(staged, audit);
    assert.equal(verified.stagedCount, 1);
    assert.equal(verified.stagedBytes, 3);

    fs.writeFileSync(path.join(staged, "two.bin"), "x");
    assert.throws(
      () => verifyStagedAttachmentStats(staged, audit),
      /staging 数量校验失败/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("EBUSY mount-point rename falls back to in-place sync and preserves directory root", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-restore-mount-"));
  const staged = path.join(root, "staged");
  const dest = path.join(root, "attachments");
  fs.mkdirSync(staged, { recursive: true });
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(staged, "new.txt"), "new");
  fs.writeFileSync(path.join(dest, "old.txt"), "old");

  const before = fs.statSync(dest);
  const originalRename = fs.renameSync;
  fs.renameSync = ((oldPath: fs.PathLike, newPath: fs.PathLike) => {
    if (
      path.resolve(String(oldPath)) === path.resolve(dest)
      && String(newPath).includes(".before-restore.")
    ) {
      const error = new Error("simulated bind mount EBUSY") as NodeJS.ErrnoException;
      error.code = "EBUSY";
      throw error;
    }
    return originalRename(oldPath, newPath);
  }) as typeof fs.renameSync;

  try {
    await replaceDirectoriesFromStagingSafe(
      [{ stagedDir: staged, destDir: dest }],
      "mount-test",
    );
    assert.equal(fs.readFileSync(path.join(dest, "new.txt"), "utf8"), "new");
    assert.equal(fs.existsSync(path.join(dest, "old.txt")), false);
    const after = fs.statSync(dest);
    if (process.platform !== "win32") {
      assert.equal(after.ino, before.ino, "fallback must preserve the mounted directory inode");
    }
    assert.deepEqual(getDirectoryStats(dest), { count: 1, bytes: 3 });
  } finally {
    fs.renameSync = originalRename;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("post-replace verifier failure rolls live directory contents back", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-restore-rollback-"));
  const staged = path.join(root, "staged");
  const dest = path.join(root, "attachments");
  fs.mkdirSync(staged, { recursive: true });
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(staged, "new.txt"), "new");
  fs.writeFileSync(path.join(dest, "old.txt"), "old");

  try {
    await assert.rejects(
      replaceDirectoriesFromStagingSafe(
        [{ stagedDir: staged, destDir: dest }],
        "verify-fails",
        async () => {
          throw new Error("simulated storage probe failure");
        },
      ),
      /simulated storage probe failure/,
    );

    assert.equal(fs.readFileSync(path.join(dest, "old.txt"), "utf8"), "old");
    assert.equal(fs.existsSync(path.join(dest, "new.txt")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
