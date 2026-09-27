import assert from "node:assert/strict";
import test from "node:test";
import { SyncRemoteClient } from "../src/sync/remote.js";

function clientFor(routePayload: Record<string, unknown>): SyncRemoteClient {
  return new SyncRemoteClient(
    { serverUrl: "http://sync.example", token: "test-token" },
    { fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => routePayload,
      text: async () => JSON.stringify(routePayload),
    }) },
  );
}

test("unknown change-feed entity fails before the cursor can be accepted", async () => {
  const client = clientFor({
    nextSequence: 42,
    items: [{ sequence: 42, entityType: "knowledge_tree_node", entityId: "note:n1", operation: "upsert" }],
  });
  await assert.rejects(client.changes(41), /不支持的同步实体/);
});

test("unknown snapshot entity fails before bootstrap can acknowledge it", async () => {
  const client = clientFor({
    snapshotSequence: 42,
    hasMore: false,
    nextCursor: null,
    items: [{ entityType: "knowledge_tree_node", entityId: "note:n1", payload: {} }],
  });
  await assert.rejects(client.snapshot(null, 42), /不支持的同步实体/);
});

test("known entities still pass while unknown operations fail closed", async () => {
  const known = clientFor({
    nextSequence: 7,
    items: [{ sequence: 7, entityType: "mindmap", entityId: "m1", operation: "upsert" }],
  });
  assert.equal((await known.changes(6)).items[0].entityType, "mindmap");

  const unknown = clientFor({
    nextSequence: 8,
    items: [{ sequence: 8, entityType: "mindmap", entityId: "m1", operation: "relocate" }],
  });
  await assert.rejects(unknown.changes(7), /远端同步操作无效/);
});
