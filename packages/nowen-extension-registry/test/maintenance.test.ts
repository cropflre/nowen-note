import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { collectArtifactGarbage } from "../src/maintenance/artifactGc.js";
import { createRegistryBackup, restoreRegistryBackup, verifyRegistryBackup } from "../src/maintenance/backup.js";
import { RegistryMaintenanceBusyError, RegistryOperationLeaseManager } from "../src/maintenance/operationLease.js";
import { openRegistry } from "../src/schema.js";
import { LocalArtifactStore } from "../src/storage/localArtifactStore.js";

function sha256(bytes: Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

async function withTempDirectory(action: (directory: string) => Promise<void>): Promise<void> {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "nowen-registry-maintenance-"));
  try { await action(directory); }
  finally { await fs.promises.rm(directory, { recursive: true, force: true }); }
}

function checkpointAndClose(db: DatabaseSync): void {
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
}

test("registry backup is a verified VACUUM snapshot and restore preserves the previous database", async () => {
  await withTempDirectory(async (directory) => {
    const sourcePath = path.join(directory, "source.db");
    const source = openRegistry(sourcePath);
    source.prepare("INSERT INTO developers(id,githubId,login,createdAt) VALUES (?,?,?,?)")
      .run("developer-backup", "github-backup", "backup-user", new Date().toISOString());
    checkpointAndClose(source);

    const created = await createRegistryBackup({ sourceDbPath: sourcePath, outputDirectory: path.join(directory, "backups") });
    const verified = await verifyRegistryBackup(created.databasePath, created.manifestPath);
    assert.equal(verified.ok, true, verified.errors.join("; "));
    assert.equal(verified.schemaVersion, 6);
    assert.match(verified.databaseSha256, /^[a-f0-9]{64}$/);

    const targetRoot = path.join(directory, "target");
    await fs.promises.mkdir(targetRoot, { recursive: true });
    const targetPath = path.join(targetRoot, "registry.db");
    const target = openRegistry(targetPath);
    target.prepare("INSERT INTO developers(id,githubId,login,createdAt) VALUES (?,?,?,?)")
      .run("developer-old", "github-old", "old-user", new Date().toISOString());
    checkpointAndClose(target);
    await fs.promises.rm(`${targetPath}-wal`, { force: true });
    await fs.promises.rm(`${targetPath}-shm`, { force: true });

    const plan = await restoreRegistryBackup({
      databasePath: created.databasePath,
      manifestPath: created.manifestPath,
      targetDbPath: targetPath,
      apply: false,
    });
    assert.equal(plan.applied, false);

    const restored = await restoreRegistryBackup({
      databasePath: created.databasePath,
      manifestPath: created.manifestPath,
      targetDbPath: targetPath,
      apply: true,
    });
    assert.equal(restored.applied, true);
    assert.ok(restored.previousDatabasePath);
    assert.equal(fs.existsSync(restored.previousDatabasePath!), true);

    const restoredDb = new DatabaseSync(targetPath, { readOnly: true });
    try {
      assert.ok(restoredDb.prepare("SELECT 1 FROM developers WHERE id='developer-backup'").get());
      assert.equal(restoredDb.prepare("SELECT 1 FROM developers WHERE id='developer-old'").get(), undefined);
    } finally { restoredDb.close(); }

    const manifest = JSON.parse(await fs.promises.readFile(created.manifestPath, "utf8"));
    manifest.databaseSha256 = "0".repeat(64);
    const tamperedManifest = path.join(directory, "tampered.manifest.json");
    await fs.promises.writeFile(tamperedManifest, JSON.stringify(manifest));
    const tampered = await verifyRegistryBackup(created.databasePath, tamperedManifest);
    assert.equal(tampered.ok, false);
    assert.ok(tampered.errors.some((error) => error.includes("SHA-256")));
  });
});

test("artifact GC is dry-run by default, preserves referenced artifacts, and removes only stale orphans", async () => {
  await withTempDirectory(async (directory) => {
    const db = openRegistry(path.join(directory, "registry.db"));
    const storeRoot = path.join(directory, "artifacts");
    const store = new LocalArtifactStore(storeRoot);
    try {
      const referencedBytes = Buffer.from("referenced-artifact");
      const referencedSha = sha256(referencedBytes);
      const referencedStage = await store.stage("referenced", referencedBytes);
      const referencedKey = await store.commit(referencedStage, referencedSha);
      const orphanBytes = Buffer.from("orphan-artifact");
      const orphanSha = sha256(orphanBytes);
      const orphanStage = await store.stage("orphan", orphanBytes);
      const orphanKey = await store.commit(orphanStage, orphanSha);
      const staleStage = await store.stage("stale", Buffer.from("stale-stage"));
      const old = new Date("2000-01-01T00:00:00.000Z");
      await fs.promises.utimes(path.join(storeRoot, ...staleStage.split("/")), old, old);

      db.prepare("INSERT INTO artifact_objects(sha256,storageKey,sizeBytes,state,createdAt,committedAt) VALUES (?,?,?,'committed',?,?)")
        .run(referencedSha, referencedKey, referencedBytes.length, old.toISOString(), old.toISOString());
      db.prepare("INSERT INTO artifact_objects(sha256,storageKey,sizeBytes,state,createdAt,committedAt) VALUES (?,?,?,'committed',?,?)")
        .run(orphanSha, orphanKey, orphanBytes.length, old.toISOString(), old.toISOString());
      db.prepare(`INSERT INTO extension_versions(extensionId,version,apiVersion,runtime,manifestJson,artifactKey,sha256,sizeBytes,publisherKeyId,signature,scanState,scanReportJson,publishedAt)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        "example.keep", "1.0.0", 2, "sandbox-js", "{}", referencedKey, referencedSha, referencedBytes.length,
        "key", "signature", "passed", "{}", old.toISOString(),
      );

      const dryRun = await collectArtifactGarbage({ db, artifactStore: store, graceMs: 0 });
      assert.equal(dryRun.dryRun, true);
      assert.ok(dryRun.candidates.some((candidate) => candidate.key === orphanKey));
      assert.ok(dryRun.candidates.some((candidate) => candidate.key === staleStage));
      assert.equal(dryRun.candidates.some((candidate) => candidate.key === referencedKey), false);
      assert.equal(await store.exists(orphanKey), true);

      const leases = new RegistryOperationLeaseManager(db);
      const publishLease = leases.acquirePublish("maintenance-test");
      await assert.rejects(
        collectArtifactGarbage({ db, artifactStore: store, graceMs: 0, apply: true }),
        RegistryMaintenanceBusyError,
      );
      leases.release(publishLease);

      const applied = await collectArtifactGarbage({ db, artifactStore: store, graceMs: 0, apply: true, maxDeletes: 100 });
      assert.equal(applied.dryRun, false);
      assert.ok(applied.deleted.some((candidate) => candidate.key === orphanKey));
      assert.ok(applied.deleted.some((candidate) => candidate.key === staleStage));
      assert.equal(await store.exists(referencedKey), true);
      assert.equal(await store.exists(orphanKey), false);
      assert.equal(db.prepare("SELECT 1 FROM artifact_objects WHERE storageKey=?").get(orphanKey), undefined);
      assert.ok(db.prepare("SELECT 1 FROM artifact_objects WHERE storageKey=?").get(referencedKey));
      const audit = db.prepare("SELECT action FROM audit_log WHERE action='maintenance.artifact_gc' ORDER BY id DESC LIMIT 1").get() as { action: string } | undefined;
      assert.equal(audit?.action, "maintenance.artifact_gc");
    } finally {
      db.close();
    }
  });
});
