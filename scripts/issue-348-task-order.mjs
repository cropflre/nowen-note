import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const root = process.cwd();
const centerPath = resolve(root, "frontend/src/components/TaskCenterImpl.tsx");
const orderPath = resolve(root, "frontend/src/components/tasks/taskCompletionOrder.ts");
const testPath = resolve(root, "frontend/src/components/tasks/__tests__/taskCompletionOrder.test.ts");

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first < 0) throw new Error(`Missing ${label} anchor`);
  if (source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`Duplicate ${label} anchor`);
  }
  return source.slice(0, first) + after + source.slice(first + before.length);
}

let center = readFileSync(centerPath, "utf8");

center = replaceOnce(
  center,
  'import { compareTasksByDueTime, moveTaskToDate } from "./tasks/taskDateUtils";\n',
  'import { compareTasksByDueTime, moveTaskToDate } from "./tasks/taskDateUtils";\nimport { haveSameTaskCompletionState, orderTasksCompletedLast } from "./tasks/taskCompletionOrder";\n',
  "task completion order import",
);

center = replaceOnce(
  center,
  `  const treeSourceTasks = useMemo(() => {
    if (!sortByDueTime) return tasks;
    const roots = tasks.filter((task) => !task.parentId).sort(compareTasksByDueTime);
    const children = tasks.filter((task) => task.parentId);
    return [...roots, ...children];
  }, [tasks, sortByDueTime]);`,
  `  const treeSourceTasks = useMemo(() => {
    const roots = tasks.filter((task) => !task.parentId);
    const children = tasks.filter((task) => task.parentId);
    return [
      ...orderTasksCompletedLast(roots, sortByDueTime ? compareTasksByDueTime : undefined),
      ...orderTasksCompletedLast(children),
    ];
  }, [tasks, sortByDueTime]);`,
  "tree task ordering",
);

center = replaceOnce(
  center,
  `  const displayTasks = useMemo(() => {
    const source = searchQuery.trim() ? tasks.filter((t) => taskMatchesSearch(t, searchQuery)) : tasks;
    return sortByDueTime ? [...source].sort(compareTasksByDueTime) : source;
  }, [tasks, searchQuery, sortByDueTime]);`,
  `  const displayTasks = useMemo(() => {
    const source = searchQuery.trim() ? tasks.filter((t) => taskMatchesSearch(t, searchQuery)) : tasks;
    if (viewMode !== "list") {
      return sortByDueTime ? [...source].sort(compareTasksByDueTime) : source;
    }
    return orderTasksCompletedLast(
      source,
      sortByDueTime ? compareTasksByDueTime : undefined,
    );
  }, [tasks, searchQuery, sortByDueTime, viewMode]);`,
  "flat task ordering",
);

center = replaceOnce(
  center,
  `    if ((dragTask.parentId ?? null) !== (targetTask.parentId ?? null)) {
      setDragId(null);
      setDragOverId(null);
      return;
    }

    const siblings = tasks`,
  `    if ((dragTask.parentId ?? null) !== (targetTask.parentId ?? null)) {
      setDragId(null);
      setDragOverId(null);
      return;
    }
    if (!haveSameTaskCompletionState(dragTask, targetTask)) {
      setDragId(null);
      setDragOverId(null);
      return;
    }

    const siblings = tasks`,
  "drag completion group guard",
);

writeFileSync(centerPath, center);

const orderSource = `import type { Task } from "@/types";

export type TaskOrderComparator = (left: Task, right: Task) => number;

export function isTaskCompleted(task: Pick<Task, "isCompleted">): boolean {
  return Number(task.isCompleted) === 1;
}

/**
 * Stable presentation ordering for task lists. Completion is the primary key, while the optional
 * comparator controls ordering inside the pending and completed groups. The persisted sortOrder is
 * intentionally left untouched.
 */
export function orderTasksCompletedLast(
  tasks: readonly Task[],
  compareWithinGroup?: TaskOrderComparator,
): Task[] {
  return tasks
    .map((task, index) => ({ task, index }))
    .sort((left, right) => {
      const completionDelta = Number(isTaskCompleted(left.task)) - Number(isTaskCompleted(right.task));
      if (completionDelta !== 0) return completionDelta;
      const compared = compareWithinGroup?.(left.task, right.task) ?? 0;
      return compared !== 0 ? compared : left.index - right.index;
    })
    .map(({ task }) => task);
}

export function haveSameTaskCompletionState(
  left: Pick<Task, "isCompleted">,
  right: Pick<Task, "isCompleted">,
): boolean {
  return isTaskCompleted(left) === isTaskCompleted(right);
}
`;

const testSource = `import { describe, expect, it } from "vitest";
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
`;

mkdirSync(dirname(orderPath), { recursive: true });
mkdirSync(dirname(testPath), { recursive: true });
writeFileSync(orderPath, orderSource);
writeFileSync(testPath, testSource);

console.log("Issue #348 task ordering patch generated.");
