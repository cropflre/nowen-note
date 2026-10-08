import assert from "node:assert/strict";
import test from "node:test";
import type { BackupInfo } from "../src/services/backup";
import { FullBackupJobBusyError, FullBackupJobStore } from "../src/services/full-backup-jobs";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitForState(
  jobs: FullBackupJobStore,
  id: string,
  expected: "running" | "ready" | "error",
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (jobs.get(id)?.state === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`任务 ${id} 未进入 ${expected} 状态`);
}

test("完整备份任务立即返回任务 ID，并复用尚未完成的任务", async () => {
  const result = deferred<BackupInfo>();
  const descriptions: string[] = [];
  const jobs = new FullBackupJobStore(async (description) => {
    descriptions.push(description || "");
    return result.promise;
  });

  const first = jobs.start("飞牛 NAS 手动备份");
  const duplicate = jobs.start("飞牛 NAS 手动备份");
  assert.equal(first.state, "queued");
  assert.equal(duplicate.id, first.id);

  await waitForState(jobs, first.id, "running");
  assert.deepEqual(descriptions, ["飞牛 NAS 手动备份"]);

  result.resolve({
    id: "backup-id",
    filename: "nowen-backup-full-test.zip",
    size: 123,
    type: "full",
    createdAt: "2026-08-14T00:00:00.000Z",
    noteCount: 1,
    notebookCount: 1,
    checksum: "a".repeat(64),
  });
  await waitForState(jobs, first.id, "ready");

  const completed = jobs.get(first.id);
  assert.equal(completed?.backup?.filename, "nowen-backup-full-test.zip");
  assert.equal(completed?.message, "完整备份已生成");
  assert.match(completed?.downloadToken || "", /^[a-f0-9]{64}$/);
  assert.equal(jobs.getByDownloadToken(completed?.downloadToken || "")?.id, first.id);
});

test("不同用途的完整备份不会误复用同一个运行中快照", () => {
  const result = deferred<BackupInfo>();
  const jobs = new FullBackupJobStore(() => result.promise);
  jobs.start("手动导出");
  assert.throws(() => jobs.start("恢复前安全备份"), FullBackupJobBusyError);
});

test("完整备份后台失败时保留可读错误", async () => {
  const jobs = new FullBackupJobStore(async () => {
    throw new Error("磁盘空间不足");
  });

  const job = jobs.start();
  await waitForState(jobs, job.id, "error");
  assert.equal(jobs.get(job.id)?.error, "磁盘空间不足");
  assert.equal(jobs.get(job.id)?.errorCode, "BACKUP_STORAGE_NO_SPACE");
  assert.equal(jobs.get(job.id)?.retryable, false);
});

test("unrecognized backend exception is redacted from backup job snapshot", async () => {
  const jobs = new FullBackupJobStore(async () => {
    throw new Error("password=secret /srv/private/nowen-note.db");
  });
  const job = jobs.start();
  await waitForState(jobs, job.id, "error");
  const snapshot = jobs.get(job.id);
  assert.equal(snapshot?.errorCode, "BACKUP_JOB_FAILED");
  assert.equal(snapshot?.retryable, false);
  assert.doesNotMatch(JSON.stringify(snapshot), /secret|private|note\\.db/);
});
