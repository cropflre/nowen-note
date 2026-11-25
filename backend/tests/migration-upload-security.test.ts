import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-migration-upload-security-"));
Object.assign(process.env, { NODE_ENV: "test", DB_PATH: path.join(directory, "test.db"), ELECTRON_USER_DATA: directory, JWT_SECRET: "isolated-migration-upload-security-fixture" });
let db: ReturnType<typeof import("../src/db/schema")["getDb"]>;
let closeDb: () => void;
let service: typeof import("../src/services/migrationService");
let uploads: typeof import("../src/services/migrationUploads");
const owner = { userId: "upload-owner" }, other = { userId: "upload-other" };
const hash = (bytes: Buffer | string) => crypto.createHash("sha256").update(bytes).digest("hex");
const scopes = ["export:import", "notes:read", "notes:write", "notebooks:write"];
const stream = (bytes: Buffer) => new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } });

test.before(async () => {
  await import("../src/runtime/knowledge-tree-migration-bootstrap");
  const schema = await import("../src/db/schema"); db = schema.getDb(); closeDb = schema.closeDb;
  service = await import("../src/services/migrationService"); uploads = await import("../src/services/migrationUploads");
  (await import("../src/lib/api-tokens")).initApiTokensTable(db);
  (await import("../src/services/audit")).initAuditTables();
  for (const actor of [owner, other]) db.prepare("INSERT INTO users(id,username,passwordHash) VALUES (?,?,'fixture')").run(actor.userId, actor.userId);
});
test.afterEach(async () => {
  db.prepare("UPDATE migration_jobs SET status='CANCELLED' WHERE status NOT IN ('COMPLETED','CANCELLED','FAILED','UNDONE','PARTIAL')").run();
  db.prepare("UPDATE migration_upload_sessions SET status='CANCELLED',leaseId=NULL,leaseExpiresAt=NULL WHERE status IN ('OPEN','FINALIZING')").run();
  await new Promise((resolve) => setTimeout(resolve, 20));
});
test.after(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); closeDb(); fs.rmSync(directory, { recursive: true, force: true }); });
function job(actor = owner) {
  return service.createMigration(actor, { operationId: crypto.randomUUID(), source: { platform: "files", exportId: crypto.randomUUID() }, name: "Security fixture" });
}
function create(actor: { userId: string; tokenId?: string }, jobId: string, bytes = Buffer.from("# Body"), extra: Record<string, unknown> = {}) {
  return uploads.createMigrationUploadSession(actor, jobId, { operationId: crypto.randomUUID(), filename: "note.md", size: bytes.length, sha256: hash(bytes), ...extra });
}
function token(grants: string[]) {
  const id = crypto.randomUUID();
  db.prepare("INSERT INTO api_tokens(id,userId,name,tokenHash,scopes,resourceMode) VALUES (?,?,'security',?,?,'unrestricted')").run(id, owner.userId, crypto.randomUUID(), JSON.stringify(grants));
  return { ...owner, tokenId: id };
}

test("upload session IDs cannot cross users for status, chunks, completion or cancellation (DCC-006)", async () => {
  const target = job(); const bytes = Buffer.from("# Private body"); const session = create(owner, target.id, bytes);
  assert.throws(() => uploads.getMigrationUploadSession(other, target.id, session.id), { code: "MIGRATION_NOT_FOUND" });
  await assert.rejects(uploads.putMigrationUploadChunk(other, target.id, session.id, 0, hash(bytes), stream(bytes)), { code: "MIGRATION_NOT_FOUND" });
  assert.throws(() => uploads.completeMigrationUploadSession(other, target.id, session.id), { code: "MIGRATION_NOT_FOUND" });
  assert.throws(() => uploads.cancelMigrationUploadSession(other, target.id, session.id), { code: "MIGRATION_NOT_FOUND" });
  assert.throws(() => uploads.getMigrationUploadSession({ userId: "" }, target.id, session.id), { code: "UNAUTHENTICATED" });
  assert.equal(uploads.getMigrationUploadSession(owner, target.id, session.id).offset, 0);
});

test("read-only callers and callers without asset scope cannot borrow a login-created upload", async () => {
  const target = job(), bytes = Buffer.from("%PDF-1.7\nasset");
  const session = create(owner, target.id, bytes, { filename: "asset.pdf", assetPath: "assets/asset.pdf" });
  const noAsset = token(scopes), readOnly = token(["export:import", "notes:read"]);
  await assert.rejects(uploads.putMigrationUploadChunk(noAsset, target.id, session.id, 0, hash(bytes), stream(bytes)), { code: "API_TOKEN_SCOPE_REQUIRED" });
  assert.equal(uploads.getMigrationUploadSession(readOnly, target.id, session.id).offset, 0);
  await assert.rejects(uploads.putMigrationUploadChunk(readOnly, target.id, session.id, 0, hash(bytes), stream(bytes)), { code: "API_TOKEN_SCOPE_REQUIRED" });
  assert.throws(() => uploads.completeMigrationUploadSession(noAsset, target.id, session.id), { code: "API_TOKEN_SCOPE_REQUIRED" });
  assert.equal(uploads.getMigrationUploadSession(owner, target.id, session.id).offset, 0);
});

test("bad hashes, offset jumps, changed operation payloads and unsafe destinations do not advance receipts", async () => {
  const target = job(), bytes = Buffer.from("# Stable bytes");
  const operationId = crypto.randomUUID();
  const input = { operationId, filename: "note.md", size: bytes.length, sha256: hash(bytes) };
  const session = uploads.createMigrationUploadSession(owner, target.id, input);
  assert.equal(uploads.createMigrationUploadSession(owner, target.id, input).id, session.id);
  assert.throws(() => uploads.createMigrationUploadSession(owner, target.id, { ...input, sha256: "a".repeat(64) }), { code: "MIGRATION_UPLOAD_OPERATION_CONFLICT" });
  await assert.rejects(uploads.putMigrationUploadChunk(owner, target.id, session.id, 1, hash(bytes), stream(bytes)), { code: "MIGRATION_UPLOAD_OFFSET" });
  await assert.rejects(uploads.putMigrationUploadChunk(owner, target.id, session.id, 0, "a".repeat(64), stream(bytes)), { code: "MIGRATION_CHUNK_HASH" });
  assert.equal(uploads.getMigrationUploadSession(owner, target.id, session.id).offset, 0);
  uploads.cancelMigrationUploadSession(owner, target.id, session.id);
  assert.throws(() => create(owner, target.id, bytes, { assetPath: "assets/../../outside.pdf" }));
  assert.throws(() => create(owner, target.id, bytes, { filename: "../outside.md" }));
  assert.equal(fs.existsSync(path.join(directory, "outside.pdf")), false);
});

test("an old cancelled asset session cannot unlink a newer upload using the same path", () => {
  const target = job(), first = Buffer.from("%PDF-1.7\nold"), second = Buffer.from("%PDF-1.7\nnew independent bytes");
  const old = create(owner, target.id, first, { filename: "shared.pdf", assetPath: "assets/shared.pdf" });
  // Simulate cancellation after publishing but before handing off the old object.
  db.prepare("UPDATE migration_upload_sessions SET status='CANCELLED',published=1 WHERE id=?").run(old.id);
  const next = create(owner, target.id, second, { filename: "shared.pdf", assetPath: "assets/shared.pdf" });
  db.prepare("UPDATE migration_upload_sessions SET status='FINALIZING',offset=size WHERE id=?").run(next.id);
  db.prepare("UPDATE migration_jobs SET status='UPLOADING' WHERE id=?").run(target.id);
  const destination = path.join(service.migrationJobDirectory(target.id), "assets/shared.pdf");
  fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.writeFileSync(destination, second);
  assert.equal(uploads.cancelMigrationUploadSession(owner, target.id, old.id).status, "CANCELLED");
  assert.deepEqual(fs.readFileSync(destination), second);
  assert.equal((db.prepare("SELECT status FROM migration_upload_sessions WHERE id=?").get(next.id) as { status: string }).status, "FINALIZING");
});

test("recovery isolates another user's revoked finalizer instead of blocking a healthy session", () => {
  const badJob = job(), goodJob = job(other), machine = token(scopes);
  const bad = create(machine, badJob.id), good = create(other, goodJob.id);
  db.prepare("UPDATE migration_upload_sessions SET status='FINALIZING',offset=size WHERE id=?").run(bad.id);
  db.prepare("UPDATE api_tokens SET revokedAt=datetime('now') WHERE id=?").run(machine.tokenId);
  assert.equal(uploads.getMigrationUploadSession(other, goodJob.id, good.id).status, "OPEN");
  assert.ok(["FAILED", "CANCELLED"].includes((db.prepare("SELECT status FROM migration_upload_sessions WHERE id=?").get(bad.id) as { status: string }).status));
});

test("crash before the published flag cannot strand an unhanded source in the private upload namespace", () => {
  const target = job(), body = Buffer.from("# Source"); const session = create(owner, target.id, body);
  const destination = path.join(service.migrationJobDirectory(target.id), `sources/${session.id}/upload.md`);
  fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.writeFileSync(destination, body);
  db.prepare("UPDATE migration_upload_sessions SET status='FINALIZING',offset=size,published=0 WHERE id=?").run(session.id);
  db.prepare("UPDATE migration_jobs SET status='UPLOADING' WHERE id=?").run(target.id);
  uploads.cancelMigrationUploadSession(owner, target.id, session.id);
  assert.equal(fs.existsSync(destination), false);
  assert.equal(db.prepare("SELECT 1 FROM migration_uploads WHERE id=?").get(session.id), undefined);
});
