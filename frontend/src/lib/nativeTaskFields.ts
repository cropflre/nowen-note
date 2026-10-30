import type { Task } from "@/types";

export const NATIVE_TASK_REPEAT_COLUMNS = {
  repeatRule: "TEXT NOT NULL DEFAULT 'none'", repeatInterval: "INTEGER NOT NULL DEFAULT 1",
  repeatEndDate: "TEXT", repeatGroupId: "TEXT", repeatGeneratedFromId: "TEXT", repeatNextGeneratedId: "TEXT",
  repeatEndCount: "INTEGER", repeatSequenceIndex: "INTEGER", repeatRuleJson: "TEXT",
} as const;
export const NATIVE_TASK_REPEAT_FIELDS = Object.keys(NATIVE_TASK_REPEAT_COLUMNS) as Array<keyof typeof NATIVE_TASK_REPEAT_COLUMNS>;
export function nativeTaskRepeatValues(task: Partial<Task>): unknown[] {
  return NATIVE_TASK_REPEAT_FIELDS.map(field => task[field] ?? (field === "repeatRule" ? "none" : field === "repeatInterval" ? 1 : null));
}
