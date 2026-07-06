import type { Task } from "@/types";
// TASK-RECURRENCE-LUNAR-01: 农历转换
import { getNextLunarYearDate } from "./lunarUtils";

export type RepeatRule = "none" | "daily" | "weekly" | "monthly" | "yearly" | "custom";

export const VALID_REPEAT_RULES: RepeatRule[] = ["none", "daily", "weekly", "monthly", "yearly", "custom"];

/** Check if a task has an active repeat rule */
export function isRepeatingTask(task: Task): boolean {
  return !!task.repeatRule && task.repeatRule !== "none" && (
    task.repeatRule === "custom" || (task.repeatInterval ?? 0) > 0
  );
}

/** TASK-RECURRENCE-CUSTOM-01: 从自定义规则计算下一次日期 */
function nextDateFromCustomRule(base: Date, rule: any): Date | null {
  const freq = rule.frequency;
  const interval = Math.max(1, Number(rule.interval) || 1);

  // TASK-RECURRENCE-LUNAR-01: 农历年循环
  if (rule.calendar === "lunar") {
    return getNextLunarYearDate(base, {
      interval,
      lunarMonth: Number(rule.lunarMonth),
      lunarDay: Number(rule.lunarDay),
    });
  }

  if (freq === "day") {
    const next = new Date(base);
    next.setDate(next.getDate() + interval);
    return next;
  }
  if (freq === "week") {
    const weekdays: number[] = rule.weekdays || [];
    if (weekdays.length === 0) {
      const next = new Date(base);
      next.setDate(next.getDate() + 7 * interval);
      return next;
    }
    const sorted = [...weekdays].sort((a, b) => a - b);
    const curDay = base.getDay();
    for (const d of sorted) {
      if (d > curDay) {
        const next = new Date(base);
        next.setDate(next.getDate() + (d - curDay));
        return next;
      }
    }
    const next = new Date(base);
    next.setDate(next.getDate() + (7 * interval) - curDay + sorted[0]);
    return next;
  }
  // TASK-RECURRENCE-CUSTOM-01-RV1: 修复月末/闰年溢出
  if (freq === "month") {
    const monthDay = Number(rule.monthDay) || base.getDate();
    const next = new Date(base);
    next.setDate(1); // 防止溢出：31 日 setMonth 会跳过短月
    next.setMonth(next.getMonth() + interval);
    const lastDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
    next.setDate(Math.min(monthDay, lastDay));
    return next;
  }
  if (freq === "year") {
    const yearMonth = Number(rule.yearMonth) || (base.getMonth() + 1);
    const yearDay = Number(rule.yearDay) || base.getDate();
    const next = new Date(base);
    next.setDate(1); // 防止溢出：2 月 29 日 setFullYear 到非闰年会跳月
    next.setFullYear(next.getFullYear() + interval);
    next.setMonth(yearMonth - 1);
    const lastDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
    next.setDate(Math.min(yearDay, lastDay));
    return next;
  }
  return null;
}

/**
 * Calculate the next repeat date for a task.
 * Returns null if the task cannot generate a next occurrence.
 */
export function getNextRepeatDate(task: Task): string | null {
  if (!isRepeatingTask(task)) return null;

  if (
    task.repeatEndCount !== null &&
    task.repeatEndCount !== undefined &&
    (task.repeatSequenceIndex ?? 1) >= task.repeatEndCount
  ) {
    return null;
  }

  const baseDateStr = task.dueAt ? task.dueAt.split("T")[0] : task.dueDate;
  if (!baseDateStr) return null;

  const parts = baseDateStr.split("-").map(Number);
  const base = new Date(parts[0], parts[1] - 1, parts[2]);
  let next: Date | null = null;

  if (task.repeatRule === "custom") {
    let rule: any = null;
    try { rule = JSON.parse(task.repeatRuleJson || "{}"); } catch {}
    if (!rule || !rule.frequency) return null;
    next = nextDateFromCustomRule(base, rule);
  } else {
    const interval = task.repeatInterval ?? 1;
    switch (task.repeatRule) {
      case "daily":
        next = new Date(base);
        next.setDate(next.getDate() + interval);
        break;
      case "weekly":
        next = new Date(base);
        next.setDate(next.getDate() + 7 * interval);
        break;
      case "monthly":
        next = new Date(base);
        next.setMonth(next.getMonth() + interval);
        if (next.getDate() !== base.getDate()) next.setDate(0);
        break;
      case "yearly":
        next = new Date(base);
        next.setFullYear(next.getFullYear() + interval);
        if (next.getDate() !== base.getDate()) next.setDate(0);
        break;
      default:
        return null;
    }
  }

  if (!next) return null;

  if (task.repeatEndDate) {
    const endParts = task.repeatEndDate.split("-").map(Number);
    const endDate = new Date(endParts[0], endParts[1] - 1, endParts[2]);
    if (next > endDate) return null;
  }

  const yyyy = next.getFullYear();
  const mm = String(next.getMonth() + 1).padStart(2, "0");
  const dd = String(next.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Build the patch for creating the next repeated task from a completed task.
 * Returns null if no next occurrence should be generated.
 */
export function buildNextRepeatedTaskPatch(task: Task): Partial<Task> | null {
  const nextDate = getNextRepeatDate(task);
  if (!nextDate) return null;

  const patch: Partial<Task> = {
    title: task.title,
    priority: task.priority,
    isCompleted: 0,
    status: "todo" as const,
    projectId: task.projectId ?? null,
    parentId: task.parentId ?? null,
    repeatRule: task.repeatRule,
    repeatInterval: task.repeatInterval,
    repeatEndDate: task.repeatEndDate ?? null,
    repeatEndCount: task.repeatEndCount ?? null,
    repeatSequenceIndex: (task.repeatSequenceIndex ?? 1) + 1,
    repeatGroupId: task.repeatGroupId ?? task.id,
    repeatGeneratedFromId: task.id,
    repeatRuleJson: task.repeatRuleJson ?? null,
  };

  if (task.dueAt) {
    const timePart = task.dueAt.split("T")[1] || "00:00:00";
    patch.dueAt = `${nextDate}T${timePart}`;
    patch.dueDate = nextDate;
  } else {
    patch.dueDate = nextDate;
  }

  return patch;
}
