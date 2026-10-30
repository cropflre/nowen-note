type CompletedTask = { isCompleted: number; completedAt?: string | null };

export function localDayCompletionFilter(timezone: string, now = new Date()) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
  });
  const day = formatter.format(now);
  return (task: CompletedTask): boolean => {
    if (!task.isCompleted || !task.completedAt) return false;
    const normalized = task.completedAt.replace(" ","T");
    const completed = new Date(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized) ? normalized : `${normalized}Z`);
    return Number.isFinite(completed.getTime()) && formatter.format(completed) === day;
  };
}

export function completedOnLocalDay(task: CompletedTask, timezone: string, now = new Date()): boolean {
  return localDayCompletionFilter(timezone,now)(task);
}

export function validTaskTimezone(value: string | undefined): string | null {
  const timezone = value || "Asia/Shanghai";
  try { new Intl.DateTimeFormat("en", { timeZone: timezone }); return timezone; }
  catch { return null; }
}
