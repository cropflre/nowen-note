import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

// The actual v1.5.0 release, rather than a current database with its ledger edited.
const baseline = "19a801cba6bf5b4fc7752df09d553c2a8f3c7900";
const run = promisify(execFile);
const backend = fileURLToPath(new URL("../", import.meta.url));
const worker = fileURLToPath(new URL("./encrypted-notes-upgrade-worker.ts", import.meta.url));
const directory = path.join(path.dirname(process.env.DB_PATH!), "release-upgrade");

test("v1.5.0 copy upgrades, saves and syncs, and its pre-upgrade full backup restores on both versions", async (context) => {
  fs.mkdirSync(directory, { recursive: true });
  const oldSource = path.join(directory, "old-source");
  fs.mkdirSync(oldSource);
  const archive = path.join(directory, "v1.5.0.tar");
  await run("git", ["archive", "--format=tar", "--output", archive, baseline, "backend/src", "backend/package.json"], { cwd: path.resolve(backend, "..") });
  await run("tar", ["-xf", archive, "-C", oldSource]);
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
