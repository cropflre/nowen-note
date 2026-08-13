import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BackupManager, type BackupInfo } from "../src/services/backup";
import { normalizeAutoBackupType } from "../src/runtime/auto-full-backup";

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

test("db-only retention keeps 15, removes the 16th oldest, and never removes full backups", () => {
  const deleted: string[] = [];
  const manager: any = Object.create(BackupManager.prototype);
  const dbOnly = Array.from({ length: 16 }, (_, index) =>
    backup(
      `database-${index + 1}.bak`,
      "db-only",
      new Date(Date.UTC(2026, 6, 15, 3, 0, 0) - index * 60_000).toISOString(),
      index % 2 === 0 ? "自动备份（仅数据库）" : "管理员手动备份",
    ),
  );
  const full = Array.from({ length: 50 }, (_, index) =>
    backup(
      `full-${index + 1}.zip`,
      "full",
      new Date(Date.UTC(2026, 6, 14, 3, 0, 0) - index * 60_000).toISOString(),
      index % 2 === 0 ? "自动备份（全量）" : "管理员手动归档",
    ),
  );

  manager.autoBackupConfig = { keepCount: 15 };
  manager.listBackups = () => [...dbOnly.slice(0, 15), ...full];
  manager.deleteBackup = (filename: string) => {
    deleted.push(filename);
    return true;
  };

  manager.pruneDbOnly();
  assert.deepEqual(deleted, []);

  manager.listBackups = () => [...dbOnly, ...full];
  manager.pruneDbOnly();
  assert.deepEqual(deleted, ["database-16.bak"]);
});

test("disabled automatic backup still restores the persisted db-only keep count", () => {
  const manager: any = Object.create(BackupManager.prototype);
  manager.loadAutoConfigFromDb = () => ({
    enabled: false,
    intervalHours: 24,
    mode: "interval",
    dailyAt: "03:00",
    keepCount: 50,
    emailOnSuccess: false,
    emailTo: "",
  });

  const config = manager.readEffectiveAutoConfig();

  assert.equal(config.keepCount, 50);
  assert.equal(manager.autoBackupConfig.keepCount, 50);
});

test("stopping automatic scheduling persists a changed db-only keep count", () => {
  const manager: any = Object.create(BackupManager.prototype);
  let persisted: Record<string, unknown> | null = null;

  manager.autoBackupTimer = null;
  manager.autoBackupNextRunAt = null;
  manager.autoBackupIntervalHours = 24;
  manager.autoBackupConfig = {
    enabled: true,
    intervalHours: 24,
    mode: "interval",
    dailyAt: "03:00",
    keepCount: 15,
    emailOnSuccess: false,
    emailTo: "",
  };
  manager.persistAutoConfig = (config: Record<string, unknown>) => {
    persisted = { ...config };
  };

  manager.stopAutoBackup({
    persist: true,
    config: { intervalHours: 24, keepCount: 50 },
  });

  assert.equal(manager.autoBackupConfig.enabled, false);
  assert.equal(manager.autoBackupConfig.keepCount, 50);
  assert.equal((persisted as Record<string, unknown> | null)?.keepCount, 50);
});

test("creating a full backup still invokes the shared db-only retention", async () => {
  const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-full-retention-"));
  const manager: any = Object.create(BackupManager.prototype);
  let pruneCalls = 0;

  manager.backupDir = backupDir;
  manager.health = {
    lastSuccessAt: null,
    lastFailureAt: null,
    lastFailureReason: null,
    consecutiveFailures: 0,
  };
  manager.createFullBackup = async (backupPath: string) => {
    fs.writeFileSync(backupPath, "full-backup", "utf-8");
  };
  manager.persistHealth = () => {};
  manager.pruneDbOnly = () => {
    pruneCalls += 1;
  };
  manager.pruneNoteVersions = () => {};

  try {
    const info = await manager.createBackup({ type: "full", description: "管理员手动归档" });
    assert.equal(info.type, "full");
    assert.equal(pruneCalls, 1);
  } finally {
    fs.rmSync(backupDir, { recursive: true, force: true });
  }
});

test("automatic full backup never runs a separate full retention pass", async () => {
  const created: Array<{ type?: "full" | "db-only"; description?: string }> = [];
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
  manager.listBackups = () => assert.fail("runtime 不应自行实现 retention");
  manager.deleteBackup = () => assert.fail("runtime 不应删除任何 full 备份");
  manager.sendAutoBackupEmail = async () => {};

  await manager.runAutoTick();

  assert.deepEqual(created, [{ type: "full", description: "自动备份（全量）" }]);
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
  manager.sendAutoBackupEmail = async () => {};

  const first = manager.runAutoTick();
  await Promise.resolve();
  await manager.runAutoTick();
  assert.equal(createCalls, 1);

  resolveCreate(backup("auto-full.zip", "full", "2026-07-15T03:00:00.000Z", "自动备份（全量）"));
  await first;
});
