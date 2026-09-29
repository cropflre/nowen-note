export const NAVIGATION_MODULE_IDS = [
  "notifications",
  "favorites",
  "files",
  "diary",
  "tasks",
  "mindmaps",
  "ai-chat",
  "shares",
] as const;

export type NavigationModuleId = typeof NAVIGATION_MODULE_IDS[number];

export const TASK_CENTER_OPTIONAL_MODULE_IDS = [
  "inbox",
  "my-day",
  "planner",
  "habits",
  "stats",
] as const;

export type TaskCenterOptionalModuleId = typeof TASK_CENTER_OPTIONAL_MODULE_IDS[number];

const NAVIGATION_MODULE_SET = new Set<string>(NAVIGATION_MODULE_IDS);
const TASK_CENTER_OPTIONAL_MODULE_SET = new Set<string>(TASK_CENTER_OPTIONAL_MODULE_IDS);

function normalizeStringIds<T extends string>(value: unknown, allowed: Set<string>): T[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !allowed.has(item) || seen.has(item)) continue;
    seen.add(item);
    result.push(item as T);
  }
  return result;
}

export function normalizeHiddenNavigationModules(value: unknown): NavigationModuleId[] {
  return normalizeStringIds<NavigationModuleId>(value, NAVIGATION_MODULE_SET);
}

export function normalizeHiddenTaskCenterModules(value: unknown): TaskCenterOptionalModuleId[] {
  return normalizeStringIds<TaskCenterOptionalModuleId>(value, TASK_CENTER_OPTIONAL_MODULE_SET);
}

export function isNavigationModuleVisible(moduleId: string, hidden: readonly NavigationModuleId[]): boolean {
  return !NAVIGATION_MODULE_SET.has(moduleId) || !hidden.includes(moduleId as NavigationModuleId);
}

export function isTaskCenterModuleVisible(moduleId: string, hidden: readonly TaskCenterOptionalModuleId[]): boolean {
  return !TASK_CENTER_OPTIONAL_MODULE_SET.has(moduleId) || !hidden.includes(moduleId as TaskCenterOptionalModuleId);
}
