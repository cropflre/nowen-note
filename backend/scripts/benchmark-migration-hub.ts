/** Isolated synthetic acceptance. Run with node --max-old-space-size=256 --import tsx scripts/benchmark-migration-hub.ts [count] [assetMiB]. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import archiver from "archiver";

async function main() {
  const count = Number(process.argv[2] || 100);
  const assetMiB = Number(process.argv[3] || 0);
  assert.ok(Number.isInteger(count) && count >= 1 && count <= 10_000);
  assert.ok(Number.isInteger(assetMiB) && assetMiB >= 0 && assetMiB <= 256);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-migration-bench-"));
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = "migration-benchmark-isolated-secret-2026";
  process.env.DB_PATH = path.join(directory, "bench.db");
  process.env.ELECTRON_USER_DATA = directory;
  const started = performance.now();
  let peakRss = 0;
  let peakHeap = 0;
  const sample = () => { const memory = process.memoryUsage(); peakRss = Math.max(peakRss, memory.rss); peakHeap = Math.max(peakHeap, memory.heapUsed); };
  const monitor = setInterval(sample, 20);
  let closeDb: (() => void) | undefined;
  try {
    const schema = await import("../src/db/schema");
    const service = await import("../src/services/migrationService");
    closeDb = schema.closeDb;
    const db = schema.getDb();
    (await import("../src/services/audit")).initAuditTables();
    db.prepare("INSERT INTO users(id,username,passwordHash) VALUES ('benchmark','benchmark','isolated-fixture')").run();
    db.prepare("INSERT INTO user_sessions(id,userId,expiresAt) VALUES ('benchmark-session','benchmark',?)").run(new Date(Date.now() + 3_600_000).toISOString());
    const actor = { userId: "benchmark" };
    const job = service.createMigration(actor, { operationId: crypto.randomUUID(), name: "Synthetic migration", source: { platform: "files", exportId: "synthetic-acceptance" } });
    const jobDir = service.migrationJobDirectory(job.id);
    const uploadDir = path.join(jobDir, "sources", "benchmark");
    fs.mkdirSync(uploadDir, { recursive: true });
    const zipPath = path.join(uploadDir, "source.zip");
    const archive = archiver("zip", { zlib: { level: 1 } });
    const output = pipeline(archive, fs.createWriteStream(zipPath));
    const assetCount = Math.ceil(assetMiB / 4);
    for (let index = 0; index < count; index++) {
      const attachment = index < assetCount ? `\n[PDF](../assets/${index}.pdf)` : "";
      archive.append(`# Note ${index}\nSynthetic isolated data ${index}.${attachment}\n`, { name: `notes/${index}.md` });
    }
    for (let index = 0; index < assetCount; index++) {
      const size = Math.min(4, assetMiB - index * 4) * 1024 * 1024;
      async function* chunks() {
        yield Buffer.from("%PDF-1.7\n");
        for (let remaining = size - 9; remaining > 0;) { const chunk = crypto.randomBytes(Math.min(64 * 1024, remaining)); remaining -= chunk.length; yield chunk; }
      }
      archive.append(Readable.from(chunks()), { name: `assets/${index}.pdf` });
    }
    await archive.finalize(); await output;
    const zipBytes = fs.statSync(zipPath).size;
    const waitFor = async (allowed: string[]) => {
      const deadline = Date.now() + 20 * 60_000;
      while (true) {
        const snapshot = service.getMigration(actor, job.id);
        if (allowed.includes(snapshot.status)) return snapshot;
        assert.ok(!["FAILED", "PARTIAL", "CANCELLED"].includes(snapshot.status), JSON.stringify(snapshot));
        assert.ok(Date.now() < deadline, "benchmark timeout");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    service.beginMigrationUpload(actor, job.id);
    service.finishMigrationUpload(actor, job.id, { filename: "source.zip", path: "sources/benchmark/source.zip" });
    await waitFor(["CREATED"]);
    const preview = await service.previewMigration(actor, job.id);
    assert.equal(preview.counts.total, count);
    const previewAt = performance.now();
    service.approveMigration(actor, job.id, preview.previewDigest!, "benchmark-session");
    const completed = await waitFor(["COMPLETED"]);
    sample();
    assert.equal(completed.counts.imported, count);
    const actualNotes = (db.prepare("SELECT COUNT(*) AS n FROM notes WHERE userId='benchmark' AND isTrashed=0").get() as { n: number }).n;
    const actualAssets = (db.prepare("SELECT COUNT(*) AS n FROM attachments WHERE userId='benchmark'").get() as { n: number }).n;
    assert.equal(actualNotes, count); assert.equal(actualAssets, Math.min(count, assetCount));
    console.log(JSON.stringify({ platform: `${process.platform}/${process.arch}`, os: os.release(), node: process.version,
      cpus: os.cpus().length, heapLimitMiB: 256, count, assetMiB, zipBytes, peakRssMiB: +(peakRss / 1048576).toFixed(1), peakHeapMiB: +(peakHeap / 1048576).toFixed(1),
      previewSeconds: +((previewAt - started) / 1000).toFixed(2), totalSeconds: +((performance.now() - started) / 1000).toFixed(2),
      actualNotes, actualAssets, status: completed.status, failed: completed.counts.failed, warnings: completed.warnings }, null, 2));
  } finally {
    clearInterval(monitor); closeDb?.(); fs.rmSync(directory, { recursive: true, force: true });
  }
}
main().then(() => process.exit(0), (error) => { console.error(error); process.exit(1); });
