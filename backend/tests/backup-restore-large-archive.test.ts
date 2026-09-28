import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import JSZip from "jszip";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-large-restore-"));
const backupDir = path.join(tmpDir, "backups");
const dbPath = path.join(tmpDir, "nowen-note.db");
const markerKey = "backup-large-restore:marker";
const userId = "large-restore-user";

process.env.DB_PATH = dbPath;
process.env.ELECTRON_USER_DATA = tmpDir;
process.env.BACKUP_DIR = backupDir;

let getDb: typeof import("../src/db/schema").getDb;
let closeDb: typeof import("../src/db/schema").closeDb;
let getDbSchemaVersion: typeof import("../src/db/schema").getDbSchemaVersion;
let manager: import("../src/services/backup").BackupManager;

function resetDb(marker: string): void {
  closeDb?.();
  for (const suffix of ["", "-wal", "-shm"]) {
    fs.rmSync(dbPath + suffix, { force: true });
  }
  const db = getDb();
  db.prepare("INSERT OR IGNORE INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
    .run(userId, userId, "hash");
  db.prepare("INSERT OR REPLACE INTO system_settings (key, value) VALUES (?, ?)")
    .run(markerKey, marker);
}

function resetFiles(): void {
  fs.mkdirSync(backupDir, { recursive: true });
  for (const name of ["attachments", "fonts", "plugins"]) {
    const dir = path.join(tmpDir, name);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "old.txt"), `old-${name}`, "utf8");
  }
  fs.writeFileSync(path.join(tmpDir, ".jwt_secret"), "old-secret", "utf8");
}

function readMarker(): string | undefined {
  const row = getDb().prepare("SELECT value FROM system_settings WHERE key = ?")
    .get(markerKey) as { value?: string } | undefined;
  return row?.value;
}

async function writeFullBackup(
  filename: string,
  options: { metaAttachmentCount?: number; invalidObjectStorageConfig?: boolean } = {},
): Promise<string> {
  const snapshot = path.join(backupDir, `snapshot-${crypto.randomUUID()}.db`);
  await getDb().backup(snapshot);
  const snapshotDb = new Database(snapshot);
  try {
    snapshotDb.prepare("INSERT OR REPLACE INTO system_settings (key, value) VALUES (?, ?)")
      .run(markerKey, "backup");
    if (options.invalidObjectStorageConfig) {
      snapshotDb.prepare("INSERT OR REPLACE INTO system_settings (key, value) VALUES (?, ?)")
        .run("attachmentStorage:config", JSON.stringify({
          enabled: true,
          endpoint: "",
          region: "auto",
          bucket: "",
          accessKeyId: "",
          secretAccessKeyEnc: "",
          prefix: "",
        }));
    }
  } finally {
    snapshotDb.close();
  }

  const zip = new JSZip();
  zip.file("meta.json", JSON.stringify({
    formatVersion: 2,
    schemaVersion: getDbSchemaVersion(),
    createdAt: new Date().toISOString(),
    tables: { users: 1, system_settings: 1 },
    files: {
      attachments: { count: options.metaAttachmentCount ?? 1, bytes: 3 },
      fonts: { count: 1, bytes: 3 },
      plugins: { count: 1, bytes: 3 },
    },
  }));
  zip.file("db.sqlite", fs.readFileSync(snapshot));
  zip.folder("attachments")?.file("new.txt", "new");
  zip.folder("fonts")?.file("new.txt", "new");
  zip.folder("plugins")?.file("new.txt", "new");
  zip.file(".jwt_secret", "new-secret");

  const target = path.join(backupDir, filename);
  fs.writeFileSync(target, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
  fs.rmSync(snapshot, { force: true });
  return target;
}

test.before(async () => {
  const schemaModule = await import("../src/db/schema");
  const backupModule = await import("../src/services/backup");
  await import("../src/runtime/backup-restore-large-archive");
  getDb = schemaModule.getDb;
  closeDb = schemaModule.closeDb;
  getDbSchemaVersion = schemaModule.getDbSchemaVersion;
  manager = new backupModule.BackupManager();
});

test.beforeEach(() => {
  fs.rmSync(backupDir, { recursive: true, force: true });
  resetFiles();
  resetDb("current");
});

test.after(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("full ZIP dry-run and restore never read the whole archive into a Buffer", async () => {
  const filename = "streaming-full.zip";
  const archivePath = await writeFullBackup(filename);
  const originalReadFileSync = fs.readFileSync;

  fs.readFileSync = ((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    if (typeof file !== "number" && path.resolve(String(file)) === path.resolve(archivePath)) {
      throw new Error("whole archive read is forbidden");
    }
    return (originalReadFileSync as (...params: unknown[]) => unknown)(file, ...args);
  }) as typeof fs.readFileSync;

  try {
    const preview = await manager.restoreFromBackup(filename, { dryRun: true });
    assert.equal(preview.success, true);
    assert.equal(readMarker(), "current", "dry-run must not modify the live database");

    const restored = await manager.restoreFromBackup(filename, { dryRun: false });
    assert.equal(restored.success, true);
    assert.equal(readMarker(), "backup");
    assert.equal(fs.readFileSync(path.join(tmpDir, "attachments", "new.txt"), "utf8"), "new");
    assert.equal(fs.readFileSync(path.join(tmpDir, "fonts", "new.txt"), "utf8"), "new");
    assert.equal(fs.readFileSync(path.join(tmpDir, "plugins", "new.txt"), "utf8"), "new");
    assert.equal(fs.readFileSync(path.join(tmpDir, ".jwt_secret"), "utf8"), "new-secret");
  } finally {
    fs.readFileSync = originalReadFileSync;
  }
});


test("attachment meta/archive mismatch is rejected before live database or files are touched", async () => {
  const filename = "attachment-count-mismatch.zip";
  await writeFullBackup(filename, { metaAttachmentCount: 2 });

  const preview = await manager.restoreFromBackup(filename, { dryRun: true });
  assert.equal(preview.success, false);
  assert.match(preview.error || "", /附件归档数量校验失败/);
  assert.equal(readMarker(), "current");
  assert.equal(fs.readFileSync(path.join(tmpDir, "attachments", "old.txt"), "utf8"), "old-attachments");
});

test("bind-mount style EBUSY rename falls back to in-place attachment restore", async () => {
  const filename = "mountpoint-fallback.zip";
  await writeFullBackup(filename);

  const attachmentsDir = path.join(tmpDir, "attachments");
  const before = fs.statSync(attachmentsDir);
  const originalRenameSync = fs.renameSync;

  fs.renameSync = ((oldPath: fs.PathLike, newPath: fs.PathLike) => {
    if (
      path.resolve(String(oldPath)) === path.resolve(attachmentsDir)
      && String(newPath).includes(".before-restore.")
    ) {
      const error = new Error("simulated Docker bind mount EBUSY") as NodeJS.ErrnoException;
      error.code = "EBUSY";
      throw error;
    }
    return originalRenameSync(oldPath, newPath);
  }) as typeof fs.renameSync;

  try {
    const restored = await manager.restoreFromBackup(filename, { dryRun: false });
    assert.equal(restored.success, true, restored.error);
    assert.equal(readMarker(), "backup");
    assert.equal(fs.readFileSync(path.join(attachmentsDir, "new.txt"), "utf8"), "new");
    assert.equal(fs.existsSync(path.join(attachmentsDir, "old.txt")), false);
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(attachmentsDir).ino, before.ino);
    }
  } finally {
    fs.renameSync = originalRenameSync;
  }
});

test("post-restore attachment storage probe failure rolls database and files back", async () => {
  const filename = "storage-probe-fails.zip";
  await writeFullBackup(filename);

  const originalWriteFileSync = fs.writeFileSync;
  fs.writeFileSync = ((file: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, options?: fs.WriteFileOptions) => {
    if (String(file).includes(".nowen-storage-probe-")) {
      const error = new Error("simulated read-only attachment mount") as NodeJS.ErrnoException;
      error.code = "EACCES";
      throw error;
    }
    return originalWriteFileSync(file, data, options);
  }) as typeof fs.writeFileSync;

  try {
    const restored = await manager.restoreFromBackup(filename, { dryRun: false });
    assert.equal(restored.success, false);
    assert.match(
      restored.error || "",
      /ATTACHMENT_STORAGE_PERMISSION_DENIED|附件存储健康检查失败|文件目录恢复失败/,
    );
    assert.equal(readMarker(), "current");
    assert.equal(fs.readFileSync(path.join(tmpDir, "attachments", "old.txt"), "utf8"), "old-attachments");
    assert.equal(fs.existsSync(path.join(tmpDir, "attachments", "new.txt")), false);
  } finally {
    fs.writeFileSync = originalWriteFileSync;
  }
});

test("invalid restored object-storage config fails closed and rolls back", async () => {
  const filename = "invalid-object-storage.zip";
  await writeFullBackup(filename, { invalidObjectStorageConfig: true });

  const restored = await manager.restoreFromBackup(filename, { dryRun: false });

  assert.equal(restored.success, false);
  assert.match(
    restored.error || "",
    /ATTACHMENT_STORAGE_CONFIG_INVALID|对象存储|配置不完整|附件存储健康检查失败/,
  );
  assert.equal(readMarker(), "current");
  assert.equal(fs.readFileSync(path.join(tmpDir, "attachments", "old.txt"), "utf8"), "old-attachments");
  assert.equal(fs.existsSync(path.join(tmpDir, "attachments", "new.txt")), false);
});

