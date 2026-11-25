import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/** Runs only against a git-archived source tree and an explicitly isolated DB. */
async function main() {
  const [sourceRoot, mode, receiptPath] = process.argv.slice(2);
  const load = (name: string): any => require(path.join(sourceRoot, "backend/src", name));
  load("runtime/knowledge-tree-migration-bootstrap.ts");
  const schema = load("db/schema.ts"), db = schema.getDb();
  load("services/audit.ts").initAuditTables();
  const apiTokens = load("lib/api-tokens.ts"); apiTokens.initApiTokensTable(db);
  const userId = "upgrade-fixture-user", sessionId = "upgrade-fixture-session";
  db.prepare("INSERT INTO users(id,username,passwordHash) VALUES (?,?,'isolated-fixture')").run(userId, userId);
  db.prepare("INSERT INTO user_sessions(id,userId,expiresAt) VALUES (?,?,?)").run(sessionId, userId, new Date(Date.now() + 3_600_000).toISOString());
  const tokenRaw = apiTokens.generateApiTokenRaw(), tokenId = crypto.randomUUID();
  db.prepare("INSERT INTO api_tokens(id,userId,name,tokenHash,scopes) VALUES (?,?,'upgrade-fixture',?,?)").run(tokenId, userId, apiTokens.hashApiToken(tokenRaw), JSON.stringify(["export:import", "notes:read", "notes:write", "notebooks:read", "notebooks:write", "attachments:write"]));
  const sync = load("sync/index.ts");
  const profile = sync.createProfile(db, { name: "Isolated fixture without remote credentials", serverUrl: "http://127.0.0.1:1" });
  sync.switchActiveProfile(db, profile.id); sync.ensureDevice(db, { profileId: profile.id, platform: "darwin" });
  sync.markBootstrapReady(db, profile.id, 0);
  load("sync/knowledgeTreeReadiness.ts").markKnowledgeTreeSyncReady(db, profile.id);
  const tree = load("services/knowledgeTree.ts");
  const folder = tree.createKnowledgeChild({ actorUserId: userId, workspaceId: null, parentId: null, nodeType: "folder", title: "Existing user folder", db });
  const existing = tree.createKnowledgeChild({ actorUserId: userId, workspaceId: null, parentId: folder.id, nodeType: "note", title: "Existing user note", db });
  db.prepare("UPDATE notes SET content=?,contentText=?,version=7 WHERE id=?").run("<p>Existing content must survive upgrades.</p>", "Existing content must survive upgrades.", existing.resourceId);
  const service = load("services/migrationService.ts");
  const actor = { userId }, source = { platform: "markdown", exportId: "old-version-export" };
  const pending = service.createMigration(actor, { operationId: crypto.randomUUID(), source, name: "Unapproved old preview" });
  await service.stageMigrationItems(actor, pending.id, [{ schemaVersion: 1, source: { ...source, sourceId: "pending" }, title: "Pending manual approval", contentFormat: "markdown", content: "# Prepared only\nMust not import automatically." }]);
  const pendingPreview = await service.previewMigration(actor, pending.id);
  let recoveryJobId: string | undefined, uploadId: string | undefined, sourceFile: string | undefined;
  if (mode === "p0") {
    const job = service.createMigration(actor, { operationId: crypto.randomUUID(), source, name: "Approved old worker" });
    recoveryJobId = job.id;
    await service.stageMigrationItems(actor, job.id, Array.from({ length: 30 }, (_, index) => ({ schemaVersion: 1, source: { ...source, sourceId: `approved-${index}` }, title: `Approved ${index}`, contentFormat: "markdown", content: `# Approved ${index}\nDurable source content ${index}.` })));
    const preview = await service.previewMigration(actor, job.id);
    service.approveMigration(actor, job.id, preview.previewDigest, sessionId);
    const deadline = Date.now() + 10_000;
    while (service.getMigration(actor, job.id).counts.imported < 5) {
      if (Date.now() > deadline) throw new Error("Old worker did not reach a committed batch");
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  } else {
    const JSZip = require(path.join(sourceRoot, "backend/node_modules/jszip"));
    const pdf = Buffer.concat([Buffer.from("%PDF-1.7\n"), crypto.randomBytes(4 * 1024 * 1024)]);
    const zip = new JSZip().file("note.md", "# Resumed source\n[PDF](assets/large.pdf)").file("assets/large.pdf", pdf);
    const bytes = await zip.generateAsync({ type: "nodebuffer", compression: "STORE" });
    sourceFile = path.join(path.dirname(receiptPath), "source.zip"); fs.writeFileSync(sourceFile, bytes);
    const job = service.createMigration({ userId, tokenId }, { operationId: crypto.randomUUID(), source: { platform: "files", exportId: "old-upload" }, name: "Old resumable source" });
    recoveryJobId = job.id;
    const uploads = load("services/migrationUploads.ts"), sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    const upload = uploads.createMigrationUploadSession({ userId, tokenId }, job.id, { operationId: "old-version-source-file", filename: "source.zip", size: bytes.length, sha256 });
    uploadId = upload.id;
    const part = bytes.subarray(0, 4 * 1024 * 1024);
    await uploads.putMigrationUploadChunk({ userId, tokenId }, job.id, upload.id, 0, crypto.createHash("sha256").update(part).digest("hex"), new Blob([part]).stream());
  }
  const receipt = {
    userId, sessionId, tokenRaw, tokenId, profileId: profile.id, pendingJobId: pending.id, pendingDigest: pendingPreview.previewDigest,
    recoveryJobId, uploadId, sourceFile,
    schemaVersion: db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version,
    existing: db.prepare("SELECT id,title,content,version FROM notes WHERE id=?").get(existing.resourceId),
    originalOutbox: db.prepare("SELECT mutationId,entityType,entityId,payload,baseVersion FROM sync_outbox WHERE profileId=? ORDER BY mutationId").all(profile.id),
    importedIds: db.prepare("SELECT targetNoteId FROM migration_items WHERE jobId=? AND status='IMPORTED' ORDER BY id").all(recoveryJobId),
  };
  fs.writeFileSync(receiptPath, JSON.stringify(receipt), { mode: 0o600 });
  // Simulate an old process stopping between committed notes, not an in-memory fixture.
  process.exit(0);
}
main().catch(() => { console.error("Isolated historical migration fixture failed"); process.exit(1); });
