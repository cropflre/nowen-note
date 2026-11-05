import assert from "node:assert/strict";
import test from "node:test";
import { acknowledgeArchive, archiveScope, emptyAIState, enqueueArchive, failPending, MAX_QUEUE_BYTES, validateReceipt, type PendingArchive } from "../src/ai-conversations/queue";
import type { ArchiveReceipt } from "../src/ai-conversations/types";

function pending(id = "op-1"): PendingArchive {
  return { id, grantKey: "grant", scope: "server-user-a", attempts: 0, queuedAt: 1000, nextAttemptAt: 0,
    payload: { sourceId: "source-a", operationId: id, expectedRevision: 0, mode: "manual", snapshot: { provider: "chatgpt", accountScope: "account-a", externalConversationId: "c-a", title: "Test", sourceUrl: "https://chatgpt.com/c/c-a", messages: [], completeness: "partial", capturedAt: "2026-11-05T00:00:00.000Z" } } };
}
function receipt(item: PendingArchive): ArchiveReceipt {
  return { operationId: item.payload.operationId, sourceId: "source-a", conversationId: "archive-a", noteId: "note-a", revision: 1, status: "applied", persisted: true, persistedAt: "2026-11-05T00:00:00.000Z", projectionStatus: "updated" };
}
function stateWithGrant() {
  const state = emptyAIState();
  state.grants.grant = { scope: "server-user-a", provider: "chatgpt", externalConversationId: "c-a", sourceUrl: "https://chatgpt.com/c/c-a", accountMarker: null, automatic: true, revision: 0,
    source: { id: "source-a", accountScope: "account-a", notebookId: "notebook-a", provider: "chatgpt", displayName: "Mine", captureEnabled: true, permissionState: "granted" } };
  return state;
}

test("DCC-006: scope retains server path and user case and never inherits another destination", () => {
  const base = { serverUrl: "https://NOTE.example/Path/", userId: "UserA" };
  assert.equal(archiveScope(base), archiveScope({ ...base, serverUrl: "https://note.example/Path" }));
  assert.notEqual(archiveScope(base), archiveScope({ ...base, serverUrl: "https://note.example/path" }));
  assert.notEqual(archiveScope(base), archiveScope({ ...base, userId: "usera" }));
  assert.throws(() => archiveScope({ ...base, userId: "" }), /重新登录/);
});

test("unsent snapshots coalesce; immutable requests and a later successor retain separate operation IDs", () => {
  const state = stateWithGrant();
  const first = pending();
  enqueueArchive(state, first);
  enqueueArchive(state, pending("op-2"));
  assert.deepEqual(state.queue.map((entry) => entry.id), ["op-2"]);
  state.queue[0].started = true;
  enqueueArchive(state, pending("op-3"));
  assert.equal(state.queue[1].payload.expectedRevision, -1);
  enqueueArchive(state, pending("op-4"));
  assert.deepEqual(state.queue.map((entry) => entry.id), ["op-2", "op-4"]);
  assert.equal(state.queue[0].payload.operationId, "op-2");
});

test("DCC-001: only exact durable receipts acknowledge their own queued operation", () => {
  const state = stateWithGrant();
  const first = pending();
  first.started = true;
  enqueueArchive(state, first);
  enqueueArchive(state, pending("op-2"));
  const ack = receipt(first);
  for (const invalid of [{ ...ack, persisted: false }, { ...ack, operationId: "other" }, { ...ack, sourceId: "another-source" }, { ...ack, revision: 0 }, { ...ack, persistedAt: "invalid" }]) {
    assert.equal(validateReceipt(invalid, first), false);
    assert.throws(() => acknowledgeArchive(state, first, invalid as ArchiveReceipt), /AI_SYNC_RECEIPT_INVALID/);
  }
  acknowledgeArchive(state, first, ack);
  assert.deepEqual(state.queue.map((entry) => entry.id), ["op-2"]);
  assert.equal(state.grants.grant.receipt?.revision, 1);
});

test("DCC-003: retries preserve payload and stop after bounded attempts without dropping local content", () => {
  const item = pending();
  const payload = JSON.stringify(item.payload);
  failPending(item, 503, "offline", 1001);
  assert.equal(item.blocked, undefined);
  assert.equal(item.nextAttemptAt, 31001);
  for (let n = 1; n < 8; n += 1) failPending(item, undefined, "offline", 1001);
  assert.equal(item.blocked, "offline");
  assert.equal(JSON.stringify(item.payload), payload);
  const conflict = pending();
  failPending(conflict, 409, "AI_SYNC_VERSION_CONFLICT", 1001);
  assert.equal(conflict.blocked, "AI_SYNC_VERSION_CONFLICT");
  assert.equal(conflict.payload.expectedRevision, 0);
});

test("queue size bounds refuse new data and delayed old-source ACK cannot mutate a rebound grant", () => {
  const state = stateWithGrant();
  enqueueArchive(state, pending());
  const huge = pending("huge");
  huge.payload.snapshot.title = "x".repeat(MAX_QUEUE_BYTES);
  assert.throws(() => enqueueArchive(state, huge), /AI_SYNC_QUEUE_FULL/);
  assert.equal(state.queue[0].id, "op-1");
  state.grants.grant.source.id = "source-b";
  state.grants.grant.source.accountScope = "account-b";
  assert.throws(() => acknowledgeArchive(state, state.queue[0], receipt(state.queue[0])), /AI_CONTEXT_SCOPE_DENIED/);
  assert.equal(state.grants.grant.revision, 0);
});
