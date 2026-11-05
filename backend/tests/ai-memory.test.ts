import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { before } from "node:test";
import { Hono } from "hono";
import Database from "better-sqlite3";
import { aiMemoryMigration } from "../src/db/aiMemoryMigration";

let db: ReturnType<typeof import("../src/db/schema")["getDb"]>;
let service: typeof import("../src/services/aiMemoryService");
let router: typeof import("../src/routes/ai-memory")["default"];
const actor = { userId: "archive-owner" }, other = { userId: "archive-other" };
before(async () => {
  await import("../src/runtime/knowledge-tree-migration-bootstrap");
  db = (await import("../src/db/schema")).getDb();
  (await import("../src/lib/api-tokens")).initApiTokensTable(db);
  service = await import("../src/services/aiMemoryService");
  router = (await import("../src/routes/ai-memory")).default;
  for (const user of [actor, other]) db.prepare("INSERT INTO users(id,username,passwordHash) VALUES (?,?,'fixture')").run(user.userId, user.userId);
});
function source(extra = {}) {
  const notebookId = crypto.randomUUID();
  db.prepare("INSERT INTO notebooks(id,userId,name) VALUES (?,?,'AI archive fixture')").run(notebookId, actor.userId);
  return service.createAIMemorySource(actor, { provider: "chatgpt", accountScope: crypto.randomUUID(), notebookId, permissionState: "granted", ...extra });
}
function message(externalMessageId: string, text: string, localSequence = 0, captureState = "stable") {
  return { externalMessageId, localSequence, text, role: "assistant", blocks: [{ type: "markdown", text }], captureState };
}
function capture(binding: ReturnType<typeof source>, entries = [message("msg-1", "Original response")], extra: Record<string, unknown> = {}) {
  return { sourceId: binding.id, operationId: crypto.randomUUID(), snapshot: { provider: binding.provider, accountScope: binding.accountScope, externalConversationId: "conversation-1", title: "Project context", sourceUrl: "https://chatgpt.com/c/conversation-1", messages: entries, completeness: "partial", capturedAt: new Date().toISOString() }, ...extra };
}
function code(expected: string) { return (error: unknown) => { assert.equal((error as { code: string }).code, expected); return true; }; }

test("archive migration is additive, transactional and preserves legacy notes", () => {
  const legacy = new Database(":memory:");
  legacy.exec("CREATE TABLE users(id TEXT PRIMARY KEY); CREATE TABLE notebooks(id TEXT PRIMARY KEY); CREATE TABLE notes(id TEXT PRIMARY KEY,content TEXT); INSERT INTO notes VALUES ('old','old content');");
  legacy.transaction(() => aiMemoryMigration.up(legacy))();
  assert.equal((legacy.prepare("SELECT content FROM notes").get() as { content: string }).content, "old content");
  assert.ok(legacy.prepare("SELECT 1 FROM sqlite_master WHERE name='external_ai_message_revisions'").get());
  assert.deepEqual(legacy.pragma("foreign_key_check"), []);
  legacy.close();
});

test("DCC-001 archive receipts are idempotent and require persisted matching operations", () => {
  const binding = source(), request = capture(binding);
  const saved = service.ingestAIConversation(actor, request);
  assert.equal(saved.persisted, true); assert.equal(saved.revision, 1); assert.equal(saved.status, "applied");
  assert.ok(saved.noteId); assert.equal(service.getAIConversationMessages(actor, saved.conversationId).items[0].text, "Original response");
  assert.equal(service.ingestAIConversation(actor, request).status, "duplicate");
  assert.equal(service.ingestAIConversation(actor, { ...request, operationId: crypto.randomUUID() }).status, "duplicate");
  assert.equal(service.listAIConversations(actor, { sourceId: binding.id }).total, 1);
  assert.throws(() => service.ingestAIConversation(actor, { ...request, snapshot: { ...request.snapshot, title: "Altered payload" } }), code("AI_SYNC_OPERATION_CONFLICT"));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ai_conversation_sync_operations WHERE sourceId=?").get(binding.id)!.n, 2);
});

test("DCC-004 archive updates retain message revisions and reject stale snapshots", () => {
  const binding = source(), first = service.ingestAIConversation(actor, capture(binding));
  const next = capture(binding, [message("msg-1", "Revised reply"), message("msg-2", "New reply", 1)], { expectedRevision: first.revision });
  const saved = service.ingestAIConversation(actor, next);
  assert.equal(saved.revision, 2);
  assert.deepEqual(service.getAIConversationMessages(actor, saved.conversationId).items.map(item => item.text), ["Revised reply", "New reply"]);
  assert.equal((db.prepare("SELECT contentText FROM external_ai_message_revisions").get() as { contentText: string }).contentText, "Original response");
  assert.throws(() => service.ingestAIConversation(actor, capture(binding, [message("msg-1", "Stale content")], { expectedRevision: 1 })), code("AI_SYNC_VERSION_CONFLICT"));
  assert.equal(service.getAIConversation(actor, saved.conversationId).revision, 2);
});

test("DCC-007 partial snapshots append without deleting absent messages or persisting streaming tokens", () => {
  const binding = source({ captureEnabled: true });
  const first = service.ingestAIConversation(actor, capture(binding, [message("msg-1", "First"), message("msg-2", "Second", 1)]));
  const second = service.ingestAIConversation(actor, capture(binding, [message("msg-2", "Second"), message("msg-3", "Third", 1), message("msg-4", "streaming only", 2, "streaming")], { expectedRevision: first.revision, mode: "automatic" }));
  assert.deepEqual(service.getAIConversationMessages(actor, second.conversationId).items.map(item => item.text), ["First", "Second", "Third"]);
  assert.equal(second.completeness, "partial");
  assert.equal(service.getAIConversationMessages(actor, second.conversationId).items.length, 3);
});

test("DCC-006 archive source and conversation access rejects foreign users, notebook grants and revoked sources", () => {
  const binding = source(), saved = service.ingestAIConversation(actor, capture(binding));
  assert.throws(() => service.getAIMemorySource(other, binding.id), code("AI_SOURCE_NOT_FOUND"));
  assert.throws(() => service.getAIConversation(other, saved.conversationId), code("AI_CONVERSATION_NOT_FOUND"));
  assert.throws(() => service.ingestAIConversation(actor, capture(binding, undefined, { mode: "automatic" })), code("AI_CAPTURE_PAUSED"));
  const tokenId = crypto.randomUUID();
  db.prepare("INSERT INTO api_tokens(id,userId,name,tokenHash,scopes,resourceMode) VALUES (?,?,'fixture',?,?,'restricted')")
    .run(tokenId, actor.userId, crypto.randomUUID(), JSON.stringify(["notes:read", "notes:write"]));
  assert.throws(() => service.getAIConversation({ ...actor, tokenId }, saved.conversationId), code("API_TOKEN_RESOURCE_DENIED"));
  db.prepare("INSERT INTO api_token_resources(tokenId,resourceType,resourceId,permission,includeDescendants) VALUES (?,'notebook',?,'read',0)").run(tokenId, binding.notebookId);
  assert.equal(service.getAIConversation({ ...actor, tokenId }, saved.conversationId).id, saved.conversationId);
  assert.throws(() => service.assertAIMemoryImportAccess({ ...actor, tokenId }, binding.id), code("API_TOKEN_SCOPE_REQUIRED"));
  assert.throws(() => service.ingestAIConversation({ ...actor, tokenId }, capture(binding)), code("API_TOKEN_RESOURCE_DENIED"));
  service.revokeAIMemorySource(actor, binding.id);
  assert.throws(() => service.ingestAIConversation(actor, capture(binding)), code("AI_SOURCE_NOT_AUTHORIZED"));
});

test("DCC-004 edited projection remains unchanged while raw revisions persist and rebuild creates a copy", () => {
  const binding = source(), first = service.ingestAIConversation(actor, capture(binding));
  db.prepare("UPDATE notes SET content='User edits remain',version=version+1 WHERE id=?").run(first.noteId);
  const updated = service.ingestAIConversation(actor, capture(binding, [message("msg-1", "New archived evidence")], { expectedRevision: first.revision }));
  assert.equal(updated.projectionStatus, "conflict");
  assert.equal((db.prepare("SELECT content FROM notes WHERE id=?").get(first.noteId) as { content: string }).content, "User edits remain");
  assert.equal(service.getAIConversationMessages(actor, updated.conversationId).items[0].text, "New archived evidence");
  const rebuilt = service.rebuildAIConversationNote(actor, first.conversationId);
  assert.notEqual(rebuilt.noteId, first.noteId);
  assert.match((db.prepare("SELECT content FROM notes WHERE id=?").get(rebuilt.noteId) as { content: string }).content, /New archived evidence/);
  assert.equal((db.prepare("SELECT content FROM notes WHERE id=?").get(first.noteId) as { content: string }).content, "User edits remain");
});

test("archive transaction rollback cannot leave a note, message or successful receipt", () => {
  const binding = source();
  const before = (db.prepare("SELECT COUNT(*) AS n FROM notes").get() as { n: number }).n;
  db.exec("CREATE TRIGGER reject_archive_receipt BEFORE INSERT ON ai_conversation_sync_operations BEGIN SELECT RAISE(ABORT,'forced archive transaction failure'); END;");
  try { assert.throws(() => service.ingestAIConversation(actor, capture(binding)), /forced archive transaction failure/); }
  finally { db.exec("DROP TRIGGER reject_archive_receipt"); }
  assert.equal(service.listAIConversations(actor, { sourceId: binding.id }).total, 0);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM notes").get() as { n: number }).n, before);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM ai_conversation_sync_operations WHERE sourceId=?").get(binding.id) as { n: number }).n, 0);
});

test("DCC-004 an opened Yjs projection and its pending editor state cannot be overwritten by archive updates", async () => {
  const binding = source(), first = service.ingestAIConversation(actor, capture(binding));
  const { yJoin, yLeave, yDestroyDoc } = await import("../src/services/yjs");
  const original = (db.prepare("SELECT content FROM notes WHERE id=?").get(first.noteId) as { content: string }).content;
  yJoin(first.noteId, actor.userId);
  try {
    const saved = service.ingestAIConversation(actor, capture(binding, [message("msg-1", "New raw transcript")], { expectedRevision: first.revision }));
    assert.equal(saved.projectionStatus, "conflict");
    assert.equal((db.prepare("SELECT content FROM notes WHERE id=?").get(first.noteId) as { content: string }).content, original);
    assert.equal(service.getAIConversationMessages(actor, first.conversationId).items[0].text, "New raw transcript");
  } finally { yLeave(first.noteId); yDestroyDoc(first.noteId); }
});

test("DCC-007 archive deletion uses trash, rejects resurrection and explicitly restores raw messages", () => {
  const binding = source(), request = capture(binding), first = service.ingestAIConversation(actor, request);
  const deleted = service.deleteAIConversation(actor, first.conversationId);
  assert.equal(deleted.thirdPartyOriginalDeleted, false); assert.equal(deleted.projectionPreserved, false);
  assert.equal((db.prepare("SELECT isTrashed FROM notes WHERE id=?").get(first.noteId) as { isTrashed: number }).isTrashed, 1);
  assert.equal(service.listAIConversations(actor, { sourceId: binding.id }).total, 0);
  assert.throws(() => service.ingestAIConversation(actor, capture(binding)), code("AI_CONVERSATION_DELETED"));
  assert.throws(() => service.ingestAIConversation(actor, request), code("AI_CONVERSATION_DELETED"));
  service.restoreAIConversation(actor, first.conversationId);
  assert.equal(service.getAIConversationMessages(actor, first.conversationId).items.length, 1);
  assert.equal((db.prepare("SELECT isTrashed FROM notes WHERE id=?").get(first.noteId) as { isTrashed: number }).isTrashed, 0);
});

test("manual inferred message identities reject automatic capture and ambiguous later changes", () => {
  const binding = source({ captureEnabled: true }), request = capture(binding);
  delete (request.snapshot.messages[0] as { externalMessageId?: string }).externalMessageId;
  assert.throws(() => service.ingestAIConversation(actor, { ...request, mode: "automatic" }), code("AI_MESSAGE_IDENTITY_AMBIGUOUS"));
  const first = service.ingestAIConversation(actor, request);
  assert.equal(service.ingestAIConversation(actor, { ...request, operationId: crypto.randomUUID() }).status, "duplicate");
  assert.throws(() => service.ingestAIConversation(actor, { ...capture(binding), expectedRevision: first.revision }), code("AI_MESSAGE_IDENTITY_AMBIGUOUS"));
  const repeatedSource = source(), repeated = capture(repeatedSource, [message("inferred:first", "Same message"), message("inferred:second", "Same message", 1)]);
  const repeatedSave = service.ingestAIConversation(actor, repeated);
  assert.equal(service.getAIConversationMessages(actor, repeatedSave.conversationId).items.length, 2);
});

test("archive ordering rejects loaded historical prefixes, branch reorder and unanchored inserts", () => {
  const binding = source(), first = service.ingestAIConversation(actor, capture(binding, [message("msg-1", "First"), message("msg-2", "Second", 1)]));
  for (const entries of [
    [message("older", "Previously unloaded"), message("msg-1", "First", 1), message("msg-2", "Second", 2)],
    [message("msg-2", "Second"), message("msg-1", "First", 1)],
    [message("msg-1", "First"), message("inserted", "Between existing messages", 1)],
    [message("no-anchor", "Unknown position")],
  ]) assert.throws(() => service.ingestAIConversation(actor, capture(binding, entries, { expectedRevision: first.revision })), code("AI_MESSAGE_ORDER_CONFLICT"));
  assert.deepEqual(service.getAIConversationMessages(actor, first.conversationId).items.map(item => item.text), ["First", "Second"]);
});

test("archive cannot expose protected projections through rebuild, reads or later capture", () => {
  const binding = source(), first = service.ingestAIConversation(actor, capture(binding));
  db.prepare("UPDATE notes SET isLocked=1 WHERE id=?").run(first.noteId);
  assert.throws(() => service.rebuildAIConversationNote(actor, first.conversationId), code("AI_CONTEXT_SCOPE_DENIED"));
  assert.throws(() => service.ingestAIConversation(actor, capture(binding, [message("msg-1", "Update while protected")], { expectedRevision: first.revision })), code("AI_CONTEXT_SCOPE_DENIED"));
  assert.throws(() => service.getAIConversationMessages(actor, first.conversationId), code("AI_CONTEXT_SCOPE_DENIED"));
  assert.equal(service.listAIConversations(actor, { sourceId: binding.id }).total, 0);
  db.prepare("UPDATE notes SET isLocked=0 WHERE id=?").run(first.noteId);
  const tokenId = crypto.randomUUID(), movedId = crypto.randomUUID();
  db.prepare("INSERT INTO api_tokens(id,userId,name,tokenHash,scopes,resourceMode) VALUES (?,?,'fixture',?,?,'restricted')").run(tokenId, actor.userId, crypto.randomUUID(), JSON.stringify(["notes:read", "notes:write"]));
  db.prepare("INSERT INTO api_token_resources(tokenId,resourceType,resourceId,permission,includeDescendants) VALUES (?,'notebook',?,'write',0)").run(tokenId, binding.notebookId);
  db.prepare("INSERT INTO notebooks(id,userId,name) VALUES (?,?,'Moved destination')").run(movedId, actor.userId);
  db.prepare("UPDATE notes SET notebookId=? WHERE id=?").run(movedId, first.noteId);
  assert.throws(() => service.rebuildAIConversationNote({ ...actor, tokenId }, first.conversationId), code("API_TOKEN_RESOURCE_DENIED"));
  db.prepare("UPDATE notes SET notebookId=? WHERE id=?").run(binding.notebookId, first.noteId);
  db.prepare("INSERT INTO notebook_passwords(notebookId,passwordHash) VALUES (?,'protected')").run(binding.notebookId);
  assert.throws(() => service.getAIConversationMessages(actor, first.conversationId), code("AI_CONTEXT_SCOPE_DENIED"));
});

test("archive projection preserves code syntax and source blocks without executing HTML", () => {
  const binding = source(), request = capture(binding);
  request.snapshot.messages[0].blocks = [{ type: "code", text: '<script>alert("example")</script>\nconst a = 1 < 2;', language: "typescript" } as never];
  const saved = service.ingestAIConversation(actor, request);
  const content = (db.prepare("SELECT content FROM notes WHERE id=?").get(saved.noteId) as { content: string }).content;
  assert.match(content, /```typescript\n<script>alert\("example"\)<\/script>\nconst a = 1 < 2;\n```/);
  assert.deepEqual(service.getAIConversationMessages(actor, saved.conversationId).items[0].blocks, request.snapshot.messages[0].blocks);
});

test("DCC-007 a permanently removed projection is not silently recreated by capture or rebuild", () => {
  const binding = source(), first = service.ingestAIConversation(actor, capture(binding));
  // The FK's ON DELETE SET NULL is the state left by the existing permanent-delete lifecycle.
  db.prepare("UPDATE external_ai_conversations SET noteId=NULL WHERE id=?").run(first.conversationId);
  const before = (db.prepare("SELECT COUNT(*) AS n FROM notes").get() as { n: number }).n;
  assert.throws(() => service.ingestAIConversation(actor, capture(binding, [message("msg-1", "Do not resurrect")], { expectedRevision: first.revision })), code("AI_CONTEXT_SCOPE_DENIED"));
  assert.throws(() => service.rebuildAIConversationNote(actor, first.conversationId), code("AI_CONTEXT_SCOPE_DENIED"));
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM notes").get() as { n: number }).n, before);
});

test("DCC-006 deleted archive listings still enforce projection protection and the current token notebook grant", () => {
  const binding = source(), first = service.ingestAIConversation(actor, capture(binding));
  service.deleteAIConversation(actor, first.conversationId);
  assert.equal(service.listAIConversations(actor, { sourceId: binding.id, includeDeleted: true }).total, 1);
  db.prepare("UPDATE notes SET isLocked=1 WHERE id=?").run(first.noteId);
  assert.equal(service.listAIConversations(actor, { sourceId: binding.id, includeDeleted: true }).total, 0);
  db.prepare("UPDATE notes SET isLocked=0 WHERE id=?").run(first.noteId);
  const tokenId = crypto.randomUUID(), destination = crypto.randomUUID();
  db.prepare("INSERT INTO api_tokens(id,userId,name,tokenHash,scopes,resourceMode) VALUES (?,?,'fixture',?,?,'restricted')").run(tokenId, actor.userId, crypto.randomUUID(), JSON.stringify(["notes:read", "notes:write"]));
  db.prepare("INSERT INTO api_token_resources(tokenId,resourceType,resourceId,permission,includeDescendants) VALUES (?,'notebook',?,'write',0)").run(tokenId, binding.notebookId);
  db.prepare("INSERT INTO notebooks(id,userId,name) VALUES (?,?,'Private destination')").run(destination, actor.userId);
  db.prepare("UPDATE notes SET notebookId=? WHERE id=?").run(destination, first.noteId);
  assert.equal(service.listAIConversations({ ...actor, tokenId }, { sourceId: binding.id, includeDeleted: true }).total, 0);
});

test("DCC-007 permanent notebook deletion removes its archive graph and preserves a moved edited projection", async () => {
  const { deleteKnowledgeNode, moveKnowledgeNode } = await import("../src/services/knowledgeTree");
  const { permanentlyDeleteTrashItem } = await import("../src/services/trash/trashService");
  const binding = source(), first = service.ingestAIConversation(actor, capture(binding));
  const destination = crypto.randomUUID();
  db.prepare("INSERT INTO notebooks(id,userId,name) VALUES (?,?,'Retained user copy')").run(destination, actor.userId);
  moveKnowledgeNode({ actorUserId: actor.userId, nodeId: `note:${first.noteId}`, parentId: `notebook:${destination}`, db });
  db.prepare("UPDATE notes SET content='Retained moved edits' WHERE id=?").run(first.noteId);
  service.revokeAIMemorySource(actor, binding.id);
  deleteKnowledgeNode({ actorUserId: actor.userId, nodeId: `notebook:${binding.notebookId}`, mode: "subtree", db });
  permanentlyDeleteTrashItem({ userId: actor.userId, workspaceId: null }, `notebook:${binding.notebookId}`);
  assert.equal(db.prepare("SELECT 1 FROM notebooks WHERE id=?").get(binding.notebookId), undefined);
  for (const table of ["external_ai_sources", "external_ai_conversations", "external_ai_messages", "ai_conversation_sync_operations"]) {
    const key = table === "external_ai_sources" ? "id" : table === "external_ai_messages" ? "conversationId" : "sourceId";
    assert.equal(db.prepare(`SELECT 1 FROM ${table} WHERE ${key}=?`).get(key === "conversationId" ? first.conversationId : binding.id), undefined);
  }
  assert.equal((db.prepare("SELECT content FROM notes WHERE id=?").get(first.noteId) as { content: string }).content, "Retained moved edits");
  const empty = source(); service.revokeAIMemorySource(actor, empty.id);
  deleteKnowledgeNode({ actorUserId: actor.userId, nodeId: `notebook:${empty.notebookId}`, mode: "subtree", db });
  permanentlyDeleteTrashItem({ userId: actor.userId, workspaceId: null }, `notebook:${empty.notebookId}`);
  assert.equal(db.prepare("SELECT 1 FROM external_ai_sources WHERE id=?").get(empty.id), undefined);
});

test("DCC-006 admin transfer refuses unsupported archive ownership changes without losing any data", async () => {
  const { default: users } = await import("../src/routes/users");
  const { signSudoToken } = await import("../src/lib/auth-security");
  const administrator = `archive-admin-${crypto.randomUUID()}`;
  db.prepare("INSERT INTO users(id,username,passwordHash,role) VALUES (?,?,'fixture','admin')").run(administrator, administrator);
  const app = new Hono();
  app.use("*", async (context, next) => { context.req.raw.headers.set("X-User-Id", administrator); return next(); });
  app.route("/api/users", users);
  const transfer = (from: string, to: string) => app.request(`/api/users/${from}?transferTo=${to}`, { method: "DELETE", headers: { "X-Sudo-Token": signSudoToken(administrator, 0) } });
  const make = () => {
    const owner = `archive-transfer-${crypto.randomUUID()}`, receiver = `archive-receiver-${crypto.randomUUID()}`, notebookId = crypto.randomUUID();
    for (const user of [owner, receiver]) db.prepare("INSERT INTO users(id,username,passwordHash) VALUES (?,?,'fixture')").run(user, user);
    db.prepare("INSERT INTO notebooks(id,userId,name) VALUES (?,?,'Transferred archive')").run(notebookId, owner);
    const binding = service.createAIMemorySource({ userId: owner }, { provider: "chatgpt", accountScope: "transfer-account", notebookId, permissionState: "granted", captureEnabled: true });
    const saved = service.ingestAIConversation({ userId: owner }, capture(binding));
    return { owner, receiver, binding, saved };
  };
  const good = make();
  const response = await transfer(good.owner, good.receiver);
  assert.equal(response.status, 409);
  assert.equal((await response.json() as { code: string }).code, "AI_ARCHIVE_TRANSFER_REQUIRES_EXPORT");
  assert.ok(db.prepare("SELECT 1 FROM users WHERE id=?").get(good.owner));
  assert.equal(service.getAIConversationMessages({ userId: good.owner }, good.saved.conversationId).items[0].text, "Original response");
  assert.equal(service.listAIMemorySources({ userId: good.receiver }).items.length, 0);
  assert.equal((db.prepare("SELECT userId FROM notebooks WHERE id=?").get(good.binding.notebookId) as { userId: string }).userId, good.owner);
});

test("HTTP archive route rejects unauthenticated, malformed, oversized and missing token scope requests", async () => {
  const app = new Hono();
  app.route("/api/ai-memory", router);
  assert.equal((await app.request("/api/ai-memory/sources")).status, 401);
  const authenticated = new Hono();
  authenticated.use("*", async (context, next) => { context.req.raw.headers.set("X-User-Id", actor.userId); return next(); });
  authenticated.route("/api/ai-memory", router);
  assert.equal((await authenticated.request("/api/ai-memory/conversations/ingest", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" })).status, 400);
  assert.equal((await authenticated.request("/api/ai-memory/conversations/ingest", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ oversized: "x".repeat(4 * 1024 * 1024) }) })).status, 413);
  const { enforceApiTokenAccess } = await import("../src/middleware/api-token-resource-scope");
  const scoped = new Hono();
  scoped.use("*", async (context, next) => {
    for (const [name, value] of Object.entries({ "X-User-Id": actor.userId, "X-Auth-Mode": "api-token", "X-Api-Token-Id": "fixture", "X-Api-Resource-Mode": "unrestricted", "X-Api-Scopes": "tasks:read" })) context.req.raw.headers.set(name, value);
    return enforceApiTokenAccess(context, next);
  });
  scoped.route("/api/ai-memory", router);
  assert.equal((await scoped.request("/api/ai-memory/sources")).status, 403);
});

test("DCC-002 archive note projection enters existing Sync V2 outbox in the same transaction", async () => {
  const { createProfile, switchActiveProfile, disableAllProfiles } = await import("../src/sync/profile");
  const { ensureDevice } = await import("../src/sync/device");
  const { listPendingMutations } = await import("../src/sync/outbox");
  const profile = createProfile(db, { name: "AI archive sync fixture", serverUrl: "https://sync.invalid", remoteUserId: actor.userId });
  switchActiveProfile(db, profile.id);
  db.prepare("UPDATE sync_profiles SET bootstrapStatus='ready',bootstrapReadyAt=datetime('now') WHERE id=?").run(profile.id);
  ensureDevice(db, { profileId: profile.id, platform: "test" });
  try {
    const binding = source(), saved = service.ingestAIConversation(actor, capture(binding));
    const mutation = listPendingMutations(db, 100, profile.id).filter(item => item.entityType === "note" && item.entityId === saved.noteId).at(-1);
    assert.ok(mutation, "the projection must use existing business-write outbox capture");
    assert.match(mutation.payload, /Original response/);
    assert.ok(listPendingMutations(db, 100, profile.id).every(item => !String(item.entityType).startsWith("external_ai")), "raw archives do not silently claim Sync V2 support");
  } finally { disableAllProfiles(db); }
});
