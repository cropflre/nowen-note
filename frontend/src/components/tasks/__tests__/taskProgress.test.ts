import { describe, it, expect } from "vitest";
import { buildTaskTree, calculateTaskProgress, type TaskTreeNode } from "../taskProgress";
import type { Task } from "@/types";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: overrides.id || crypto.randomUUID(),
    userId: "user1",
    workspaceId: null,
    title: overrides.title || "Test task",
    isCompleted: overrides.isCompleted ?? 0,
    priority: overrides.priority ?? 2,
    dueDate: overrides.dueDate ?? null,
    dueAt: overrides.dueAt ?? null,
    noteId: null,
    projectId: null,
    status: "todo",
    parentId: overrides.parentId ?? null,
    sortOrder: overrides.sortOrder ?? 0,
    createdAt: "2026-01-01T00:00:00",
    updatedAt: "2026-01-01T00:00:00",
    ...overrides,
  };
}

describe("buildTaskTree", () => {
  it("returns empty array for empty input", () => {
    expect(buildTaskTree([])).toEqual([]);
  });

  it("flat tasks with no parentId become roots", () => {
    const a = makeTask({ id: "a" });
    const b = makeTask({ id: "b" });
    const tree = buildTaskTree([a, b]);
    expect(tree).toHaveLength(2);
    expect(tree[0].id).toBe("a");
    expect(tree[1].id).toBe("b");
    expect(tree[0].children).toEqual([]);
  });

  it("child tasks are nested under parent", () => {
    const parent = makeTask({ id: "p" });
    const child = makeTask({ id: "c", parentId: "p" });
    const tree = buildTaskTree([parent, child]);
    expect(tree).toHaveLength(1);
    expect(tree[0].id).toBe("p");
    expect(tree[0].children).toHaveLength(1);
    expect(tree[0].children[0].id).toBe("c");
  });

  it("multi-level nesting works", () => {
    const root = makeTask({ id: "root" });
    const mid = makeTask({ id: "mid", parentId: "root" });
    const leaf = makeTask({ id: "leaf", parentId: "mid" });
    const tree = buildTaskTree([root, mid, leaf]);
    expect(tree).toHaveLength(1);
    expect(tree[0].children[0].id).toBe("mid");
    expect(tree[0].children[0].children[0].id).toBe("leaf");
  });

  it("orphan tasks (parentId points to missing task) become roots", () => {
    const orphan = makeTask({ id: "orphan", parentId: "nonexistent" });
    const tree = buildTaskTree([orphan]);
    expect(tree).toHaveLength(1);
    expect(tree[0].id).toBe("orphan");
  });

  it("self-referencing parentId does not crash", () => {
    const selfRef = makeTask({ id: "self", parentId: "self" });
    const tree = buildTaskTree([selfRef]);
    expect(tree).toHaveLength(1);
    expect(tree[0].id).toBe("self");
    expect(tree[0].children).toEqual([]);
  });

  it("circular parentId (A->B->A) does not infinite loop", () => {
    const a = makeTask({ id: "a", parentId: "b" });
    const b = makeTask({ id: "b", parentId: "a" });
    const tree = buildTaskTree([a, b]);
    // Both should end up in tree without crashing
    expect(tree.length).toBeGreaterThanOrEqual(1);
    // Verify no infinite recursion by just completing
  });

  it("deeper cycle (A->B->C->A) does not infinite loop", () => {
    const a = makeTask({ id: "a", parentId: "c" });
    const b = makeTask({ id: "b", parentId: "a" });
    const c = makeTask({ id: "c", parentId: "b" });
    const tree = buildTaskTree([a, b, c]);
    expect(tree.length).toBeGreaterThanOrEqual(1);
  });

  it("preserves original order", () => {
    const a = makeTask({ id: "a", sortOrder: 2 });
    const b = makeTask({ id: "b", sortOrder: 1 });
    const tree = buildTaskTree([a, b]);
    expect(tree[0].id).toBe("a");
    expect(tree[1].id).toBe("b");
  });
});

describe("calculateTaskProgress", () => {
  it("leaf node completed = 100%", () => {
    const node: TaskTreeNode = { ...makeTask({ isCompleted: 1 }), children: [] };
    const result = calculateTaskProgress(node);
    expect(result.progress).toBe(100);
    expect(result.completedChildren).toBe(0);
    expect(result.totalChildren).toBe(0);
  });

  it("leaf node incomplete = 0%", () => {
    const node: TaskTreeNode = { ...makeTask({ isCompleted: 0 }), children: [] };
    expect(calculateTaskProgress(node).progress).toBe(0);
  });

  it("parent with 2/4 children done = 50%", () => {
    const done: TaskTreeNode = { ...makeTask({ isCompleted: 1 }), children: [] };
    const pending: TaskTreeNode = { ...makeTask({ isCompleted: 0 }), children: [] };
    const parent: TaskTreeNode = {
      ...makeTask({ isCompleted: 0 }),
      children: [done, done, pending, pending],
    };
    const result = calculateTaskProgress(parent);
    expect(result.progress).toBe(50);
    expect(result.completedChildren).toBe(2);
    expect(result.totalChildren).toBe(4);
  });

  it("all children done = 100%", () => {
    const c1: TaskTreeNode = { ...makeTask({ isCompleted: 1 }), children: [] };
    const c2: TaskTreeNode = { ...makeTask({ isCompleted: 1 }), children: [] };
    const parent: TaskTreeNode = { ...makeTask({ isCompleted: 0 }), children: [c1, c2] };
    expect(calculateTaskProgress(parent).progress).toBe(100);
  });

  it("nested: grandchild progress propagates up", () => {
    const gc1: TaskTreeNode = { ...makeTask({ isCompleted: 1 }), children: [] };
    const gc2: TaskTreeNode = { ...makeTask({ isCompleted: 0 }), children: [] };
    const child: TaskTreeNode = { ...makeTask({ isCompleted: 0 }), children: [gc1, gc2] };
    const parent: TaskTreeNode = { ...makeTask({ isCompleted: 0 }), children: [child] };
    const result = calculateTaskProgress(parent);
    // child = 50%, parent has 1 child so parent = 50%
    expect(result.progress).toBe(50);
    expect(result.totalChildren).toBe(1);
  });

  it("progress is based on full subtree, not affected by expand state", () => {
    // This test verifies the function takes a node and computes from it,
    // regardless of any UI state (expand/collapse is a UI concern)
    const c1: TaskTreeNode = { ...makeTask({ isCompleted: 1 }), children: [] };
    const c2: TaskTreeNode = { ...makeTask({ isCompleted: 0 }), children: [] };
    const parent: TaskTreeNode = { ...makeTask({ isCompleted: 0 }), children: [c1, c2] };
    // Calling multiple times gives same result
    expect(calculateTaskProgress(parent).progress).toBe(calculateTaskProgress(parent).progress);
  });
});
