import assert from "node:assert/strict";
import test from "node:test";
import {
  assertEntitySyncReady,
  PLANNED_SYNC_ENTITIES,
  SYNC_ENTITY_CAPABILITIES,
} from "../src/sync/entities.js";
import { SYNC_ENTITY_TYPES, SYNC_V2_LEGACY_ENTITY_TYPES } from "../src/sync/types.js";

test("Sync V2 runtime entity types match the complete capability registry", () => {
  assert.deepEqual(
    SYNC_ENTITY_CAPABILITIES.map((item) => item.entityType),
    [...SYNC_ENTITY_TYPES],
  );
  for (const entityType of SYNC_ENTITY_TYPES) {
    assert.doesNotThrow(() => assertEntitySyncReady(entityType));
  }
});

test("knowledge tree structure cannot enter Sync V2 before all seven links are ready", () => {
  const tree = PLANNED_SYNC_ENTITIES.find((item) => item.entityType === "knowledge_tree_node");
  assert.ok(tree);
  assert.equal(tree.changeFeed, true);
  assert.equal(tree.outbox, false);
  assert.equal(SYNC_ENTITY_TYPES.includes("knowledge_tree_node" as never), false);
  assert.throws(() => assertEntitySyncReady("knowledge_tree_node"), /尚未完成同步接入/);
});

test("unnegotiated V2 clients retain the original ten-entity baseline", () => {
  assert.deepEqual(SYNC_V2_LEGACY_ENTITY_TYPES, [
    "notebook", "note", "tag", "note_tag", "favorite", "attachment",
    "task", "task_reminder", "diary", "mindmap",
  ]);
});
