// Read-only Task Digest example. The core Automation Center owns webhook scheduling.
async function collectPersonalTasks(nowen) {
  const tasks = [];
  for (let offset = 0; offset < 50000; offset += 100) {
    const page = await nowen.tasks.list({ scope: "personal", limit: 100, offset });
    if (!Array.isArray(page)) throw new Error("Task Host API returned an invalid page");
    tasks.push(...page);
    if (page.length < 100) break;
    if (offset === 49900) throw new Error("Too many tasks for the daily summary");
  }
  return tasks;
}
function dayString(value) {
  return String(value || "").slice(0, 10);
}
function runForDay(tasks, today, mode, shiftMs) {
  const dueToday = tasks.filter((task) => dayString(task.dueAt || task.dueDate) === today);
  const overdue = tasks.filter((task) => !task.isCompleted && dayString(task.dueAt || task.dueDate) &&
    dayString(task.dueAt || task.dueDate) < today);
  const completedToday = tasks.filter((task) => {
    if (!task.completedAt) return false;
    const millis = Date.parse(task.completedAt);
    return Number.isFinite(millis) && new Date(millis + shiftMs).toISOString().slice(0, 10) === today;
  });
  const open = dueToday.filter((task) => !task.isCompleted);
  const active = mode === "evening" ? open : open.concat(overdue);
  const summary = mode === "evening"
    ? `完成 ${completedToday.length} 项，今日剩余 ${open.length} 项，逾期 ${overdue.length} 项`
    : `今日到期 ${dueToday.length} 项，待完成 ${open.length} 项，逾期 ${overdue.length} 项`;
  return {
    date: today, mode, summary,
    counts: { dueToday: dueToday.length, pendingToday: open.length,
      completedToday: completedToday.length, overdue: overdue.length },
    tasks: active.slice(0, 20).map((task) => ({
      taskId: task.id, title: task.title, dueDate: task.dueDate, dueAt: task.dueAt,
    })),
  };
}
globalThis.__nowenPluginModule = {
  actions: {
    summary: async ({ input, nowen }) => {
      const mode = input && input.mode === "evening" ? "evening" : "morning";
      const requestedOffset = Number(input && input.timezoneOffsetMinutes);
      const offsetMinutes = Number.isInteger(requestedOffset) && Math.abs(requestedOffset) <= 840
        ? requestedOffset : 480;
      const shiftMs = offsetMinutes * 60000;
      const today = new Date(Date.now() + shiftMs).toISOString().slice(0, 10);
      return runForDay(await collectPersonalTasks(nowen), today, mode, shiftMs);
    },
  },
};
