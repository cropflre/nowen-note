/** Opt-in: isolated loopback S3-compatible daemon; never uses the configured user database/storage. */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const endpoint = process.env.NOWEN_MIGRATION_S3_TEST_ENDPOINT;
const enabled = Boolean(endpoint);
const directory = enabled ? fs.mkdtempSync(path.join(os.tmpdir(), "nowen-migration-real-s3-")) : "";
const owner = { userId: "object-storage-fixture-owner" };
const source = { platform: "files", exportId: "s3-compatible-acceptance" };
const realFetch = globalThis.fetch;
type RequestRecord = { method: string; path: string; status: number; range: string | null };
const requests: RequestRecord[] = [];
const outcomes: Record<string, unknown> = {};
let onPut: ((record: RequestRecord) => void) | undefined;
let db: ReturnType<typeof import("../src/db/schema")["getDb"]>;
let closeDb: (() => void) | undefined;
let service: typeof import("../src/services/migrationService");
let storage: typeof import("../src/services/attachment-storage");

test.before(async () => {
  if (!enabled) return;
  const url = new URL(endpoint!);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname), "Only an explicit isolated loopback fixture is accepted");
  for (const key of ["BUCKET", "ACCESS_KEY_ID", "SECRET_ACCESS_KEY"]) assert.ok(process.env[`NOWEN_MIGRATION_S3_TEST_${key}`], `Missing fixture ${key}`);
  Object.assign(process.env, { NODE_ENV: "test", JWT_SECRET: "isolated-object-storage-acceptance-secret",
    DB_PATH: path.join(directory, "fixture.db"), ELECTRON_USER_DATA: directory,
    ATTACHMENT_STORAGE: "s3", S3_ENDPOINT: endpoint,
    S3_BUCKET: process.env.NOWEN_MIGRATION_S3_TEST_BUCKET,
    S3_ACCESS_KEY_ID: process.env.NOWEN_MIGRATION_S3_TEST_ACCESS_KEY_ID,
    S3_SECRET_ACCESS_KEY: process.env.NOWEN_MIGRATION_S3_TEST_SECRET_ACCESS_KEY,
    S3_REGION: "us-east-1", S3_PREFIX: `isolated-migration-${crypto.randomUUID()}` });
  await import("../src/runtime/knowledge-tree-migration-bootstrap");
  const schema = await import("../src/db/schema"); db = schema.getDb(); closeDb = schema.closeDb;
  service = await import("../src/services/migrationService"); storage = await import("../src/services/attachment-storage");
  (await import("../src/lib/api-tokens")).initApiTokensTable(db);
  (await import("../src/services/audit")).initAuditTables();
  db.prepare("INSERT INTO users(id,username,passwordHash) VALUES (?,?,'synthetic-fixture')").run(owner.userId, owner.userId);
  db.prepare("INSERT INTO user_sessions(id,userId,expiresAt) VALUES ('s3-human-session',?,?)").run(owner.userId, new Date(Date.now() + 3_600_000).toISOString());
  // Instrument completed real HTTP requests only. No response or storage operation is mocked.
  globalThis.fetch = async (input, init) => {
    const response = await realFetch(input, init);
    const url = new URL(String(input));
    const record = { method: init?.method || "GET", path: decodeURIComponent(url.pathname), status: response.status, range: new Headers(init?.headers).get("range") };
    requests.push(record);
    if (record.method === "PUT" && response.ok) onPut?.(record);
    return response;
  };
});

test.after(async () => {
  if (!enabled) return;
  onPut = undefined;
  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (storage) {
      const rows = db.prepare("SELECT path FROM attachments WHERE userId=?").all(owner.userId) as { path: string }[];
      for (const row of rows) await storage.deleteAttachmentObject(row.path);
      await service.cleanupMigrationObjects();
    }
    const reportPath = process.env.NOWEN_MIGRATION_S3_TEST_REPORT;
    if (reportPath) {
      fs.mkdirSync(path.dirname(reportPath), { recursive: true });
      fs.writeFileSync(reportPath, JSON.stringify({ date: new Date().toISOString(), runtime: process.version,
        server: process.env.NOWEN_MIGRATION_S3_TEST_SERVER || "external loopback S3-compatible fixture",
        cryptographicSignatureValidation: process.env.NOWEN_MIGRATION_S3_TEST_SKIP_SECRET_SIGNATURE === "1" ? "not-verified; daemon does not calculate SigV4 signatures" : "invalid-secret rejection tested",
        scope: "Production MigrationService and attachment storage over real HTTP; isolated synthetic data. Not cloud S3, MinIO or physical NAS acceptance.",
        outcomes, requests: { total: requests.length, methods: Object.fromEntries(["PUT", "HEAD", "GET", "DELETE"].map((method) => [method, requests.filter((entry) => entry.method === method).length])),
          rangeGets: requests.filter((entry) => entry.range !== null).length, rejectedAuthentication: requests.filter((entry) => [401, 403].includes(entry.status)).length },
        secretsRecorded: false }, null, 2) + "\n");
    }
  } finally {
    globalThis.fetch = realFetch;
    try { closeDb?.(); } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  }
});

async function waitFor(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 15_000;
  while (!await check()) { assert.ok(Date.now() < deadline, "isolated S3 acceptance timed out"); await new Promise((resolve) => setTimeout(resolve, 10)); }
}
async function prepare(label: string, actor: typeof owner & { tokenId?: string } = owner, size = 128 * 1024) {
  const job = service.createMigration(actor, { operationId: crypto.randomUUID(), source, name: label });
  const bytes = crypto.randomBytes(size); Buffer.from("%PDF-1.7\n").copy(bytes);
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex"), relative = "assets/fixture.pdf";
  const file = path.join(service.migrationJobDirectory(job.id), relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes);
  service.registerMigrationAsset(actor, job.id, relative, sha256, bytes.length);
  await service.stageMigrationItems(actor, job.id, [{ schemaVersion: 1, source: { ...source, sourceId: crypto.randomUUID() },
    title: label, contentFormat: "markdown", content: `[Synthetic PDF](assets/fixture.pdf) ${crypto.randomUUID()}`,
    attachments: [{ assetId: "pdf", path: relative, sha256 }] }]);
  return { job, bytes, sha256 };
}
async function approve(jobId: string) {
  const preview = await service.previewMigration(owner, jobId);
  service.approveMigration(owner, jobId, preview.previewDigest!, "s3-human-session");
}
async function terminal(jobId: string) {
  await waitFor(() => ["COMPLETED", "PARTIAL", "FAILED", "CANCELLED"].includes(service.getMigration(owner, jobId).status));
  return service.getMigration(owner, jobId);
}
function objectPath(record: RequestRecord) {
  const prefix = `/${process.env.S3_BUCKET}/${process.env.S3_PREFIX}/`;
  assert.ok(record.path.startsWith(prefix)); return record.path.slice(prefix.length);
}
function observe(jobId: string, action: () => void) {
  const written: string[] = [];
  onPut = (record) => {
    if (!record.path.includes(`/migrations/${jobId}/`)) return;
    written.push(objectPath(record)); onPut = undefined; action();
  };
  return written;
}
async function compensated(paths: string[]) {
  assert.equal(paths.length, 1, "the failure is injected after one confirmed object PUT");
  await waitFor(async () => !(await storage.checkAttachmentObjectExists(paths[0])).exists);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM attachments WHERE path=?").get(paths[0]) as { n: number }).n, 0);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM migration_objects WHERE path=?").get(paths[0]) as { n: number }).n, 0);
}

test("real S3-compatible HTTP preserves imported attachment bytes, hash, references and ranged verification", { skip: !enabled }, async () => {
  const { job, bytes, sha256 } = await prepare("S3 attachment import", owner, 8 * 1024 * 1024);
  assert.equal(storage.getAttachmentStorageInfo().driver, "s3");
  await approve(job.id); const completed = await terminal(job.id);
  assert.equal(completed.status, "COMPLETED"); assert.equal(completed.counts.imported, 1);
  const item = service.migrationReport(owner, job.id).items[0];
  const asset = db.prepare("SELECT path,hash,size FROM attachments WHERE noteId=?").get(item.targetNoteId!) as { path: string; hash: string; size: number };
  assert.equal(asset.hash, sha256); assert.equal(asset.size, bytes.length);
  assert.equal((await storage.checkAttachmentObjectExists(asset.path)).exists, true);
  const readBack = await storage.readAttachmentObject(asset.path); assert.ok(readBack); assert.deepEqual(readBack, bytes);
  assert.equal(crypto.createHash("sha256").update(readBack).digest("hex"), sha256);
  assert.equal(fs.existsSync(storage.getLocalAttachmentPath(asset.path)), false, "the object cannot pass using a local cached file");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM attachment_references WHERE noteId=?").get(item.targetNoteId!) as { n: number }).n, 1);
  assert.ok(requests.filter((entry) => entry.range && entry.path.endsWith(asset.path)).length >= 8);
  outcomes.import = { notes: 1, assetBytes: bytes.length, hashVerified: true, localCacheAbsent: true, referenceCount: 1 };
});

test("a database failure compensates an object after a real successful S3 PUT", { skip: !enabled }, async () => {
  const { job } = await prepare("S3 rollback fixture");
  db.exec("CREATE TRIGGER s3_fixture_failure BEFORE INSERT ON notes WHEN NEW.title='S3 rollback fixture' BEGIN SELECT RAISE(ABORT,'isolated rollback'); END");
  const written = observe(job.id, () => {});
  try { await approve(job.id); const failed = await terminal(job.id); assert.equal(failed.status, "FAILED"); assert.equal(failed.counts.imported, 0); await compensated(written); }
  finally { db.exec("DROP TRIGGER s3_fixture_failure"); onPut = undefined; }
  outcomes.transactionFailure = { imported: 0, confirmedPutCompensated: true };
});

test("cancelling after a real S3 PUT prevents the note commit and deletes only the uncommitted object", { skip: !enabled }, async () => {
  const { job } = await prepare("S3 cancellation fixture");
  const written = observe(job.id, () => { service.controlMigration(owner, job.id, "cancel"); });
  await approve(job.id); const cancelled = await terminal(job.id);
  assert.equal(cancelled.status, "CANCELLED"); await compensated(written); assert.equal(cancelled.counts.imported, 0);
  outcomes.cancellation = { imported: 0, confirmedPutCompensated: true };
});

test("revoking the creator token after a real S3 PUT blocks commit and preserves committed objects", { skip: !enabled }, async () => {
  const tokenId = crypto.randomUUID();
  db.prepare("INSERT INTO api_tokens(id,userId,name,tokenHash,scopes) VALUES (?,?,'isolated-s3-token',?,?)")
    .run(tokenId, owner.userId, crypto.randomUUID(), JSON.stringify(["export:import", "notes:read", "notes:write", "notebooks:write", "attachments:write"]));
  const { job } = await prepare("S3 revoked token fixture", { ...owner, tokenId });
  const written = observe(job.id, () => { db.prepare("UPDATE api_tokens SET revokedAt=datetime('now') WHERE id=?").run(tokenId); });
  await approve(job.id); const failed = await terminal(job.id);
  assert.equal(failed.status, "FAILED"); assert.equal(failed.counts.imported, 0); await compensated(written);
  assert.equal(service.migrationReport(owner, job.id).items[0].error, "MIGRATION_TOKEN_REVOKED");
  const committed = db.prepare("SELECT path,hash FROM attachments WHERE userId=?").all(owner.userId) as { path: string; hash: string }[];
  assert.equal(committed.length, 1); assert.equal((await storage.checkAttachmentObjectExists(committed[0].path)).exists, true);
  const retained = await storage.readAttachmentObject(committed[0].path); assert.ok(retained);
  assert.equal(crypto.createHash("sha256").update(retained).digest("hex"), committed[0].hash);
  outcomes.tokenRevocation = { imported: 0, confirmedPutCompensated: true, priorCommittedObjectPreserved: true };
});

test("an unknown object-storage access key fails preflight without importing notes", { skip: !enabled }, async () => {
  const { job } = await prepare("S3 unknown key fixture");
  const saved = process.env.S3_ACCESS_KEY_ID; process.env.S3_ACCESS_KEY_ID = "unknown-isolated-access-key";
  try { await assert.rejects(service.previewMigration(owner, job.id), { code: "MIGRATION_STORAGE_UNAVAILABLE" }); }
  finally { process.env.S3_ACCESS_KEY_ID = saved; }
  assert.ok(requests.some((entry) => [401, 403].includes(entry.status)), "daemon must actually reject unknown credentials");
  assert.equal(service.getMigration(owner, job.id).counts.imported, 0); service.controlMigration(owner, job.id, "cancel");
  outcomes.unknownAccessKey = { preflightRejected: true, imported: 0 };
});

test("the S3-compatible service rejects an invalid cryptographic signing secret", { skip: !enabled || process.env.NOWEN_MIGRATION_S3_TEST_SKIP_SECRET_SIGNATURE === "1" }, async () => {
  const { job } = await prepare("S3 bad signature fixture");
  const saved = process.env.S3_SECRET_ACCESS_KEY; process.env.S3_SECRET_ACCESS_KEY = "wrong-isolated-signing-secret";
  try { await assert.rejects(service.previewMigration(owner, job.id), { code: "MIGRATION_STORAGE_UNAVAILABLE" }); }
  finally { process.env.S3_SECRET_ACCESS_KEY = saved; }
  assert.equal(service.getMigration(owner, job.id).counts.imported, 0); service.controlMigration(owner, job.id, "cancel");
  outcomes.invalidSecret = { preflightRejected: true, imported: 0 };
});
