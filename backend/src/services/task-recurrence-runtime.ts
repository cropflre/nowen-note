import { randomUUID } from "node:crypto";

import {
  DbStatementChangeError,
  type DatabaseAdapter,
  type DbStatement,
} from "../db/adapters/types";
import type { TaskCoreRow } from "../repositories/taskCoreRepository";

export const VALID_TASK_REPEAT_RULES = ["none", "daily", "weekly", "monthly", "yearly", "custom"] as const;
export const VALID_TASK_STATUSES = ["todo", "doing", "blocked", "done"] as const;
const VALID_CUSTOM_FREQUENCIES = ["day", "week", "month", "year"] as const;

export type TaskRepeatRule = typeof VALID_TASK_REPEAT_RULES[number];
export type TaskStatus = typeof VALID_TASK_STATUSES[number];

export interface TaskCustomRepeatRule {
  frequency: "day" | "week" | "month" | "year";
  interval: number;
  weekdays?: number[];
  monthDay?: number;
  yearMonth?: number;
  yearDay?: number;
}

interface TaskReminderRow {
  userId: string;
  offsetMinutes: number;
  timezoneOffsetMinutes: number | null;
  enabled: boolean | number;
}

function dateParts(date: Date): [number, number, number] {
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()];
}

function parseCalendarDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return date;
}

function formatCalendarDate(date: Date): string {
  const [year, month, day] = dateParts(date);
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function dueAtString(value: string | Date | null): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function dueDatePart(task: TaskCoreRow): string | null {
  const dueAt = dueAtString(task.dueAt);
  if (dueAt) return dueAt.slice(0, 10);
  return task.dueDate ? String(task.dueDate).slice(0, 10) : null;
}

function dueTimePart(task: TaskCoreRow): string | null {
  const dueAt = dueAtString(task.dueAt);
  if (!dueAt) return null;
  const index = dueAt.indexOf("T");
  return index >= 0 ? dueAt.slice(index + 1) : "00:00:00";
}

export function normalizeRepeatEndCount(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const count = Number(value);
  if (!Number.isInteger(count) || count < 1 || count > 999) {
    throw new Error("INVALID_REPEAT_END_COUNT");
  }
  return count;
}

export function validateTaskCustomRepeatRule(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "repeatRuleJson must be an object";
  }
  const rule = value as Record<string, unknown>;
  if (!VALID_CUSTOM_FREQUENCIES.includes(rule.frequency as any)) {
    return "frequency must be day/week/month/year";
  }
  const interval = Number(rule.interval);
  if (!Number.isInteger(interval) || interval < 1) return "interval must be >= 1";
  if (rule.weekdays !== undefined) {
    if (!Array.isArray(rule.weekdays)) return "weekdays must be an array";
    for (const weekday of rule.weekdays) {
      if (!Number.isInteger(weekday) || Number(weekday) < 0 || Number(weekday) > 6) {
        return "weekdays values must be 0-6";
      }
    }
  }
  if (rule.monthDay !== undefined) {
    const monthDay = Number(rule.monthDay);
    if (!Number.isInteger(monthDay) || monthDay < 1 || monthDay > 31) return "monthDay must be 1-31";
  }
  if (rule.yearMonth !== undefined) {
    const yearMonth = Number(rule.yearMonth);
    if (!Number.isInteger(yearMonth) || yearMonth < 1 || yearMonth > 12) return "yearMonth must be 1-12";
  }
  if (rule.yearDay !== undefined) {
    const yearDay = Number(rule.yearDay);
    if (!Number.isInteger(yearDay) || yearDay < 1 || yearDay > 31) return "yearDay must be 1-31";
  }
  return null;
}

export function normalizeTaskCustomRepeatRule(value: unknown): TaskCustomRepeatRule {
  const validationError = validateTaskCustomRepeatRule(value);
  if (validationError) throw new Error(validationError);
  const source = value as Record<string, unknown>;
  const rule: TaskCustomRepeatRule = {
    frequency: source.frequency as TaskCustomRepeatRule["frequency"],
    interval: Number(source.interval),
  };
  if (Array.isArray(source.weekdays)) {
    rule.weekdays = [...new Set(source.weekdays.map(Number))].sort((a, b) => a - b);
  }
  if (source.monthDay !== undefined) rule.monthDay = Number(source.monthDay);
  if (source.yearMonth !== undefined) rule.yearMonth = Number(source.yearMonth);
  if (source.yearDay !== undefined) rule.yearDay = Number(source.yearDay);
  return rule;
}

export function nextDateFromCustomTaskRule(baseDate: Date, rule: TaskCustomRepeatRule): Date | null {
  const interval = Math.max(1, Number(rule.interval) || 1);
  if (rule.frequency === "day") {
    const next = new Date(baseDate);
    next.setDate(next.getDate() + interval);
    return next;
  }
  if (rule.frequency === "week") {
    const weekdays = [...(rule.weekdays ?? [])].sort((a, b) => a - b);
    if (weekdays.length === 0) {
      const next = new Date(baseDate);
      next.setDate(next.getDate() + 7 * interval);
      return next;
    }
    const currentWeekday = baseDate.getDay();
    for (const weekday of weekdays) {
      if (weekday > currentWeekday) {
        const next = new Date(baseDate);
        next.setDate(next.getDate() + weekday - currentWeekday);
        return next;
      }
    }
    const next = new Date(baseDate);
    next.setDate(next.getDate() + 7 * interval - currentWeekday + weekdays[0]);
    return next;
  }
  if (rule.frequency === "month") {
    const monthDay = Number(rule.monthDay) || baseDate.getDate();
    const next = new Date(baseDate);
    next.setDate(1);
    next.setMonth(next.getMonth() + interval);
    const lastDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
    next.setDate(Math.min(monthDay, lastDay));
    return next;
  }
  if (rule.frequency === "year") {
    const yearMonth = Number(rule.yearMonth) || baseDate.getMonth() + 1;
    const yearDay = Number(rule.yearDay) || baseDate.getDate();
    const next = new Date(baseDate);
    next.setDate(1);
    next.setFullYear(next.getFullYear() + interval);
    next.setMonth(yearMonth - 1);
    const lastDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
    next.setDate(Math.min(yearDay, lastDay));
    return next;
  }
  return null;
}

function nextStandardRepeatDate(baseDate: Date, repeatRule: string, intervalValue: number): Date | null {
  const interval = Math.max(1, Number(intervalValue) || 1);
  const next = new Date(baseDate);
  if (repeatRule === "daily") next.setDate(next.getDate() + interval);
  else if (repeatRule === "weekly") next.setDate(next.getDate() + 7 * interval);
  else if (repeatRule === "monthly") {
    const day = baseDate.getDate();
    next.setDate(1);
    next.setMonth(next.getMonth() + interval);
    const lastDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
    next.setDate(Math.min(day, lastDay));
  } else if (repeatRule === "yearly") {
    const month = baseDate.getMonth();
    const day = baseDate.getDate();
    next.setDate(1);
    next.setFullYear(next.getFullYear() + interval);
    next.setMonth(month);
    const lastDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
    next.setDate(Math.min(day, lastDay));
  } else return null;
  return next;
}

export function isInvalidTaskDateRange(
  startDate: string | null,
  dueDate: string | null,
  dueAt: string | null,
): boolean {
  if (!startDate) return false;
  const end = dueAt || dueDate;
  if (!end) return false;
  const normalizedStart = startDate.trim().replace(" ", "T");
  const normalizedEnd = end.trim().replace(" ", "T");
  const startDay = normalizedStart.slice(0, 10);
  const endDay = normalizedEnd.slice(0, 10);
  if (startDay !== endDay) return startDay > endDay;
  if (!normalizedStart.includes("T") || !normalizedEnd.includes("T")) return false;
  return normalizedStart > normalizedEnd;
}

export function createTaskRecurrenceRuntime(adapter: DatabaseAdapter) {
  async function repeatOccurrenceCount(groupId: string): Promise<number> {
    const row = await adapter.queryOne<{ count: number | string }>(
      `SELECT COUNT(*) AS count FROM tasks WHERE id = ? OR "repeatGroupId" = ?`,
      [groupId, groupId],
    );
    return Number(row?.count ?? 0);
  }

  async function loadById(id: string): Promise<TaskCoreRow | undefined> {
    return adapter.queryOne<TaskCoreRow>(`SELECT * FROM tasks WHERE id = ?`, [id]);
  }

  return {
    async generateNext(task: TaskCoreRow): Promise<TaskCoreRow | null> {
      if (!task.repeatRule || task.repeatRule === "none" || task.repeatNextGeneratedId) {
        if (task.repeatNextGeneratedId) return (await loadById(task.repeatNextGeneratedId)) ?? null;
        return null;
      }

      const baseDateValue = dueDatePart(task);
      if (!baseDateValue) return null;
      const baseDate = parseCalendarDate(baseDateValue);
      if (!baseDate) return null;

      const groupId = task.repeatGroupId || task.id;
      const occurrenceCount = await repeatOccurrenceCount(groupId);
      const configuredSequence = task.repeatSequenceIndex == null ? null : Number(task.repeatSequenceIndex);
      const currentSequence = configuredSequence && Number.isFinite(configuredSequence) && configuredSequence >= 1
        ? configuredSequence
        : Math.max(1, occurrenceCount);
      const maxCount = task.repeatEndCount == null ? null : Number(task.repeatEndCount);
      if (maxCount !== null && Number.isFinite(maxCount) && maxCount >= 1 && currentSequence >= maxCount) {
        return null;
      }

      let nextDate: Date | null;
      if (task.repeatRule === "custom") {
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(task.repeatRuleJson || "{}");
        } catch {
          return null;
        }
        const validationError = validateTaskCustomRepeatRule(parsed);
        if (validationError) return null;
        nextDate = nextDateFromCustomTaskRule(baseDate, normalizeTaskCustomRepeatRule(parsed));
      } else {
        nextDate = nextStandardRepeatDate(baseDate, task.repeatRule, task.repeatInterval || 1);
      }
      if (!nextDate) return null;

      if (task.repeatEndDate) {
        const repeatEndDate = parseCalendarDate(task.repeatEndDate);
        if (repeatEndDate && nextDate > repeatEndDate) return null;
      }

      const nextDateValue = formatCalendarDate(nextDate);
      const timePart = dueTimePart(task);
      const nextDueAt = timePart ? `${nextDateValue}T${timePart}` : null;
      const nextId = randomUUID();
      const nextSequence = currentSequence + 1;
      const reminders = await adapter.queryMany<TaskReminderRow>(
        `SELECT "userId" AS "userId",
                "offsetMinutes" AS "offsetMinutes",
                "timezoneOffsetMinutes" AS "timezoneOffsetMinutes",
                enabled
           FROM task_reminders
          WHERE "taskId" = ?`,
        [task.id],
      );

      const statements: DbStatement[] = [
        {
          sql: `UPDATE tasks
                  SET "repeatNextGeneratedId" = ?, "updatedAt" = CURRENT_TIMESTAMP
                WHERE id = ? AND "repeatNextGeneratedId" IS NULL`,
          params: [nextId, task.id],
          requireChanges: 1,
        },
        {
          sql: `INSERT INTO tasks (
                  id, "userId", "workspaceId", title, description,
                  "isCompleted", "completedAt", priority, "dueDate", "dueAt", "startDate",
                  "noteId", "parentId", "projectId", status,
                  "repeatRule", "repeatInterval", "repeatEndDate", "repeatGroupId",
                  "repeatGeneratedFromId", "repeatEndCount", "repeatSequenceIndex", "repeatRuleJson"
                ) VALUES (?, ?, ?, ?, ?, false, NULL, ?, ?, ?, NULL, ?, ?, ?, 'todo', ?, ?, ?, ?, ?, ?, ?, ?)`,
          params: [
            nextId,
            task.userId,
            task.workspaceId,
            task.title,
            task.description || "",
            task.priority ?? 2,
            nextDateValue,
            nextDueAt,
            task.noteId,
            task.parentId,
            task.projectId,
            task.repeatRule,
            task.repeatInterval || 1,
            task.repeatEndDate ?? null,
            groupId,
            task.id,
            task.repeatEndCount ?? null,
            nextSequence,
            task.repeatRuleJson ?? null,
          ],
          requireChanges: 1,
        },
        ...reminders.map((reminder): DbStatement => ({
          sql: `INSERT INTO task_reminders (
                  id, "taskId", "userId", "offsetMinutes", "timezoneOffsetMinutes",
                  enabled, "lastNotifiedAt", "createdAt", "updatedAt", "snoozedUntil"
                ) VALUES (?, ?, ?, ?, ?, ?, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, NULL)`,
          params: [
            randomUUID(),
            nextId,
            reminder.userId,
            reminder.offsetMinutes,
            reminder.timezoneOffsetMinutes,
            reminder.enabled === true || reminder.enabled === 1,
          ],
          requireChanges: 1,
        })),
      ];

      try {
        await adapter.executeStatements(statements);
      } catch (error) {
        if (!(error instanceof DbStatementChangeError)) throw error;
        const current = await loadById(task.id);
        if (!current?.repeatNextGeneratedId) return null;
        return (await loadById(current.repeatNextGeneratedId)) ?? null;
      }

      return (await loadById(nextId)) ?? null;
    },
  };
}
