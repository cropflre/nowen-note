import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

// The actual v1.5.0 release, rather than a current database with its ledger edited.
const baseline = "61a9427acdeb9bc565fe6f5be26ef4de7f66e4da";
const run = promisify(execFile);
const backend = fileURLToPath(new URL("../", import.meta.url));
const worker = fileURLToPath(new URL("./encrypted-notes-upgrade-worker.ts", import.meta.url));
// 该文件会连跑多个旧版本进程，必须自己准备隔离目录；依赖外部注入的 DB_PATH
// 会让单文件运行和串行 runner 直接抛 ERR_INVALID_ARG_TYPE。
const dbPath = process.env.DB_PATH
  ?? path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nowen-encrypted-upgrade-")), "test.db");
const directory = path.join(path.dirname(dbPath), "release-upgrade");

test("v1.5.0 copy upgrades, saves and syncs, and its pre-upgrade full backup restores on both versions", async (context) => {
  fs.mkdirSync(directory, { recursive: true });
  const oldSource = path.join(directory, "old-source");
  fs.mkdirSync(oldSource);
  const archive = path.join(directory, "v1.5.0.tar");
  await run("git", ["archive", "--format=tar", "--output", archive, baseline, "backend/src", "backend/package.json"], { cwd: path.resolve(backend, "..") });
  // GNU tar 会把 "C:\..." 里的盘符当成远端主机，这里用相对路径 + cwd 保持跨平台。
  await run("tar", ["-xf", "v1.5.0.tar", "-C", "old-source"], { cwd: directory });
  fs.symlinkSync(path.join(backend, "node_modules"), path.join(oldSource, "backend", "node_modules"), process.platform === "win32" ? "junction" : "dir");
  const oldBackend = path.join(oldSource, "backend");
  const source = path.join(directory, "before-upgrade");
  const backups = path.join(directory, "backups");
  async function execute(sourceRoot: string, installation: string, mode: string, filename = "") {
    fs.mkdirSync(installation, { recursive: true });
    const report = path.join(installation, mode + ".json");
    await run(process.execPath, ["--import", "tsx", worker, sourceRoot, mode, report, filename], {
      cwd: backend, timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, NODE_ENV: "test", DB_PATH: path.join(installation, "test.db"), ELECTRON_USER_DATA: installation, BACKUP_DIR: backups },
    });
    return JSON.parse(fs.readFileSync(report, "utf8"));
  }
  const seeded = await execute(oldBackend, source, "seed");
  const upgraded = path.join(directory, "upgraded-copy");
  fs.cpSync(source, upgraded, { recursive: true });
  const result = await execute(backend, upgraded, "upgrade");
  context.diagnostic(`v1.5.0 schema ${seeded.schemaVersion} -> candidate schema ${result.schemaVersion}`);
  assert.ok(result.schemaVersion > seeded.schemaVersion);
  assert.deepEqual(result.snapshot, seeded.snapshot, "startup must preserve bodies, histories, attachments and pending sync payloads");
  const reopened = await execute(backend, upgraded, "inspect");
  assert.equal(reopened.schemaVersion, result.schemaVersion);
  assert.deepEqual(reopened.snapshot, result.afterWrites, "a second startup must be idempotent");
  await execute(oldBackend, upgraded, "reject-newer");

  for (const [name, sourceRoot] of [["restored-current", backend], ["rollback-old", oldBackend]]) {
    const restored = await execute(sourceRoot, path.join(directory, name!), "restore", seeded.backup);
    assert.deepEqual(restored.snapshot, seeded.snapshot, name);
    assert.equal(restored.schemaVersion, name === "rollback-old" ? seeded.schemaVersion : result.schemaVersion);
  }
  assert.deepEqual((await execute(oldBackend, source, "inspect")).snapshot, seeded.snapshot, "the pre-upgrade source must remain unchanged");
});
