import type { Task } from "@/types";
import { buildDueAtFromDateAndTime, getDateValue, getDueTimeValue } from "./taskDateUtils";
import { parseTaskQuickAdd } from "./taskSmartRecognition";

export type TaskQuickAddManualMeta = {
  dueDate?: string | null;
  dueTime?: string | null;
  reminderOffsets?: number[];
};

/** 预览和提交共用合并规则；undefined 表示未手动修改，null/空数组表示明确清除。 */
export function resolveTaskQuickAddDraft(
  title: string,
  defaults: Partial<Task> = {},
  manual: TaskQuickAddManualMeta = {},
) {
  const parsed = parseTaskQuickAdd(title);
  const taskPatch = { ...defaults, ...parsed.taskPatch };
  if (manual.dueDate !== undefined || manual.dueTime !== undefined) {
    const date = manual.dueDate !== undefined
      ? manual.dueDate
      : getDateValue(taskPatch.dueDate || taskPatch.dueAt);
    const time = manual.dueTime !== undefined ? manual.dueTime : getDueTimeValue(taskPatch.dueAt);
    taskPatch.dueDate = date || null;
    taskPatch.dueAt = buildDueAtFromDateAndTime(date, time || "");
  }
  // 手动清除截止日期后不再创建提醒，避免产生没有触发时间的提醒记录。
  const reminderOffsets = taskPatch.dueDate || taskPatch.dueAt
    ? [...new Set(manual.reminderOffsets ?? parsed.reminderOffsets)].sort((a, b) => a - b)
    : [];
  return { ...parsed, cleanTitle: parsed.cleanTitle || title.trim(), taskPatch, reminderOffsets };
}
