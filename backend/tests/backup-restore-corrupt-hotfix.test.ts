import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import Database from "better-sqlite3";
import JSZip from "jszip";
import { loadSqliteVec } from "../src/db/sqlite-vec-extension.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-backup-restore-hotfix-"));
const backupDir = path.join(tmpDir, "backups");
const dbPath = path.join(tmpDir, "nowen-note.db");
const markerKey = "backup-restore-hotfix:marker";
const userId = "restore-user";

process.env.DB_PATH = dbPath;
process.env.ELECTRON_USER_DATA = tmpDir;
process.env.BACKUP_DIR = backupDir;

let getDb: typeof import("../src/db/schema").getDb;
let closeDb: typeof import("../src/db/schema").closeDb;
let getDbSchemaVersion: typeof import("../src/db/schema").getDbSchemaVersion;
let manager: import("../src/services/backup").BackupManager;

function cleanupDbSidecars() {
  for (const sfx of ["", "-wal", "-shm"]) {
    const file = dbPath + sfx;
    if (fs.existsSync(file)) fs.rmSync(file, { force: true });
  }
}

function resetDataDir() {
  for (const name of ["attachments", "fonts", "plugins"]) {
    fs.rmSync(path.join(tmpDir, name), { recursive: true, force: true });
    fs.mkdirSync(path.join(tmpDir, name), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, name, "old.txt"), `old-${name}`, "utf-8");
  }
  fs.writeFileSync(path.join(tmpDir, ".jwt_secret"), "old-secret", "utf-8");
}

function resetBackups() {
  fs.rmSync(backupDir, { recursive: true, force: true });
  fs.mkdirSync(backupDir, { recursive: true });
}

function seedCurrentDb(marker: string) {
  closeDb?.();
  cleanupDbSidecars();
  const db = getDb();
  db.prepare("INSERT OR IGNORE INTO users (id, username, passwordHash) VALUES (?, ?, ?)").run(userId, userId, "hash");
  db.prepare("INSERT OR REPLACE INTO system_settings (key, value) VALUES (?, ?)").run(markerKey, marker);
}

function readMarker() {
  const row = getDb().prepare("SELECT value FROM system_settings WHERE key = ?").get(markerKey) as { value: string } | undefined;
  return row?.value;
}

function assertLoginSessionWritable(id: string) {
  getDb()
    .prepare(
      `INSERT INTO user_sessions (id, userId, ip, userAgent, createdAt, lastSeenAt)
       VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))`,
    )
    .run(id, userId, "127.0.0.1", "restore-hotfix-test");

  const row = getDb().prepare("SELECT id FROM user_sessions WHERE id = ?").get(id) as { id: string } | undefined;
  assert.equal(row?.id, id);
}

function assertNoWalShm() {
  assert.equal(fs.existsSync(dbPath + "-wal"), false, "nowen-note.db-wal should not remain after failed restore");
  assert.equal(fs.existsSync(dbPath + "-shm"), false, "nowen-note.db-shm should not remain after failed restore");
}

async function createBackupDb(marker: string) {
  const backupDbPath = path.join(backupDir, `valid-${crypto.randomUUID()}.db`);
  await getDb().backup(backupDbPath);
  const db = new Database(backupDbPath);
  try {
    assert.equal(loadSqliteVec(db).loaded, true);
    db.prepare("INSERT OR REPLACE INTO system_settings (key, value) VALUES (?, ?)").run(markerKey, marker);
  } finally {
    db.close();
  }
  return backupDbPath;
}

async function writeZipBackup(filename: string, options: { corruptDb?: boolean; includeSecret?: boolean } = {}) {
  const zip = new JSZip();
  const dbBuffer = options.corruptDb
    ? Buffer.from("not a sqlite database")
    : fs.readFileSync(await createBackupDb("backup"));

  zip.file("meta.json", JSON.stringify({
    formatVersion: 2,
    schemaVersion: getDbSchemaVersion(),
    createdAt: new Date().toISOString(),
    tables: { users: 1, system_settings: 1 },
    files: {
      attachments: { count: 1, bytes: 3 },
      fonts: { count: 1, bytes: 3 },
      plugins: { count: 1, bytes: 3 },
    },
  }));
  zip.file("db.sqlite", dbBuffer);
  zip.folder("attachments")?.file("new.txt", "new");
  zip.folder("fonts")?.file("new.txt", "new");
  zip.folder("plugins")?.file("new.txt", "new");
  if (options.includeSecret) zip.file(".jwt_secret", "new-secret");

  const out = await zip.generateAsync({ type: "nodebuffer" });
  fs.writeFileSync(path.join(backupDir, filename), out);
}

function beforeRestoreBackups() {
  return fs.readdirSync(tmpDir).filter((name) => name.includes(".before-restore.") && name.endsWith(".bak"));
}

test.before(async () => {
  const schemaModule = await import("../src/db/schema");
  const backupModule = await import("../src/services/backup");
  getDb = schemaModule.getDb;
  closeDb = schemaModule.closeDb;
  getDbSchemaVersion = schemaModule.getDbSchemaVersion;
  manager = new backupModule.BackupManager();
});

test.beforeEach(() => {
  resetBackups();
  resetDataDir();
  seedCurrentDb("current");
});

test.after(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("db-only snapshot containing vec0 previews and restores without no such module error", async () => {
  const db = getDb();
  assert.equal(loadSqliteVec(db).loaded, true);
  db.exec("CREATE VIRTUAL TABLE vec_note_chunks USING vec0(embedding float[2])");
  db.prepare("INSERT INTO vec_note_chunks(rowid, embedding) VALUES (?, ?)").run(7n, "[0,1]");
  const backupFile = await createBackupDb("backup");
  const filename = path.basename(backupFile);
  db.prepare("DELETE FROM vec_note_chunks WHERE rowid = ?").run(7);

  const preview = await manager.restoreFromBackup(filename, { dryRun: true });
  assert.equal(preview.success, true, preview.error);
  assert.equal(readMarker(), "current");
  const restored = await manager.restoreFromBackup(filename, { dryRun: false });
  assert.equal(restored.success, true, restored.error);
  assert.equal(readMarker(), "backup");
  assert.equal((getDb().prepare("SELECT COUNT(*) AS c FROM vec_note_chunks").get() as { c: number }).c, 1);
});

test("corrupt db-only restore does not poison current database", async () => {
  fs.writeFileSync(path.join(backupDir, "broken.bak"), Buffer.from("not a sqlite database"));

  const result = await manager.restoreFromBackup("broken.bak", { dryRun: false });

  assert.equal(result.success, false);
  assert.match(result.error || "", /备份文件完整性检查失败|已自动回滚|not a database|file is not a database/i);
  assert.equal(readMarker(), "current");
  assertLoginSessionWritable("session-after-broken-db-only");
});

test("corrupt zip db.sqlite is rejected before touching current database or jwt secret", async () => {
  await writeZipBackup("broken-full.zip", { corruptDb: true, includeSecret: true });

  const result = await manager.restoreFromBackup("broken-full.zip", { dryRun: false });

  assert.equal(result.success, false);
  assert.match(result.error || "", /备份文件完整性检查失败|not a database|file is not a database/i);
  assert.equal(readMarker(), "current");
  assert.equal(fs.readFileSync(path.join(tmpDir, ".jwt_secret"), "utf-8"), "old-secret");
  assert.equal(fs.readFileSync(path.join(tmpDir, "attachments", "old.txt"), "utf-8"), "old-attachments");
  assertLoginSessionWritable("session-after-broken-zip");
});

test("zip file-stage failure rolls back database and does not update jwt secret", async () => {
  await writeZipBackup("file-stage-fails.zip", { includeSecret: true });
  const originalRenameSync = fs.renameSync;
  let simulated = false;

  fs.renameSync = ((oldPath: fs.PathLike, newPath: fs.PathLike) => {
    const oldText = String(oldPath);
    const newText = String(newPath);
    if (!simulated && oldText.includes(".nowen-restore-staging") && newText.endsWith(`${path.sep}fonts`)) {
      simulated = true;
      const err = new Error("simulated unrecoverable fonts restore failure") as NodeJS.ErrnoException;
      // EACCES/EPERM/EBUSY/EXDEV are intentionally recoverable now: Docker/NAS mount roots
      // may reject directory rename and should fall back to in-place synchronization.
      // EIO models a real copy/device failure and must still roll the whole restore back.
      err.code = "EIO";
      throw err;
    }
    return originalRenameSync(oldPath, newPath);
  }) as typeof fs.renameSync;

  try {
    const result = await manager.restoreFromBackup("file-stage-fails.zip", { dryRun: false });

    assert.equal(result.success, false);
    assert.match(result.error || "", /已自动回滚|文件目录|fonts|simulated unrecoverable fonts restore failure/);
    assertNoWalShm();
    assert.equal(readMarker(), "current");
    assert.equal(fs.readFileSync(path.join(tmpDir, ".jwt_secret"), "utf-8"), "old-secret");
    assert.equal(fs.readFileSync(path.join(tmpDir, "attachments", "old.txt"), "utf-8"), "old-attachments");
    assert.equal(fs.readFileSync(path.join(tmpDir, "fonts", "old.txt"), "utf-8"), "old-fonts");
    assertLoginSessionWritable("session-after-file-stage-failure");
    assert.ok(beforeRestoreBackups().length > 0, "restore failure after replacement should keep before-restore backup");
  } finally {
    fs.renameSync = originalRenameSync;
  }
});

test("jwt secret write failure is warning-only after database and file restore succeed", async () => {
  await writeZipBackup("jwt-write-fails.zip", { includeSecret: true });
  const originalWriteFileSync = fs.writeFileSync;
  let simulated = false;

  fs.writeFileSync = ((file: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, options?: fs.WriteFileOptions) => {
    if (!simulated && String(file).endsWith(".jwt_secret")) {
      simulated = true;
      const err = new Error("simulated jwt secret write failure") as NodeJS.ErrnoException;
      err.code = "EACCES";
      throw err;
    }
    return originalWriteFileSync(file, data, options);
  }) as typeof fs.writeFileSync;

  try {
    const result = await manager.restoreFromBackup("jwt-write-fails.zip", { dryRun: false });

    assert.equal(result.success, true);
    assert.equal(readMarker(), "backup");
    assert.equal(fs.readFileSync(path.join(tmpDir, ".jwt_secret"), "utf-8"), "old-secret");
    assertLoginSessionWritable("session-after-jwt-warning");
  } finally {
    fs.writeFileSync = originalWriteFileSync;
  }
});
