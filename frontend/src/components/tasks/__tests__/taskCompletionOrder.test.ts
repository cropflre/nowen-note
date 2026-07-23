import { describe, expect, it } from "vitest";
import type { Task } from "@/types";
import { buildTaskTree } from "../taskProgress";
import {
  haveSameTaskCompletionState,
  orderTasksCompletedLast,
} from "../taskCompletionOrder";

function task(id: string, patch: Partial<Task> = {}): Task {
  return {
    id,
    userId: "user-1",
    workspaceId: null,
    title: id,
    description: "",
    priority: 2,
    status: patch.isCompleted ? "done" : "todo",
    isCompleted: 0,
    completedAt: null,
    startDate: null,
    dueDate: null,
    dueAt: null,
    parentId: null,
    projectId: null,
    noteId: null,
    sortOrder: 0,
    createdAt: "2026-07-20T00:00:00.000Z",
    updatedAt: "2026-07-20T00:00:00.000Z",
    ...patch,
  } as Task;
}

describe("task completion ordering", () => {
  it("moves completed tasks after pending tasks without changing group order", () => {
    const ordered = orderTasksCompletedLast([
      task("done-a", { isCompleted: 1 }),
      task("todo-a"),
      task("done-b", { isCompleted: 1 }),
      task("todo-b"),
    ]);

    expect(ordered.map((item) => item.id)).toEqual(["todo-a", "todo-b", "done-a", "done-b"]);
  });

  it("keeps completion ahead of a secondary due-time comparator", () => {
    const ordered = orderTasksCompletedLast(
      [
        task("done-early", { isCompleted: 1, dueDate: "2026-07-20" }),
        task("todo-late", { dueDate: "2026-07-25" }),
        task("todo-early", { dueDate: "2026-07-21" }),
      ],
      (left, right) => (left.dueDate || "9999").localeCompare(right.dueDate || "9999"),
    );

    expect(ordered.map((item) => item.id)).toEqual(["todo-early", "todo-late", "done-early"]);
  });

  it("orders roots and each sibling group without breaking the task tree", () => {
    const rootDone = task("root-done", { isCompleted: 1 });
    const rootTodo = task("root-todo");
    const childDone = task("child-done", { parentId: "root-todo", isCompleted: 1 });
    const childTodo = task("child-todo", { parentId: "root-todo" });
    const source = [rootDone, childDone, rootTodo, childTodo];
    const ordered = [
      ...orderTasksCompletedLast(source.filter((item) => !item.parentId)),
      ...orderTasksCompletedLast(source.filter((item) => item.parentId)),
    ];
    const tree = buildTaskTree(ordered);

    expect(tree.map((item) => item.id)).toEqual(["root-todo", "root-done"]);
    expect(tree[0].children.map((item) => item.id)).toEqual(["child-todo", "child-done"]);
  });

  it("allows manual reorder only inside the same completion group", () => {
    expect(haveSameTaskCompletionState(task("a"), task("b"))).toBe(true);
    expect(haveSameTaskCompletionState(task("a", { isCompleted: 1 }), task("b", { isCompleted: 1 }))).toBe(true);
    expect(haveSameTaskCompletionState(task("a"), task("b", { isCompleted: 1 }))).toBe(false);
  });
});
