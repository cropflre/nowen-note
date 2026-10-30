import assert from "node:assert/strict";
import test from "node:test";
import { treeMutationRevision, treeMutationPreconditions, type TreeMutationNode } from "./tree-mutation.js";

const nodes: TreeMutationNode[] = [
  {
    id: "notebook:a", parentId: null, resourceType: "notebook", resourceId: "a",
    title: "A", updatedAt: "2026-10-16T09:00:00Z", isDeleted: 0, childCount: 2,
  },
  {
    id: "note:a1", parentId: "notebook:a", resourceType: "note", resourceId: "a1",
    title: "First", updatedAt: "2026-10-16T09:00:00Z", isDeleted: 0, childCount: 0,
  },
  {
    id: "notebook:b", parentId: "notebook:a", resourceType: "notebook", resourceId: "b",
    title: "B", updatedAt: "2026-10-16T09:00:00Z", isDeleted: 0, childCount: 1,
  },
  {
    id: "note:b1", parentId: "notebook:b", resourceType: "note", resourceId: "b1",
    title: "Nested", updatedAt: "2026-10-16T09:00:00Z", isDeleted: 0, childCount: 0,
  },
];

test("tree revision ignores input ordering", () => {
  assert.equal(treeMutationRevision(nodes, "notebook:a", true),
    treeMutationRevision([...nodes].reverse(), "notebook:a", true));
});

test("subtree revision detects nested changes that direct revision does not", () => {
  const modified = nodes.map((node) => node.id === "note:b1" ? { ...node, title: "Renamed" } : node);
  assert.equal(treeMutationRevision(nodes, "notebook:a"),
    treeMutationRevision(modified, "notebook:a"));
  assert.notEqual(treeMutationRevision(nodes, "notebook:a", true),
    treeMutationRevision(modified, "notebook:a", true));
});

test("tree revision detects moves, deletions, and directory metadata edits", () => {
  for (const change of [
    { parentId: null }, { isDeleted: 1 }, { updatedAt: "new" }, { title: "Edited" },
  ]) {
    const changed = nodes.map((node) => node.id === "note:b1" ? { ...node, ...change } : node);
    assert.notEqual(treeMutationRevision(nodes, "notebook:a", true),
      treeMutationRevision(changed, "notebook:a", true));
  }
});

test("preconditions retain nullable parent IDs and explicit child count", () => {
  assert.deepEqual(treeMutationPreconditions(nodes[0], "abcd"), {
    expectedUpdatedAt: nodes[0].updatedAt,
    expectedTitle: "A",
    expectedParentId: null,
    expectedChildCount: 2,
    expectedSubtreeRevision: "abcd",
  });
  assert.throws(() => treeMutationRevision(nodes, "missing"), /节点不存在/);
});
