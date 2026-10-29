import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

test("DCC-002: a killed migration worker resumes after reopening without duplicate notes or lost Outbox", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-migration-restart-"));
  Object.assign(process.env, { NODE_ENV: "test", DB_PATH: path.join(directory, "test.db"), ELECTRON_USER_DATA: directory,
    NOWEN_LOCAL_FIRST_SYNC_V2: "1", JWT_SECRET: "migration-restart-fixture-secret" });
  await import("../src/runtime/knowledge-tree-migration-bootstrap");
  const schema = await import("../src/db/schema");
  const service = await import("../src/services/migrationService");
  let db = schema.getDb();
  try {
    (await import("../src/services/audit")).initAuditTables();
    db.prepare("INSERT INTO users(id,username,passwordHash) VALUES ('restart-user','restart-user','fixture')").run();
    db.prepare("INSERT INTO user_sessions(id,userId,expiresAt) VALUES ('restart-session','restart-user',?)").run(new Date(Date.now() + 3_600_000).toISOString());
    const sync = await import("../src/sync/index");
    const profile = sync.createProfile(db, { name: "Isolated NAS", serverUrl: "http://restart.invalid" });
    sync.switchActiveProfile(db, profile.id);
    sync.ensureDevice(db, { profileId: profile.id, platform: "darwin" });
    sync.markBootstrapReady(db, profile.id, 0);
    (await import("../src/sync/knowledgeTreeReadiness")).markKnowledgeTreeSyncReady(db, profile.id);
    const actor = { userId: "restart-user" };
    const source = { platform: "markdown", exportId: "restart-export" };
    const job = service.createMigration(actor, { operationId: crypto.randomUUID(), source });
    for (let start = 0; start < 100; start += 50) await service.stageMigrationItems(actor, job.id, Array.from({ length: 50 }, (_, offset) => ({
      schemaVersion: 1, source: { ...source, sourceId: `restart-${start + offset}` }, title: `Restart ${start + offset}`,
      contentFormat: "markdown", content: `# Restart ${start + offset}\nPersistent body ${start + offset}`,
    })));
    await service.previewMigration(actor, job.id);
    // Persist the same approved receipt as the HTTP operation, before dispatching to a different process.
    db.prepare("UPDATE migration_jobs SET status='APPROVED',approvedBySession='restart-session',previewExpiresAt=NULL WHERE id=?").run(job.id);
    schema.closeDb();
    const runChild = (mode: string) => new Promise<void>((resolve, reject) => {
      const environment = { ...process.env }; delete environment.NODE_TEST_CONTEXT;
      const child = spawn(process.execPath, ["--import", "tsx", path.resolve(__dirname, "fixtures/migration-worker-process.ts"), job.id, mode], { env: environment, stdio: ["ignore", "pipe", "pipe"] });
      let output = ""; child.stdout.on("data", (data) => { output += data; }); child.stderr.on("data", (data) => { output += data; });
      child.once("error", reject); child.once("close", (code) => code === 0 ? resolve() : reject(new Error(output)));
    });
    await runChild("interrupt");
    db = schema.getDb();
    const first = db.prepare("SELECT targetNoteId FROM migration_items WHERE jobId=? AND status='IMPORTED' ORDER BY id").all(job.id) as { targetNoteId: string }[];
    assert.ok(first.length >= 5 && first.length < 100);
    assert.ok(sync.countPendingMutations(db, profile.id) > 0);
    schema.closeDb();
    await runChild("complete");
    db = schema.getDb();
    const completed = service.getMigration(actor, job.id);
    assert.equal(completed.status, "COMPLETED"); assert.equal(completed.counts.imported, 100);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM notes WHERE userId='restart-user'").get() as { n: number }).n, 100);
    for (const item of first) assert.ok(db.prepare("SELECT 1 FROM notes WHERE id=? AND content LIKE '%Persistent body%'").get(item.targetNoteId));
    assert.ok(sync.countPendingMutations(db, profile.id) > 100, "reopening cannot discard unacknowledged imported writes");
  } finally { schema.closeDb(); fs.rmSync(directory, { recursive: true, force: true }); }
});
