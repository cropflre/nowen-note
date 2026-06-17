import type { Task, TaskReminder } from "@/types";

export function buildCustomReminderOffset(input: { days: number; hours: number; minutes: number }): number | null {
  const days = Math.max(0, Math.floor(input.days || 0));
  const hours = Math.max(0, Math.floor(input.hours || 0));
  const minutes = Math.max(0, Math.floor(input.minutes || 0));
  const total = days * 1440 + hours * 60 + minutes;
  return total > 0 ? total : null;
}

export function sortRemindersByOffset(reminders: TaskReminder[]): TaskReminder[] {
  return [...reminders].sort((a, b) => a.offsetMinutes - b.offsetMinutes);
}

export function hasEnabledReminder(task: Pick<Task, "activeReminderCount">): boolean {
  return (task.activeReminderCount ?? 0) > 0;
}
