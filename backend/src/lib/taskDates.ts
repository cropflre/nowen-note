const TASK_DATE_PATTERN = /^(\d{4}-\d{2}-\d{2})(?:[T ](?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-](?:[01]\d|2[0-3]):?[0-5]\d)?)?$/;

/** Task date keys and ISO/SQLite wall times; never silently roll an invalid day forward. */
export function isValidTaskDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = TASK_DATE_PATTERN.exec(value.trim());
  if (!match) return false;
  const [year, month, day] = match[1].split("-").map(Number);
  const date = new Date(`${match[1]}T00:00:00Z`);
  return year >= 1 && date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    && Number.isFinite(Date.parse(value.trim().replace(" ","T")));
}
export function invalidTaskDateField(input: Record<string, unknown>, existing?: Record<string, unknown>): string | undefined {
  return ["dueDate","dueAt","startDate","repeatEndDate"].find(field => {
    const value = input[field];
    return value !== undefined && value !== null && value !== "" && value !== existing?.[field] && !isValidTaskDate(value);
  });
}
