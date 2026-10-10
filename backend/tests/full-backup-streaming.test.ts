import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import test from "node:test";
import JSZip from "jszip";
import {
  createBackupFilename,
  createFullBackupArchive,
  hashFileSha256,
  scrubPluginStudioProjectsFromBackup,
} from "../src/services/backup-archive";
import Database from "better-sqlite3";

test("同一秒创建的备份仍使用不同文件名", () => {
  const now = new Date("2026-08-14T02:00:00.000Z");
  const first = createBackupFilename("full", "11111111-1111-4111-8111-111111111111", now);
  const second = createBackupFilename("full", "22222222-2222-4222-8222-222222222222", now);
  assert.notEqual(first, second);
  assert.match(first, /^nowen-backup-full-2026-08-14T02-00-00-[a-f0-9]{8}\.zip$/);
});

test("完整备份创建时不会把附件或最终 ZIP 整包读入内存", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-full-backup-streaming-"));
  const dataDir = path.join(root, "data");
  const backupDir = path.join(root, "backups");
  const attachmentDir = path.join(dataDir, "attachments");
  const attachmentPath = path.join(attachmentDir, "sample.bin");
  const studioProjectPath = path.join(dataDir, "plugin-projects", "draft-project", "src", "index.ts");
  const dbPath = path.join(root, "db.sqlite");
  const zipPath = path.join(backupDir, "nowen-backup-full-test.zip");
  fs.mkdirSync(attachmentDir, { recursive: true });
  fs.mkdirSync(backupDir, { recursive: true });
  fs.writeFileSync(attachmentPath, Buffer.alloc(256 * 1024, 0x5a));
  fs.mkdirSync(path.dirname(studioProjectPath), { recursive: true });
  fs.writeFileSync(studioProjectPath, "export const draft = true;\n");
  fs.writeFileSync(dbPath, Buffer.from("SQLite format 3\0test database snapshot"));

  const originalReadFileSync = fs.readFileSync;
  (fs as any).readFileSync = function guardedReadFileSync(target: fs.PathOrFileDescriptor, ...args: unknown[]) {
    const resolved = typeof target === "string" ? path.resolve(target) : "";
    const isFinalZip = resolved.startsWith(path.resolve(backupDir) + path.sep) && resolved.endsWith(".zip");
    if (resolved === path.resolve(attachmentPath) || isFinalZip) {
      throw new Error(`禁止整包读取：${resolved}`);
    }
    return (originalReadFileSync as any).call(fs, target, ...args);
  };

  try {
    const stats = await createFullBackupArchive({
      zipPath,
      dbPath,
      dataDir,
      buildMeta: (files) => ({ formatVersion: 2, type: "full", files }),
    });
    const hashed = await hashFileSha256(zipPath);
    assert.equal(stats.attachments.count, 1);
    assert.equal(hashed.size, fs.statSync(zipPath).size);
    assert.match(hashed.checksum, /^[a-f0-9]{64}$/);
  } finally {
    (fs as any).readFileSync = originalReadFileSync;
  }

  try {
    const zip = await JSZip.loadAsync(fs.readFileSync(zipPath));
    assert.ok(zip.file("db.sqlite"));
    assert.ok(zip.file("attachments/sample.bin"));
    assert.ok(zip.file("meta.json"));
    assert.equal(zip.file("plugin-projects/draft-project/src/index.ts"), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("普通数据库备份会移除 Plugin Studio 项目记录", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-studio-backup-scrub-"));
  const dbPath = path.join(root, "backup.db");
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE plugin_studio_projects (id TEXT PRIMARY KEY);
    CREATE TABLE plugin_studio_generations (id TEXT PRIMARY KEY, projectId TEXT);
    CREATE TABLE plugin_studio_artifacts (id TEXT PRIMARY KEY, projectId TEXT);
    INSERT INTO plugin_studio_projects VALUES ('project');
    INSERT INTO plugin_studio_generations VALUES ('generation', 'project');
    INSERT INTO plugin_studio_artifacts VALUES ('artifact', 'project');
  `);
  db.close();

  try {
    scrubPluginStudioProjectsFromBackup(dbPath);
    const scrubbed = new Database(dbPath, { readonly: true });
    try {
      for (const table of ["plugin_studio_projects", "plugin_studio_generations", "plugin_studio_artifacts"]) {
        assert.equal((scrubbed.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count, 0);
      }
    } finally {
      scrubbed.close();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
