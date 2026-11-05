import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import test, { before } from "node:test";
import { setImmediate as yieldEventLoop } from "node:timers/promises";
let db: ReturnType<typeof import("../src/db/schema")["getDb"]>;
let service: typeof import("../src/services/aiMemoryService");
let jobs: typeof import("../src/lib/ai-memory-import-jobs");
const actor = { userId: "import-owner" }, other = { userId: "import-other" };
before(async () => {
  await import("../src/runtime/knowledge-tree-migration-bootstrap");
  db = (await import("../src/db/schema")).getDb();
  (await import("../src/lib/api-tokens")).initApiTokensTable(db);
  service = await import("../src/services/aiMemoryService"); jobs = await import("../src/lib/ai-memory-import-jobs");
  for (const user of [actor, other]) db.prepare("INSERT INTO users(id,username,passwordHash) VALUES (?,?,'fixture')").run(user.userId, user.userId);
});
function source() {
  // Remove only completed private staging fixtures to stay within the production per-user quota.
  for (const job of jobs.listAIImports(actor).items) jobs.discardAIImport(actor, job.id);
  const notebookId = crypto.randomUUID(); db.prepare("INSERT INTO notebooks(id,userId,name) VALUES (?,?,'Imported AI fixture')").run(notebookId, actor.userId);
  return service.createAIMemorySource(actor, { provider: "standard", accountScope: crypto.randomUUID(), notebookId, permissionState: "granted" });
}
const data = (count = 1, text = "Original") => JSON.stringify(Array.from({ length: count }, (_, index) => ({ externalConversationId: `conversation-${index}`, title: `Conversation ${index}`,
  messages: [{ externalMessageId: "message-1", role: "user", text }] })));
async function preview(binding: ReturnType<typeof source>, content = data()) {
  return jobs.previewAIImport(actor, { sourceId: binding.id, filename: "transcript.json", body: new Blob([content]).stream() });
}
async function finish(id: string) {
  for (let attempts = 0; attempts < 1000; attempts++) {
    await yieldEventLoop(); const job = jobs.getAIImport(actor, id); if (job.status !== "IMPORTING") return job;
  }
  throw new Error("import fixture did not finish");
}
test("AI import requires preview review, persists real archives and deduplicates repeated files", async () => {
  const binding = source(), first = await preview(binding);
  assert.equal(first.status, "PREVIEW"); assert.equal(first.items[0].preview, "Original");
  assert.equal(service.listAIConversations(actor, { sourceId: binding.id }).total, 0);
  assert.throws(() => jobs.startAIImport(actor, first.id, "wrong"), { code: "AI_IMPORT_PREVIEW_CHANGED" });
  jobs.startAIImport(actor, first.id, first.previewDigest); const result = await finish(first.id);
  assert.equal(result.status, "COMPLETED"); assert.equal(result.counts.saved, 1);
  const note = db.prepare("SELECT content FROM notes WHERE id=?").get(result.items[0].noteId) as { content: string };
  assert.match(note.content, /Original/);
  const again = await preview(binding); jobs.startAIImport(actor, again.id, again.previewDigest); assert.equal((await finish(again.id)).status, "COMPLETED");
  assert.equal(service.listAIConversations(actor, { sourceId: binding.id }).total, 1);
});
test("AI import rejects changed staged content instead of trusting a reviewed digest", async () => {
  const binding = source(), job = await preview(binding);
  const filename = path.join(process.env.ELECTRON_USER_DATA!, "ai-memory-imports", job.id, "0.json");
  const snapshot = JSON.parse(fs.readFileSync(filename, "utf8")); snapshot.messages[0].text = "Unreviewed content"; fs.writeFileSync(filename, JSON.stringify(snapshot));
  jobs.startAIImport(actor, job.id, job.previewDigest); const result = await finish(job.id);
  assert.equal(result.status, "FAILED"); assert.equal(result.items[0].error, "AI_IMPORT_STAGING_CORRUPTED");
  assert.equal(service.listAIConversations(actor, { sourceId: binding.id }).total, 0);
});

test("DCC-008 native archive export and reimport preserve structured evidence and timestamps", async () => {
  const binding = source();
  const text = "const example = '<kept>';";
  const original = service.ingestAIConversation(actor, { sourceId: binding.id, operationId: crypto.randomUUID(), mode: "manual",
    snapshot: { provider: binding.provider, accountScope: binding.accountScope, externalConversationId: "native-roundtrip", title: "Native evidence",
      sourceUrl: "https://example.com/visible-conversation", completeness: "partial", capturedAt: "2026-01-02T03:04:05.000Z",
      messages: [{ externalMessageId: "native-message", localSequence: 0, role: "tool", text,
        blocks: [{ type: "code", language: "typescript", text }, { type: "attachment", name: "missing.pdf", url: "https://example.com/missing.pdf" }],
        captureState: "partial", createdAt: "2026-01-01T03:04:05.000Z", updatedAt: "2026-01-02T03:04:05.000Z" }] } });
  const exported = service.exportAIConversation(actor, original.conversationId);
  const job = await preview(binding, JSON.stringify(exported));
  jobs.startAIImport(actor, job.id, job.previewDigest);
  assert.equal((await finish(job.id)).status, "COMPLETED");
  assert.deepEqual(service.exportAIConversation(actor, original.conversationId), exported);
});
test("DCC-006 AI import hides another user's jobs and refuses revoked source writes", async () => {
  const binding = source(), job = await preview(binding);
  assert.throws(() => jobs.getAIImport(other, job.id), { code: "AI_IMPORT_NOT_FOUND" });
  assert.equal(jobs.listAIImports(other).items.length, 0);
  service.revokeAIMemorySource(actor, binding.id);
  assert.throws(() => jobs.startAIImport(actor, job.id, job.previewDigest), { code: "AI_SOURCE_NOT_AUTHORIZED" });
  await assert.rejects(preview(binding), { code: "AI_SOURCE_NOT_AUTHORIZED" });
  assert.equal(service.listAIConversations(actor, { sourceId: binding.id }).total, 0);
});
test("AI import cancellation preserves completed work and retry resumes only unsaved records", async () => {
  const binding = source(), job = await preview(binding, data(20));
  jobs.startAIImport(actor, job.id, job.previewDigest); await yieldEventLoop(); await yieldEventLoop(); jobs.cancelAIImport(actor, job.id);
  const cancelled = await finish(job.id); assert.equal(cancelled.status, "CANCELLED"); assert.ok(cancelled.counts.saved > 0 && cancelled.counts.saved < 20);
  assert.equal(service.listAIConversations(actor, { sourceId: binding.id }).total, cancelled.counts.saved);
  // Wait for the cancelled worker to relinquish its lease before explicitly retrying.
  await yieldEventLoop(); await yieldEventLoop();
  jobs.startAIImport(actor, job.id, job.previewDigest, true);
  assert.equal((await finish(job.id)).counts.saved, 20);
  assert.equal(service.listAIConversations(actor, { sourceId: binding.id }).total, 20);
});
test("DCC-006 AI import rechecks token scope, expiry, revocation and notebook grants", async () => {
  const binding = source(), tokenId = crypto.randomUUID(), tokenActor = { ...actor, tokenId };
  db.prepare("INSERT INTO api_tokens(id,userId,name,tokenHash,scopes,resourceMode) VALUES (?,?,'import test',?,?,'restricted')")
    .run(tokenId, actor.userId, crypto.randomUUID(), JSON.stringify(["notes:read", "notes:write"]));
  db.prepare("INSERT INTO api_token_resources(tokenId,resourceType,resourceId,permission,includeDescendants) VALUES (?,'notebook',?,'write',0)").run(tokenId, binding.notebookId);
  const input = () => ({ sourceId: binding.id, filename: "transcript.json", body: new Blob([data()]).stream() });
  await assert.rejects(jobs.previewAIImport(tokenActor, input()), { code: "API_TOKEN_SCOPE_REQUIRED" });
  db.prepare("UPDATE api_tokens SET scopes=? WHERE id=?").run(JSON.stringify(["notes:read", "notes:write", "export:import"]), tokenId);
  const job = await jobs.previewAIImport(tokenActor, input());
  assert.throws(() => jobs.getAIImport(actor, job.id), { code: "AI_IMPORT_NOT_FOUND" });
  db.prepare("UPDATE api_tokens SET expiresAt='2000-01-01T00:00:00Z' WHERE id=?").run(tokenId);
  assert.throws(() => jobs.startAIImport(tokenActor, job.id, job.previewDigest), { code: "AI_CONTEXT_SCOPE_DENIED" });
  db.prepare("UPDATE api_tokens SET expiresAt=NULL,revokedAt=datetime('now') WHERE id=?").run(tokenId);
  assert.throws(() => jobs.getAIImport(tokenActor, job.id), { code: "AI_CONTEXT_SCOPE_DENIED" });
  db.prepare("UPDATE api_tokens SET revokedAt=NULL WHERE id=?").run(tokenId);
  db.prepare("DELETE FROM api_token_resources WHERE tokenId=?").run(tokenId);
  assert.throws(() => jobs.getAIImport(tokenActor, job.id), { code: "API_TOKEN_RESOURCE_DENIED" });
  db.prepare("INSERT INTO api_token_resources(tokenId,resourceType,resourceId,permission,includeDescendants) VALUES (?,'notebook',?,'write',0)").run(tokenId, binding.notebookId);
  jobs.discardAIImport(tokenActor, job.id);
});
test("DCC-004 AI import preserves a conversation revised after preview and reports conflict", async () => {
  const binding = source(), initial = await preview(binding); jobs.startAIImport(actor, initial.id, initial.previewDigest); await finish(initial.id);
  const staged = await preview(binding, data(1, "Imported stale revision"));
  const existing = service.listAIConversations(actor, { sourceId: binding.id }).items[0];
  service.ingestAIConversation(actor, { sourceId: binding.id, operationId: crypto.randomUUID(), expectedRevision: existing.revision, snapshot: {
    provider: binding.provider, accountScope: binding.accountScope, externalConversationId: "conversation-0", title: "Conversation 0", sourceUrl: "",
    messages: [{ externalMessageId: "message-1", localSequence: 0, role: "user", text: "Newer confirmed copy", blocks: [{ type: "markdown", text: "Newer confirmed copy" }], captureState: "stable" }], completeness: "unknown", capturedAt: new Date().toISOString(),
  } });
  jobs.startAIImport(actor, staged.id, staged.previewDigest); const result = await finish(staged.id);
  assert.equal(result.items[0].error, "AI_SYNC_VERSION_CONFLICT");
  assert.equal(service.getAIConversationMessages(actor, existing.id).items[0].text, "Newer confirmed copy");
});
test("AI import upload errors and quota rejection never create visible archives", async () => {
  const binding = source();
  await assert.rejects(preview(binding, "{bad}"), { code: "AI_IMPORT_INVALID_JSON" });
  assert.equal(jobs.listAIImports(actor).items.length, 0);
  for (let index = 0; index < 3; index++) await preview(binding);
  await assert.rejects(preview(binding), { code: "AI_IMPORT_QUOTA" });
  assert.equal(service.listAIConversations(actor, { sourceId: binding.id }).total, 0);
});
