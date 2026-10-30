// Optional additions preserve fields when older peers send the historical task payload.
export const TASK_SYNC_FIELDS = ["description", "dueAt", "startDate", "projectId", "status", "repeatRule", "repeatInterval", "repeatEndDate", "repeatGroupId", "repeatGeneratedFromId", "repeatNextGeneratedId", "repeatEndCount", "repeatSequenceIndex", "repeatRuleJson"] as const;
export function taskSyncValues(payload: Record<string, unknown>, current: Record<string, unknown> = {}): unknown[] {
  const defaults: Record<string, unknown> = { description: "", status: payload.isCompleted ? "done" : "todo", repeatRule: "none", repeatInterval: 1 };
  return TASK_SYNC_FIELDS.map(field => {
    const value = Object.hasOwn(payload, field) ? payload[field] : current[field] ?? defaults[field] ?? null;
    if (["repeatInterval", "repeatEndCount", "repeatSequenceIndex"].includes(field)) return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : defaults[field] ?? null;
    return typeof value === "string" ? value : defaults[field] ?? null;
  });
}
