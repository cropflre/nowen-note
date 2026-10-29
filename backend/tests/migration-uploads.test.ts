import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Hono } from "hono";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-migration-uploads-"));
Object.assign(process.env, { NODE_ENV: "test", DB_PATH: path.join(directory, "uploads.db"), ELECTRON_USER_DATA: directory, JWT_SECRET: "upload-fixture-isolated-secret" });
let schema: typeof import("../src/db/schema");
let service: typeof import("../src/services/migrationService");
let uploads: typeof import("../src/services/migrationUploads");
let db: ReturnType<typeof import("../src/db/schema")["getDb"]>;
let app: Hono;
const owner = { userId: "upload-owner" };
const hash = (value: Buffer | string) => crypto.createHash("sha256").update(value).digest("hex");
const chunkBytes = 4 * 1024 * 1024;

test.before(async () => {
  await import("../src/runtime/knowledge-tree-migration-bootstrap");
  schema = await import("../src/db/schema"); db = schema.getDb();
  service = await import("../src/services/migrationService"); uploads = await import("../src/services/migrationUploads");
  (await import("../src/lib/api-tokens")).initApiTokensTable(db);
  for (const id of [owner.userId, "upload-other"]) db.prepare("INSERT INTO users(id,username,passwordHash) VALUES (?,?,'fixture')").run(id, id);
  app = new Hono();
  app.route("/migrations", (await import("../src/routes/migration-uploads")).default);
  app.route("/migrations", (await import("../src/routes/migrations")).default);
});
test.afterEach(() => {
  for (const job of db.prepare("SELECT id FROM migration_jobs WHERE status IN ('CREATED','UPLOADING','SCANNING','NORMALIZING')").all() as { id: string }[]) service.controlMigration(owner, job.id, "cancel");
  uploads.recoverMigrationUploadSessions();
});
test.after(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); schema.closeDb(); fs.rmSync(directory, { recursive: true, force: true }); });
function job(actor = owner) { return service.createMigration(actor, { operationId: crypto.randomUUID(), source: { platform: "files", exportId: "chunk-fixture" } }); }
async function request(url: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) {
  const response = await app.request(`/migrations${url}`, { method, headers: { "X-User-Id": owner.userId, ...(body && !Buffer.isBuffer(body) ? { "Content-Type": "application/json" } : {}), ...headers },
    ...(body === undefined ? {} : { body: Buffer.isBuffer(body) ? body : JSON.stringify(body) }) });
  return { status: response.status, data: await response.json() as any };
}
async function create(id: string, data: Buffer, extra: Record<string, unknown> = {}) {
  const input = { operationId: crypto.randomUUID(), filename: "file.pdf", assetPath: "assets/file.pdf", size: data.length, sha256: hash(data), ...extra };
  const result = await request(`/${id}/upload-sessions`, "POST", input);
  assert.equal(result.status, 201, JSON.stringify(result.data)); return { ...result.data, input };
}
function put(id: string, uploadId: string, offset: number, data: Buffer, sha256 = hash(data), headers: Record<string, string> = {}) {
  return request(`/${id}/upload-sessions/${uploadId}/chunks?offset=${offset}`, "PUT", data, { "X-Chunk-SHA256": sha256, ...headers });
}
async function wait(id: string, uploadId: string, statuses = ["COMPLETE", "FAILED"]) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await request(`/${id}/upload-sessions/${uploadId}`);
    if (statuses.includes(result.data.status)) return result.data;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("upload finalizer timeout");
}
function pdf(size = chunkBytes + 17) { const value = crypto.randomBytes(size); Buffer.from("%PDF-1.7\n").copy(value); return value; }

test("upload sessions are scoped, bounded and idempotent by operation/file fingerprint", async () => {
  const current = job(), data = pdf(32); const session = await create(current.id, data);
  assert.equal(session.chunkBytes, chunkBytes); assert.equal(session.offset, 0);
  assert.equal((await request(`/${current.id}/upload-sessions`, "POST", session.input)).data.id, session.id);
  const changed = await request(`/${current.id}/upload-sessions`, "POST", { ...session.input, filename: "different.pdf" });
  assert.equal(changed.status, 409); assert.equal(changed.data.code, "MIGRATION_UPLOAD_OPERATION_CONFLICT");
  assert.equal((await request(`/${current.id}/upload-sessions`, "POST", { ...session.input, operationId: crypto.randomUUID() })).status, 409);
  assert.equal((await request(`/${current.id}/upload-sessions/${session.id}`, "GET", undefined, { "X-User-Id": "upload-other" })).status, 404);
  assert.equal((await put(current.id, session.id, 0, data, hash(data), { "X-User-Id": "upload-other" })).status, 404);
  assert.equal((await request(`/${current.id}/upload-sessions`, "POST", { ...session.input, operationId: crypto.randomUUID(), assetPath: "../outside.pdf" })).status, 400);
  assert.ok(!JSON.stringify(session).includes(directory));
});

test("chunk receipts reject gaps, corruption and tiny chunks; exact retries cannot duplicate bytes", async () => {
  const current = job(), data = pdf(); const session = await create(current.id, data);
  const first = data.subarray(0, chunkBytes), last = data.subarray(chunkBytes);
  assert.equal((await put(current.id, session.id, 1, first)).status, 409);
  assert.equal((await put(current.id, session.id, 0, first.subarray(0, 10))).status, 409);
  assert.equal((await put(current.id, session.id, 0, first, "0".repeat(64))).status, 409);
  assert.equal((await put(current.id, session.id, 0, first)).data.offset, chunkBytes);
  assert.equal((await put(current.id, session.id, 0, first)).data.offset, chunkBytes);
  assert.equal((await put(current.id, session.id, 0, Buffer.alloc(chunkBytes), hash(first))).status, 409);
  assert.equal((await put(current.id, session.id, chunkBytes, last)).data.offset, data.length);
  const started = await request(`/${current.id}/upload-sessions/${session.id}/complete`, "POST", {});
  assert.equal(started.status, 202); assert.equal(started.data.status, "UPLOADING");
  assert.equal((await wait(current.id, session.id)).status, "COMPLETE");
  const asset = db.prepare("SELECT * FROM migration_assets WHERE jobId=?").get(current.id) as { path: string; sha256: string; size: number };
  assert.equal(asset.sha256, hash(data)); assert.equal(asset.size, data.length);
  assert.deepEqual(fs.readFileSync(path.join(service.migrationJobDirectory(current.id), asset.path)), data);
  assert.equal((await request(`/${current.id}/upload-sessions/${session.id}/complete`, "POST", {})).status, 202);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM migration_assets WHERE jobId=?").get(current.id) as { n: number }).n, 1);
});

test("DCC-003: acknowledged chunks survive database reopening and a pre-receipt file is reconciled", async () => {
  const current = job(), data = pdf(); const session = await create(current.id, data);
  const first = data.subarray(0, chunkBytes);
  const part = path.join(service.migrationJobDirectory(current.id), "sessions", session.id, "chunks", "0.part");
  fs.writeFileSync(part, first); // Crash window: durable file exists, transaction receipt was not committed.
  assert.equal((await put(current.id, session.id, 0, first)).data.offset, chunkBytes);
  schema.closeDb(); db = schema.getDb();
  assert.equal((await request(`/${current.id}/upload-sessions/${session.id}`)).data.offset, chunkBytes);
  assert.equal((await put(current.id, session.id, chunkBytes, data.subarray(chunkBytes))).data.offset, data.length);
  await request(`/${current.id}/upload-sessions/${session.id}/complete`, "POST", {});
  assert.equal((await wait(current.id, session.id)).status, "COMPLETE");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM migration_upload_chunks WHERE uploadId=?").get(session.id) as { n: number }).n, 2);
});

test("expired upload resumes with the same operation but a fresh zero offset", async () => {
  const current = job(), data = pdf(); const session = await create(current.id, data);
  await put(current.id, session.id, 0, data.subarray(0, chunkBytes));
  db.prepare("UPDATE migration_upload_sessions SET expiresAt=? WHERE id=?").run(new Date(Date.now() - 1000).toISOString(), session.id);
  assert.equal((await request(`/${current.id}/upload-sessions/${session.id}`)).data.status, "EXPIRED");
  const renewed = await request(`/${current.id}/upload-sessions`, "POST", session.input);
  assert.equal(renewed.data.id, session.id); assert.equal(renewed.data.status, "OPEN"); assert.equal(renewed.data.offset, 0);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM migration_upload_chunks WHERE uploadId=?").get(session.id) as { n: number }).n, 0);
  await assert.rejects(service.previewMigration(owner, current.id));
});

test("full-file hash mismatch fails the job without pretending the file was imported", async () => {
  const current = job(), data = pdf(100); const session = await create(current.id, data, { sha256: "0".repeat(64) });
  await put(current.id, session.id, 0, data);
  await request(`/${current.id}/upload-sessions/${session.id}/complete`, "POST", {});
  const failed = await wait(current.id, session.id);
  assert.equal(failed.status, "FAILED"); assert.equal(failed.error, "MIGRATION_UPLOAD_HASH");
  const snapshot = service.getMigration(owner, current.id);
  assert.equal(snapshot.status, "FAILED"); assert.equal(snapshot.counts.total, 0);
  assert.equal(db.prepare("SELECT 1 FROM migration_assets WHERE jobId=?").get(current.id), undefined);
});

test("source completion hands off exactly one scan and never creates notes without approval", async () => {
  const current = job(), data = Buffer.from("# Resumable source\nBody");
  const session = await create(current.id, data, { filename: "note.md", assetPath: undefined });
  await put(current.id, session.id, 0, data);
  await request(`/${current.id}/upload-sessions/${session.id}/complete`, "POST", {});
  assert.equal((await wait(current.id, session.id)).status, "COMPLETE");
  const deadline = Date.now() + 5000;
  while (service.getMigration(owner, current.id).status !== "CREATED") { assert.ok(Date.now() < deadline); await new Promise((resolve) => setTimeout(resolve, 10)); }
  assert.equal(service.getMigration(owner, current.id).counts.total, 1);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM notes WHERE userId=?").get(owner.userId) as { n: number }).n, 0);
  await request(`/${current.id}/upload-sessions/${session.id}/complete`, "POST", {});
  uploads.recoverMigrationUploadSessions();
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM migration_uploads WHERE jobId=?").get(current.id) as { n: number }).n, 1);
});

test("cancelled jobs and live token revocation stop further upload writes", async () => {
  const tree = await import("../src/services/knowledgeTree");
  const target = tree.createKnowledgeChild({ actorUserId: owner.userId, workspaceId: null, parentId: null, nodeType: "folder", title: "Upload token", db });
  const tokenId = crypto.randomUUID();
  db.prepare("INSERT INTO api_tokens(id,userId,name,tokenHash,scopes,resourceMode) VALUES (?,?,?,? ,?,'restricted')").run(tokenId, owner.userId, "upload", crypto.randomUUID(), JSON.stringify(["export:import", "notes:read", "notes:write", "notebooks:write", "attachments:write"]));
  db.prepare("INSERT INTO api_token_resources(id,tokenId,resourceId,permission,includeDescendants) VALUES (?,?,?,'write',1)").run(crypto.randomUUID(), tokenId, target.resourceId);
  const actor = { ...owner, tokenId };
  const current = service.createMigration(actor, { operationId: crypto.randomUUID(), source: { platform: "files", exportId: "scope" }, targetNotebookId: target.resourceId });
  const data = pdf(100);
  const session = uploads.createMigrationUploadSession(actor, current.id, { operationId: crypto.randomUUID(), filename: "test.pdf", assetPath: "assets/test.pdf", sha256: hash(data), size: data.length });
  db.prepare("UPDATE api_tokens SET revokedAt=datetime('now') WHERE id=?").run(tokenId);
  await assert.rejects(uploads.putMigrationUploadChunk(owner, current.id, session.id, 0, hash(data), new Blob([data]).stream()), { code: "MIGRATION_TOKEN_REVOKED" });
  const normal = job(), otherSession = await create(normal.id, data);
  service.controlMigration(owner, normal.id, "cancel");
  assert.equal((await put(normal.id, otherSession.id, 0, data)).status, 409);
  assert.equal(uploads.getMigrationUploadSession(owner, normal.id, otherSession.id).status, "CANCELLED");
});
