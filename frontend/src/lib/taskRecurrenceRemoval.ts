import type { Task } from "@/types";
export type TaskRemovalMode = "single" | "stop" | "series";
export function taskRemovalIds(tasks: Task[], id: string, mode: TaskRemovalMode, groupId?: string): Set<string> {
  const root = tasks.find(task => task.id === id);
  const group = groupId || root?.repeatGroupId || id;
  const ids = new Set(mode === "single" ? [id] : tasks.filter(task =>
    (task.id === group || task.repeatGroupId === group) && (!root || task.workspaceId === root.workspaceId)).map(task => task.id));
  if (mode === "stop") return ids;
  const queue = [...ids];
  while (queue.length) {
    const parent = queue.pop()!;
    for (const task of tasks) if (task.parentId === parent && !ids.has(task.id)) { ids.add(task.id); queue.push(task.id); }
  }
  return ids;
}
