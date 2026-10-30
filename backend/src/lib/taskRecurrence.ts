import crypto from "node:crypto";
import type { TaskScope } from "./taskRecurrenceDeletion.js";
import type Database from "better-sqlite3";
import { SyncError } from "../sync/errors.js";
import { isValidTaskDate } from "./taskDates.js";

function nextDateFromCustomRule(baseDate: Date, rule: any): Date | null {
  const freq = rule.frequency;
  const interval = Math.max(1, Number(rule.interval) || 1);
  if (!Number.isSafeInteger(Number(rule.interval)) || Number(rule.interval) < 1) return null;
  if (freq === "week" && rule.weekdays !== undefined && (!Array.isArray(rule.weekdays) || rule.weekdays.some((day: unknown) => !Number.isInteger(day) || Number(day) < 0 || Number(day) > 6))) return null;

  if (freq === "day") {
    const next = new Date(baseDate);
    next.setDate(next.getDate() + interval);
    return next;
  }

  if (freq === "week") {
    const weekdays: number[] = rule.weekdays || []; // 0=Sun, 1=Mon, ..., 6=Sat
    if (weekdays.length === 0) {
      // 无指定星期 → 简单加 N 周
      const next = new Date(baseDate);
      next.setDate(next.getDate() + 7 * interval);
      return next;
    }
    // 找下一个匹配的星期几
    const sorted = [...weekdays].sort((a, b) => a - b);
    const curDay = baseDate.getDay();
    // 先找本周内下一个
    for (const d of sorted) {
      if (d > curDay) {
        const next = new Date(baseDate);
        next.setDate(next.getDate() + (d - curDay));
        return next;
      }
    }
    // 没找到 → 下一周的第 一个
    const next = new Date(baseDate);
    next.setDate(next.getDate() + (7 * interval) - curDay + sorted[0]);
    return next;
  }

  // TASK-RECURRENCE-CUSTOM-01-RV1: 修复月末/闰年溢出
  // 先 setDate(1) 防止 setMonth 溢出到下下月
  if (freq === "month") {
    const monthDay = Number(rule.monthDay) || baseDate.getDate();
    const next = new Date(baseDate);
    next.setDate(1); // 防止溢出：31 日 setMonth 会跳过短月
    next.setMonth(next.getMonth() + interval);
    const lastDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
    next.setDate(Math.min(monthDay, lastDay));
    return next;
  }

  if (freq === "year") {
    const yearMonth = Number(rule.yearMonth) || (baseDate.getMonth() + 1);
    const yearDay = Number(rule.yearDay) || baseDate.getDate();
    const next = new Date(baseDate);
    next.setDate(1); // 防止溢出：2 月 29 日 setFullYear 到非闰年会跳月
    next.setFullYear(next.getFullYear() + interval);
    next.setMonth(yearMonth - 1);
    const lastDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
    next.setDate(Math.min(yearDay, lastDay));
    return next;
  }

  return null;
}

function getRepeatOccurrenceCount(db: any, groupId: string): number {
  const row = db.prepare(
    "SELECT COUNT(*) AS count FROM tasks WHERE id = ? OR repeatGroupId = ?"
  ).get(groupId, groupId) as { count: number } | undefined;
  return row?.count ?? 0;
}

/** Generate next repeated task. Returns the new task or null. */
export function generateNextRepeatedTask(db: any, task: any): any {
  if (!task.repeatRule || task.repeatRule === "none" || task.repeatNextGeneratedId) return null;
  if (taskRecurrenceState(db,task)) return null;
  const dueValue = task.dueAt || task.dueDate;
  if (!isValidTaskDate(dueValue)) return null;
  const baseDateStr = dueValue.trim().replace(" ","T").split("T")[0];
  const groupId = task.repeatGroupId || task.id;

  const maxCount = task.repeatEndCount === null || task.repeatEndCount === undefined
    ? null
    : Number(task.repeatEndCount);
  const currentSequenceIndex = task.repeatSequenceIndex === null || task.repeatSequenceIndex === undefined
    ? getRepeatOccurrenceCount(db, groupId)
    : Number(task.repeatSequenceIndex);
  if (maxCount !== null && Number.isFinite(maxCount) && maxCount >= 1) {
    if (currentSequenceIndex >= maxCount) return null;
  }
  const nextSequenceIndex = Number.isFinite(currentSequenceIndex) && currentSequenceIndex >= 1
    ? currentSequenceIndex + 1
    : getRepeatOccurrenceCount(db, groupId) + 1;

  const base = new Date(`${baseDateStr}T00:00:00`);
  let next: Date | null = null;

  if (task.repeatRule === "custom") {
    let rule: any = null;
    try { rule = JSON.parse(task.repeatRuleJson || "{}"); } catch {}
    if (!rule || !rule.frequency) return null;
    next = nextDateFromCustomRule(base, rule);
  } else {
    const interval = Number(task.repeatInterval ?? 1);
    if (!Number.isSafeInteger(interval) || interval < 1) return null;
    switch (task.repeatRule) {
      case "daily": next = new Date(base); next.setDate(next.getDate() + interval); break;
      case "weekly": next = new Date(base); next.setDate(next.getDate() + 7 * interval); break;
      case "monthly":
        next = new Date(base); next.setMonth(next.getMonth() + interval);
        if (next.getDate() !== base.getDate()) next.setDate(0);
        break;
      case "yearly":
        next = new Date(base); next.setFullYear(next.getFullYear() + interval);
        if (next.getDate() !== base.getDate()) next.setDate(0);
        break;
      default: return null;
    }
  }

  if (!next || !Number.isFinite(next.getTime()) || next.getFullYear() < 1 || next.getFullYear() > 9999) return null;

  if (task.repeatEndDate) {
    if (!isValidTaskDate(task.repeatEndDate)) return null;
    const endDate = new Date(`${task.repeatEndDate.trim().slice(0,10)}T00:00:00`);
    if (next > endDate) return null;
  }

  const yyyy = String(next.getFullYear()).padStart(4,"0");
  const mm = String(next.getMonth() + 1).padStart(2, "0");
  const dd = String(next.getDate()).padStart(2, "0");
  const nextDateStr = `${yyyy}-${mm}-${dd}`;
  let nextDueAt: string | null = null;
  let nextDueDate = nextDateStr;
  if (task.dueAt) {
    const timePart = task.dueAt.trim().replace(" ","T").split("T")[1] || "00:00:00";
    nextDueAt = `${nextDateStr}T${timePart}`;
  }

  const newId = crypto.randomUUID();
  db.prepare(`
    INSERT INTO tasks (id, userId, workspaceId, title, description, isCompleted, completedAt, priority, dueDate, dueAt, startDate, noteId, parentId, projectId, status, repeatRule, repeatInterval, repeatEndDate, repeatGroupId, repeatGeneratedFromId, repeatEndCount, repeatSequenceIndex, repeatRuleJson)
    VALUES (?, ?, ?, ?, ?, 0, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(newId, task.userId, task.workspaceId, task.title, task.description || "", task.priority, nextDueDate, nextDueAt, null, task.noteId, task.parentId, task.projectId, 'todo', task.repeatRule, task.repeatInterval, task.repeatEndDate, groupId, task.id, task.repeatEndCount ?? null, nextSequenceIndex, task.repeatRuleJson);

  db.prepare("UPDATE tasks SET repeatNextGeneratedId = ? WHERE id = ?").run(newId, task.id);

  const reminders = db.prepare("SELECT * FROM task_reminders WHERE taskId = ?").all(task.id) as any[];
  for (const r of reminders) {
    const rId = crypto.randomUUID();
    db.prepare("INSERT INTO task_reminders (id, taskId, userId, offsetMinutes, enabled, lastNotifiedAt, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, NULL, datetime('now'), datetime('now'))").run(rId, newId, r.userId, r.offsetMinutes, r.enabled);
  }

  return db.prepare("SELECT * FROM tasks WHERE id = ?").get(newId);
}


export function taskRecurrenceScope(task: TaskScope): string {
  return task.workspaceId ? `workspace:${task.workspaceId}` : `personal:${task.userId}`;
}
export function taskRecurrenceState(db: Database.Database, task: TaskScope): string | undefined {
  return (db.prepare("SELECT action FROM task_recurrence_state WHERE groupId=? AND scopeKey=?")
    .get(task.repeatGroupId || task.id, taskRecurrenceScope(task)) as { action: string } | undefined)?.action;
}
export function guardTaskRecurrenceWrite(db: Database.Database, task: TaskScope, repeatRule: unknown): void {
  const state = taskRecurrenceState(db,task);
  if (state === "series") throw new SyncError("VERSION_CONFLICT", "循环任务系列已删除，请另建任务");
  if (state === "stop" && repeatRule && repeatRule !== "none") {
    throw new SyncError("VERSION_CONFLICT", "循环已终止，请另建循环任务");
  }
}
