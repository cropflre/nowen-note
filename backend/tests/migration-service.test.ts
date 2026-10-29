import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Hono } from "hono";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-migration-service-"));
process.env.DB_PATH = path.join(directory, "test.db");
process.env.ELECTRON_USER_DATA = directory;
process.env.NODE_ENV = "test";
let db: ReturnType<typeof import("../src/db/schema")["getDb"]>;
let closeDb: () => void;
let service: typeof import("../src/services/migrationService");
let app: Hono;
const owner = { userId: "migration-owner" };
const other = { userId: "migration-other" };
const source = { platform: "markdown", exportId: "fixture-export" };

test.before(async () => {
  await import("../src/runtime/knowledge-tree-migration-bootstrap");
  const schema = await import("../src/db/schema");
  db = schema.getDb(); closeDb = schema.closeDb;
  service = await import("../src/services/migrationService");
  const { initApiTokensTable } = await import("../src/lib/api-tokens"); initApiTokensTable(db);
  const { initAuditTables } = await import("../src/services/audit"); initAuditTables();
  for (const user of [owner.userId, other.userId]) db.prepare("INSERT INTO users(id,username,passwordHash) VALUES (?,?,'hash')").run(user, user);
  db.prepare("INSERT INTO user_sessions(id,userId,expiresAt) VALUES ('human-session',?,?)").run(owner.userId, new Date(Date.now() + 3_600_000).toISOString());
  app = new Hono();
  app.use("*", async (c, next) => {
    if (c.req.header("X-Test-Real-Session") === "yes") c.set("migrationApprovalSession" as never, { userId: owner.userId, sessionId: "human-session" } as never);
    await next();
  });
  app.route("/migrations", (await import("../src/routes/migrations")).default);
});
test.after(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); closeDb?.(); fs.rmSync(directory, { recursive: true, force: true }); });
function create(name = "Fixture", extra: Record<string, unknown> = {}) {
  return service.createMigration(owner, { operationId: crypto.randomUUID(), source, name, ...extra });
}
function note(id: string, content = `# ${id}\nUnique ${id} ${crypto.randomUUID()}`, extra: Record<string, unknown> = {}) {
  return { schemaVersion: 1, source: { ...source, sourceId: id }, title: id, path: [], contentFormat: "markdown", content, tags: [], attachments: [], links: [], metadata: {}, ...extra };
}
async function wait(id: string, allowed = ["COMPLETED", "PARTIAL", "FAILED", "CANCELLED"]) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const current = service.getMigration(owner, id);
    if (allowed.includes(current.status)) return current;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`migration timed out: ${JSON.stringify(service.getMigration(owner, id))}`);
}
async function run(notes: ReturnType<typeof note>[], name = "Fixture") {
  const job = create(name);
  await service.stageMigrationItems(owner, job.id, notes);
  const preview = await service.previewMigration(owner, job.id);
  service.approveMigration(owner, job.id, preview.previewDigest!, "human-session");
  return wait(job.id);
}
async function request(id: string, suffix: string, body: unknown = {}, headers: Record<string, string> = {}) {
  const response = await app.request(`/migrations/${id}/${suffix}`, { method: "POST", headers: { "Content-Type": "application/json", "X-User-Id": owner.userId, ...headers }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
}

test("migration operation and item retries are idempotent and cross-user reads are denied", async () => {
  const input = { operationId: crypto.randomUUID(), source, name: "Idempotency" };
  const job = service.createMigration(owner, input);
  assert.equal(service.createMigration(owner, input).id, job.id);
  assert.throws(() => service.createMigration(owner, { ...input, name: "Changed" }), { code: "MIGRATION_OPERATION_CONFLICT" });
  assert.throws(() => service.getMigration(other, job.id), { code: "MIGRATION_NOT_FOUND" });
  const value = note("stage-idempotent");
  await service.stageMigrationItems(owner, job.id, [value]);
  await service.stageMigrationItems(owner, job.id, [value]);
  assert.equal(service.getMigration(owner, job.id).counts.total, 1);
  await assert.rejects(service.stageMigrationItems(owner, job.id, [{ ...value, content: "changed" }]), { code: "MIGRATION_ITEM_CONFLICT" });
  service.controlMigration(owner, job.id, "cancel");
});

test("approval requires validated session context and consumes the current preview exactly once", async () => {
  const job = create("Approval"); await service.stageMigrationItems(owner, job.id, [note("approval-note")]);
  const first = await service.previewMigration(owner, job.id);
  const preview = await service.previewMigration(owner, job.id);
  assert.notEqual(first.previewDigest, preview.previewDigest);
  const forged = await request(job.id, "approve", { previewDigest: preview.previewDigest }, { "X-Session-Id": "human-session" });
  assert.equal(forged.status, 403);
  assert.equal(forged.body.code, "MIGRATION_HUMAN_APPROVAL_REQUIRED");
  assert.throws(() => service.approveMigration(owner, job.id, first.previewDigest!, "human-session"), { code: "MIGRATION_PREVIEW_EXPIRED" });
  const approved = await request(job.id, "approve", { previewDigest: preview.previewDigest }, { "X-Test-Real-Session": "yes" });
  assert.equal(approved.status, 202);
  assert.throws(() => service.approveMigration(owner, job.id, preview.previewDigest!, "human-session"), { code: "MIGRATION_STATE_CONFLICT" });
  const completed = await wait(job.id); assert.equal(completed.status, "COMPLETED"); assert.equal(completed.counts.imported, 1);
});

test("migration writes folders, tags, timestamps, links, references and transactional sync events", async () => {
  const tree = await import("../src/services/knowledgeTree");
  const parent = tree.createKnowledgeChild({ actorUserId: owner.userId, workspaceId: null, parentId: null, nodeType: "folder", title: "Migration target", db });
  const job = create("Mapping", { targetNotebookId: parent.resourceId });
  const asset = Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]);
  const sha256 = crypto.createHash("sha256").update(asset).digest("hex");
  const relative = "assets/test.png";
  fs.mkdirSync(path.join(service.migrationJobDirectory(job.id), "assets")); fs.writeFileSync(path.join(service.migrationJobDirectory(job.id), relative), asset);
  service.registerMigrationAsset(owner, job.id, relative, sha256, asset.length);
  const before = (db.prepare("SELECT COALESCE(MAX(sequence),0) AS seq FROM sync_changes_v2").get() as any).seq;
  await service.stageMigrationItems(owner, job.id, [
    note("mapping-a", "# A\n[Read B](b.md)\n![Image](assets/test.png)", { path: ["Folder"], tags: ["imported"], createdAt: "2025-01-01T01:00:00Z", updatedAt: "2025-01-02T01:00:00Z", attachments: [{ assetId: "test", path: relative, sha256 }], links: [{ href: "b.md", targetSourceId: "mapping-b" }] }),
    note("mapping-b", "# B\nIndependent content", { path: ["Folder"] }),
  ]);
  const preview = await service.previewMigration(owner, job.id); assert.equal(preview.counts.attachments, 1);
  service.approveMigration(owner, job.id, preview.previewDigest!, "human-session");
  const completed = await wait(job.id); assert.equal(completed.status, "COMPLETED", JSON.stringify(completed));
  const report = service.migrationReport(owner, job.id);
  const a = report.items.find((item) => item.sourceId === "mapping-a")!;
  const b = report.items.find((item) => item.sourceId === "mapping-b")!;
  const stored = db.prepare("SELECT * FROM notes WHERE id=?").get(a.targetNoteId!) as any;
  assert.match(stored.content, new RegExp(`note:${b.targetNoteId}`));
  assert.match(stored.content, /\/api\/attachments\//);
  assert.equal(stored.createdAt, "2025-01-01T01:00:00.000Z");
  assert.equal(stored.updatedAt, "2025-01-02T01:00:00.000Z");
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM attachment_references WHERE noteId=?").get(a.targetNoteId!) as any).count, 1);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM note_tags WHERE noteId=?").get(a.targetNoteId!) as any).count, 1);
  assert.ok((db.prepare("SELECT COUNT(*) AS count FROM sync_changes_v2 WHERE sequence>? AND entityId=?").get(before, a.targetNoteId!) as any).count > 0);
  assert.ok(!JSON.stringify(completed).includes("Independent content"));
  assert.ok(!JSON.stringify(report).includes("# A"));
});

test("partial failures retry only failed items and persist successful mappings", async () => {
  const job = create("Retry");
  await service.stageMigrationItems(owner, job.id, [note("retry-pass"), note("retry-fail")]);
  db.exec("CREATE TRIGGER migration_test_failure BEFORE INSERT ON notes WHEN NEW.title='retry-fail' BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
  const preview = await service.previewMigration(owner, job.id);
  service.approveMigration(owner, job.id, preview.previewDigest!, "human-session");
  const partial = await wait(job.id); assert.equal(partial.status, "PARTIAL"); assert.equal(partial.counts.imported, 1); assert.equal(partial.counts.failed, 1);
  const successful = service.migrationReport(owner, job.id).items.find((item) => item.status === "IMPORTED")!.targetNoteId;
  db.exec("DROP TRIGGER migration_test_failure");
  service.controlMigration(owner, job.id, "retry");
  const completed = await wait(job.id); assert.equal(completed.status, "COMPLETED"); assert.equal(completed.counts.imported, 2);
  assert.equal(service.migrationReport(owner, job.id).items.find((item) => item.sourceId === "retry-pass")!.targetNoteId, successful);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM notes WHERE title IN ('retry-pass','retry-fail')").get() as any).count, 2);
});

test("cancel stops subsequent writes and retains already committed results", async () => {
  const job = create("Cancel"); await service.stageMigrationItems(owner, job.id, Array.from({ length: 20 }, (_, index) => note(`cancel-${index}`)));
  const preview = await service.previewMigration(owner, job.id); service.approveMigration(owner, job.id, preview.previewDigest!, "human-session");
  await wait(job.id, ["IMPORTING"]);
  while (!service.getMigration(owner, job.id).counts.imported) await new Promise((resolve) => setTimeout(resolve, 5));
  const cancelled = service.controlMigration(owner, job.id, "cancel"); const imported = cancelled.counts.imported;
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(service.getMigration(owner, job.id).status, "CANCELLED");
  assert.equal(service.getMigration(owner, job.id).counts.imported, imported);
  assert.ok(Number(imported) > 0 && Number(imported) < 20);
});

test("DCC-004: editing an imported note during the job preserves the newer body", async () => {
  const job = create("Concurrent edit");
  await service.stageMigrationItems(owner, job.id, Array.from({ length: 20 }, (_, index) => note(`edit-during-${index}`)));
  const preview = await service.previewMigration(owner, job.id); service.approveMigration(owner, job.id, preview.previewDigest!, "human-session");
  await wait(job.id, ["IMPORTING"]);
  let imported: { targetNoteId: string } | undefined;
  while (!imported) {
    imported = db.prepare("SELECT targetNoteId FROM migration_items WHERE jobId=? AND status='IMPORTED' LIMIT 1").get(job.id) as typeof imported;
    if (!imported) await new Promise((resolve) => setTimeout(resolve, 5));
  }
  db.prepare("UPDATE notes SET content='user newer body',version=version+1 WHERE id=?").run(imported.targetNoteId);
  const completed = await wait(job.id); assert.equal(completed.status, "COMPLETED");
  assert.equal((db.prepare("SELECT content FROM notes WHERE id=?").get(imported.targetNoteId) as { content: string }).content, "user newer body");
  assert.throws(() => service.undoMigration(owner, job.id, "human-session"), { code: "MIGRATION_UNDO_CONFLICT" });
});

test("safe undo refuses edited results and soft-deletes only an unchanged migration tree", async () => {
  const changed = await run([note("undo-changed")]);
  const changedId = service.migrationReport(owner, changed.id).items[0].targetNoteId!;
  db.prepare("UPDATE notes SET content='user edit',version=version+1 WHERE id=?").run(changedId);
  assert.throws(() => service.undoMigration(owner, changed.id, "human-session"), { code: "MIGRATION_UNDO_CONFLICT" });
  assert.equal((db.prepare("SELECT isTrashed FROM notes WHERE id=?").get(changedId) as any).isTrashed, 0);
  const untouched = await run([note("undo-untouched", "# Nested note", { path: ["Nested"] }), note("undo-sibling", "# Nested sibling", { path: ["Nested"] })]); const untouchedId = service.migrationReport(owner, untouched.id).items[0].targetNoteId!;
  const undone = service.undoMigration(owner, untouched.id, "human-session"); assert.equal(undone.status, "UNDONE");
  assert.equal((db.prepare("SELECT isTrashed FROM notes WHERE id=?").get(untouchedId) as any).isTrashed, 1);
});

test("HTML scripts are sanitized and source changes are reported without overwriting existing data", async () => {
  const value = note("html-source", '<h1>Safe</h1><script>malicious()</script><img src="http://127.0.0.1/private">', { contentFormat: "html" });
  const completed = await run([value]); const result = service.migrationReport(owner, completed.id).items[0];
  const stored = db.prepare("SELECT content FROM notes WHERE id=?").get(result.targetNoteId!) as any;
  assert.ok(!stored.content.includes("<script"));
  const job = create("Changed source"); await service.stageMigrationItems(owner, job.id, [{ ...value, content: "<p>Changed content</p>" }]);
  const preview = await service.previewMigration(owner, job.id); assert.equal(preview.counts.existing, 1);
  assert.ok(preview.warnings.some((warning) => warning.includes("SOURCE_CHANGED_EXISTING_KEPT")));
  assert.equal((db.prepare("SELECT content FROM notes WHERE id=?").get(result.targetNoteId!) as any).content, stored.content);
  service.controlMigration(owner, job.id, "cancel");
});

test("token scopes, target grants and live revocation apply across the migration lifecycle", async () => {
  const tokenId = crypto.randomUUID();
  db.prepare("INSERT INTO api_tokens(id,userId,name,tokenHash,scopes,resourceMode) VALUES (?,?,?,? ,?,'restricted')").run(tokenId, owner.userId, "migration fixture", crypto.randomUUID(), JSON.stringify(["export:import", "notes:read", "notes:write", "notebooks:write"]));
  const actor = { ...owner, tokenId };
  assert.throws(() => service.createMigration(actor, { operationId: crypto.randomUUID(), source }), { code: "API_TOKEN_RESOURCE_DENIED" });
  const tree = await import("../src/services/knowledgeTree"); const target = tree.createKnowledgeChild({ actorUserId: owner.userId, workspaceId: null, parentId: null, nodeType: "folder", title: "Token target", db });
  db.prepare("INSERT INTO api_token_resources(id,tokenId,resourceId,permission,includeDescendants) VALUES (?,?,?,'write',1)").run(crypto.randomUUID(), tokenId, target.resourceId);
  const job = service.createMigration(actor, { operationId: crypto.randomUUID(), source, targetNotebookId: target.resourceId });
  await service.stageMigrationItems(actor, job.id, [note("token-note")]);
  const preview = await service.previewMigration(actor, job.id);
  assert.throws(() => service.approveMigration(actor, job.id, preview.previewDigest!, "human-session"), { code: "MIGRATION_HUMAN_APPROVAL_REQUIRED" });
  db.prepare("UPDATE api_tokens SET revokedAt=datetime('now') WHERE id=?").run(tokenId);
  assert.throws(() => service.approveMigration(owner, job.id, preview.previewDigest!, "human-session"), { code: "MIGRATION_TOKEN_REVOKED" });
  db.prepare("UPDATE api_tokens SET revokedAt=NULL WHERE id=?").run(tokenId);
  service.approveMigration(owner, job.id, preview.previewDigest!, "human-session");
  db.prepare("UPDATE api_tokens SET revokedAt=datetime('now') WHERE id=?").run(tokenId);
  const failed = await wait(job.id); assert.equal(failed.status, "FAILED"); assert.equal(failed.error, "MIGRATION_TOKEN_REVOKED"); assert.equal(failed.counts.imported, 0);
});

test("a second token cannot borrow creator attachment/tag scopes or a target without descendants", async () => {
  const tree = await import("../src/services/knowledgeTree");
  const target = tree.createKnowledgeChild({ actorUserId: owner.userId, workspaceId: null, parentId: null, nodeType: "folder", title: "Narrow target", db });
  const tokenId = crypto.randomUUID();
  db.prepare("INSERT INTO api_tokens(id,userId,name,tokenHash,scopes,resourceMode) VALUES (?,?,?,? ,?,'restricted')").run(tokenId, owner.userId, "narrow", crypto.randomUUID(), JSON.stringify(["export:import", "notes:read", "notes:write", "notebooks:write"]));
  const grantId = crypto.randomUUID();
  db.prepare("INSERT INTO api_token_resources(id,tokenId,resourceId,permission,includeDescendants) VALUES (?,?,?,'write',0)").run(grantId, tokenId, target.resourceId);
  const actor = { ...owner, tokenId };
  assert.throws(() => service.createMigration(actor, { operationId: crypto.randomUUID(), source, targetNotebookId: target.resourceId }), { code: "API_TOKEN_RESOURCE_DENIED" });
  db.prepare("UPDATE api_token_resources SET includeDescendants=1 WHERE id=?").run(grantId);
  const job = create("Creator login", { targetNotebookId: target.resourceId });
  await assert.rejects(service.stageMigrationItems(actor, job.id, [note("forbidden-tag", "body", { tags: ["forbidden"] })]), { code: "API_TOKEN_SCOPE_REQUIRED" });
  const asset = Buffer.from("%PDF-1.7\nfixture"); const relative = "assets/narrow.pdf";
  fs.mkdirSync(path.join(service.migrationJobDirectory(job.id), "assets")); fs.writeFileSync(path.join(service.migrationJobDirectory(job.id), relative), asset);
  assert.throws(() => service.registerMigrationAsset(actor, job.id, relative, crypto.createHash("sha256").update(asset).digest("hex"), asset.length), { code: "API_TOKEN_SCOPE_REQUIRED" });
  service.controlMigration(owner, job.id, "cancel");
});

test("human preview preserves the creator token boundary for duplicate mappings (DCC-006)", async () => {
  const content = `outside duplicate ${crypto.randomUUID()}`;
  const existing = await run([note("outside-token", content)]);
  const outsideId = service.migrationReport(owner, existing.id).items[0].targetNoteId!;
  const tree = await import("../src/services/knowledgeTree");
  const target = tree.createKnowledgeChild({ actorUserId: owner.userId, workspaceId: null, parentId: null, nodeType: "folder", title: "Scoped target", db });
  const tokenId = crypto.randomUUID();
  db.prepare("INSERT INTO api_tokens(id,userId,name,tokenHash,scopes,resourceMode) VALUES (?,?,?,? ,?,'restricted')").run(tokenId, owner.userId, "scope", crypto.randomUUID(), JSON.stringify(["export:import", "notes:read", "notes:write", "notebooks:write"]));
  db.prepare("INSERT INTO api_token_resources(id,tokenId,resourceId,permission,includeDescendants) VALUES (?,?,?,'write',1)").run(crypto.randomUUID(), tokenId, target.resourceId);
  const actor = { ...owner, tokenId };
  const job = service.createMigration(actor, { operationId: crypto.randomUUID(), source, targetNotebookId: target.resourceId });
  await service.stageMigrationItems(actor, job.id, [note("outside-token", content)]);
  const preview = await service.previewMigration(owner, job.id);
  assert.equal(preview.counts.existing, 0);
  assert.equal(preview.counts.create, 1);
  assert.ok(!JSON.stringify(service.migrationReport(actor, job.id)).includes(outsideId));
  service.controlMigration(owner, job.id, "cancel");
});

test("a failed partial source scan cannot be previewed as a complete import (DCC-008)", async () => {
  const job = create("Partial scan"); await service.stageMigrationItems(owner, job.id, [note("partial-scan")]);
  db.prepare("INSERT INTO migration_uploads(id,jobId,filename,path,status) VALUES (?,?,?,?,'PENDING')").run(crypto.randomUUID(), job.id, "broken.zip", "sources/broken.zip");
  db.prepare("UPDATE migration_jobs SET status='FAILED',error='MIGRATION_INVALID_UTF8' WHERE id=?").run(job.id);
  await assert.rejects(service.previewMigration(owner, job.id), { code: "MIGRATION_SOURCE_INCOMPLETE" });
  assert.equal(service.getMigration(owner, job.id).status, "FAILED");
  assert.equal(service.getMigration(owner, job.id).error, "MIGRATION_INVALID_UTF8");
});

test("repeat asset uploads preserve previously staged bytes and expiry preserves reports", async () => {
  const job = create("Asset retry");
  const body = Buffer.from("%PDF-1.7\nretained asset"); const sha256 = crypto.createHash("sha256").update(body).digest("hex");
  const upload = () => app.request(`/migrations/${job.id}/uploads?filename=one.pdf&assetPath=assets/one.pdf&sha256=${sha256}`, {
    method: "POST", headers: { "X-User-Id": owner.userId, "Content-Type": "application/octet-stream" }, body,
  });
  assert.equal((await upload()).status, 202);
  assert.equal((await upload()).status, 409);
  assert.deepEqual(fs.readFileSync(path.join(service.migrationJobDirectory(job.id), "assets/one.pdf")), body);
  await service.stageMigrationItems(owner, job.id, [note("expiry-note")]);
  db.prepare("UPDATE migration_jobs SET updatedAt=datetime('now','-8 days') WHERE id=?").run(job.id);
  service.cleanupMigrationStaging();
  assert.equal(service.getMigration(owner, job.id).status, "CANCELLED");
  assert.equal(service.migrationReport(owner, job.id).items.length, 1);
  assert.equal(fs.existsSync(service.migrationJobDirectory(job.id)), false);
});

test("crash compensation deletes only uncommitted migration objects", async () => {
  const job = create("Object intent"); await service.stageMigrationItems(owner, job.id, [note("orphan-intent")]);
  const itemId = service.migrationReport(owner, job.id).items[0].id;
  const storage = await import("../src/services/attachment-storage");
  const objectPath = `migrations/${job.id}/orphan.pdf`;
  await storage.writeAttachmentObject(objectPath, Buffer.from("%PDF-1.7\norphan"));
  db.prepare("INSERT INTO migration_objects(path,jobId,itemId) VALUES (?,?,?)").run(objectPath, job.id, itemId);
  await service.cleanupMigrationObjects();
  assert.equal(fs.existsSync(storage.getLocalAttachmentPath(objectPath)), false);
  assert.equal(db.prepare("SELECT 1 FROM migration_objects WHERE path=?").get(objectPath), undefined);
  service.controlMigration(owner, job.id, "cancel");
});

test("preview checks storage for every output attachment copy before approval", async () => {
  const job = create("Storage capacity"); const data = Buffer.from("%PDF-1.7\ncapacity"); const sha256 = crypto.createHash("sha256").update(data).digest("hex");
  fs.mkdirSync(path.join(service.migrationJobDirectory(job.id), "assets"));
  fs.writeFileSync(path.join(service.migrationJobDirectory(job.id), "assets/capacity.pdf"), data);
  service.registerMigrationAsset(owner, job.id, "assets/capacity.pdf", sha256, data.length);
  await service.stageMigrationItems(owner, job.id, [note("capacity-a", "one", { attachments: [{ assetId: "pdf", path: "assets/capacity.pdf", sha256 }] })]);
  const original = fs.statfsSync;
  fs.statfsSync = (() => ({ bavail: 0, bsize: 4096 })) as typeof fs.statfsSync;
  try { await assert.rejects(service.previewMigration(owner, job.id), { code: "MIGRATION_STORAGE_CAPACITY" }); }
  finally { fs.statfsSync = original; }
  assert.equal(service.getMigration(owner, job.id).status, "CREATED");
  service.controlMigration(owner, job.id, "cancel");
});
