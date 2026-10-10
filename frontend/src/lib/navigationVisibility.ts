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

/**
 * Ordering is intentionally independent from visibility. Saved partial orders from older
 * clients are accepted and any newly introduced module is appended in canonical order.
 */
export function normalizeNavigationModuleOrder(value: unknown): NavigationModuleId[] {
  const saved = normalizeStringIds<NavigationModuleId>(value, NAVIGATION_MODULE_SET);
  const seen = new Set(saved);
  return [
    ...saved,
    ...NAVIGATION_MODULE_IDS.filter((id) => !seen.has(id)),
  ];
}

export function moveNavigationModule(
  value: unknown,
  sourceId: NavigationModuleId,
  targetId: NavigationModuleId,
): NavigationModuleId[] {
  const order = normalizeNavigationModuleOrder(value);
  if (sourceId === targetId) return order;
  const from = order.indexOf(sourceId);
  const to = order.indexOf(targetId);
  if (from < 0 || to < 0) return order;
  const next = [...order];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

export function moveNavigationModuleByOffset(
  value: unknown,
  id: NavigationModuleId,
  offset: -1 | 1,
): NavigationModuleId[] {
  const order = normalizeNavigationModuleOrder(value);
  const from = order.indexOf(id);
  if (from < 0) return order;
  const to = Math.max(0, Math.min(order.length - 1, from + offset));
  if (to === from) return order;
  const next = [...order];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

export function isNavigationModuleVisible(moduleId: string, hidden: readonly NavigationModuleId[]): boolean {
  return !NAVIGATION_MODULE_SET.has(moduleId) || !hidden.includes(moduleId as NavigationModuleId);
}

export function isTaskCenterModuleVisible(moduleId: string, hidden: readonly TaskCenterOptionalModuleId[]): boolean {
  return !TASK_CENTER_OPTIONAL_MODULE_SET.has(moduleId) || !hidden.includes(moduleId as TaskCenterOptionalModuleId);
}
