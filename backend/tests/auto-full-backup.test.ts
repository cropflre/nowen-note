import assert from "node:assert/strict";
import test from "node:test";
import { BackupManager, type BackupInfo } from "../src/services/backup";
import {
  automaticBackupsToPrune,
  normalizeAutoBackupType,
} from "../src/runtime/auto-full-backup";

function backup(
  filename: string,
  type: "full" | "db-only",
  createdAt: string,
  description?: string,
): BackupInfo {
  return {
    id: filename,
    filename,
    size: 1,
    type,
    createdAt,
    noteCount: 1,
    notebookCount: 1,
    checksum: "0".repeat(64),
    description,
  };
}

test("automatic backups default to full while retaining an explicit db-only opt-out", () => {
  assert.equal(normalizeAutoBackupType(undefined), "full");
  assert.equal(normalizeAutoBackupType("full"), "full");
  assert.equal(normalizeAutoBackupType("db-only"), "db-only");
  assert.equal(normalizeAutoBackupType("invalid"), "full");
});

test("retention only removes old automatic backups of the selected type", () => {
  const removals = automaticBackupsToPrune(
    [
      backup("auto-full-new.zip", "full", "2026-07-15T03:00:00.000Z", "自动备份（全量）"),
      backup("manual-full.zip", "full", "2026-07-15T02:30:00.000Z", "管理员手动归档"),
      backup("auto-db.bak", "db-only", "2026-07-15T02:00:00.000Z", "自动备份（仅数据库）"),
      backup("auto-full-mid.zip", "full", "2026-07-15T01:00:00.000Z", "自动备份（全量）"),
      backup("auto-full-old.zip", "full", "2026-07-14T01:00:00.000Z", "自动备份（全量）"),
    ],
    "full",
    2,
  );

  assert.deepEqual(removals, ["auto-full-old.zip"]);
});

test("automatic tick creates an attachment-safe full backup and prunes only old automatic full archives", async () => {
  const created: Array<{ type?: "full" | "db-only"; description?: string }> = [];
  const deleted: string[] = [];
  const manager: any = Object.create(BackupManager.prototype);

  manager.autoBackupConfig = {
    enabled: true,
    intervalHours: 24,
    keepCount: 2,
    backupType: "full",
    emailOnSuccess: false,
    emailTo: "",
  };
  manager.createBackup = async (options: { type?: "full" | "db-only"; description?: string } = {}) => {
    created.push(options);
    return backup("auto-full-new.zip", "full", "2026-07-15T03:00:00.000Z", options.description);
  };
  manager.listBackups = () => [
    backup("auto-full-new.zip", "full", "2026-07-15T03:00:00.000Z", "自动备份（全量）"),
    backup("manual-full.zip", "full", "2026-07-15T02:00:00.000Z", "手动备份"),
    backup("auto-full-mid.zip", "full", "2026-07-15T01:00:00.000Z", "自动备份（全量）"),
    backup("auto-full-old.zip", "full", "2026-07-14T01:00:00.000Z", "自动备份（全量）"),
    backup("auto-db-old.bak", "db-only", "2026-07-13T01:00:00.000Z", "自动备份（仅数据库）"),
  ];
  manager.deleteBackup = (filename: string) => {
    deleted.push(filename);
    return true;
  };
  manager.sendAutoBackupEmail = async () => {};

  await manager.runAutoTick();

  assert.deepEqual(created, [{ type: "full", description: "自动备份（全量）" }]);
  assert.deepEqual(deleted, ["auto-full-old.zip"]);
});

test("automatic tick skips overlap while a full archive is still being generated", async () => {
  let resolveCreate!: (value: BackupInfo) => void;
  let createCalls = 0;
  const manager: any = Object.create(BackupManager.prototype);
  manager.autoBackupConfig = { enabled: true, keepCount: 2, backupType: "full" };
  manager.createBackup = () => {
    createCalls += 1;
    return new Promise<BackupInfo>((resolve) => { resolveCreate = resolve; });
  };
  manager.listBackups = () => [];
  manager.deleteBackup = () => true;
  manager.sendAutoBackupEmail = async () => {};

  const first = manager.runAutoTick();
  await Promise.resolve();
  await manager.runAutoTick();
  assert.equal(createCalls, 1);

  resolveCreate(backup("auto-full.zip", "full", "2026-07-15T03:00:00.000Z", "自动备份（全量）"));
  await first;
});
