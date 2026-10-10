import assert from "node:assert/strict";
import test from "node:test";
import {
  assertEntitySyncReady,
  PLANNED_SYNC_ENTITIES,
  SYNC_ENTITY_CAPABILITIES,
} from "../src/sync/entities.js";
import {
  SYNC_ENTITY_TYPES,
  SYNC_V2_LEGACY_ENTITY_TYPES,
  SYNC_V2_NEGOTIATED_ENTITY_TYPES,
} from "../src/sync/types.js";

test("Sync V2 capability registry covers the negotiated entity set", () => {
  assert.deepEqual(
    SYNC_ENTITY_CAPABILITIES.map((item) => item.entityType),
    [...SYNC_V2_NEGOTIATED_ENTITY_TYPES],
  );
  for (const entityType of SYNC_V2_NEGOTIATED_ENTITY_TYPES) {
    assert.doesNotThrow(() => assertEntitySyncReady(entityType));
  }
});

test("knowledge tree structure is fully wired but remains opt-in for legacy clients", () => {
  const tree = SYNC_ENTITY_CAPABILITIES.find((item) => item.entityType === "knowledge_tree_node");
  assert.ok(tree);
  assert.equal(tree.outbox, true);
  assert.equal(tree.push, true);
  assert.equal(tree.changeFeed, true);
  assert.equal(tree.pull, true);
  assert.equal(tree.apply, true);
  assert.equal(tree.conflictStrategy, true);
  assert.equal(SYNC_ENTITY_TYPES.includes("knowledge_tree_node" as never), false);
  assert.equal(PLANNED_SYNC_ENTITIES.some((item) => item.entityType === "knowledge_tree_node"), false);
});

test("unnegotiated V2 clients retain the original ten-entity baseline", () => {
  assert.deepEqual(SYNC_V2_LEGACY_ENTITY_TYPES, [
    "notebook", "note", "tag", "note_tag", "favorite", "attachment",
    "task", "task_reminder", "diary", "mindmap",
  ]);
  assert.deepEqual(SYNC_V2_NEGOTIATED_ENTITY_TYPES, [
    ...SYNC_V2_LEGACY_ENTITY_TYPES,
    "knowledge_tree_node",
  ]);
});
