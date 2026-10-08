/**
 * Personal task digest schedules. Sends events through the existing outbound webhook
 * delivery system; no duplicate webhook transport or user secrets are stored here.
 */
import { Hono } from "hono";
import { getDb } from "../db/schema.js";
import { emitWebhook } from "../services/webhook.js";

export type DigestKind = "morning" | "evening";
interface DigestSettings {
  userId: string;
  morningEnabled: number;
  eveningEnabled: number;
  dueEnabled: number;
  morningTime: string;
  eveningTime: string;
  timezone: string;
}
const router = new Hono();
const DEFAULTS = { morningEnabled: 0, eveningEnabled: 0, dueEnabled: 0, morningTime: "09:00", eveningTime: "21:00", timezone: "Asia/Shanghai" };
let initializedDb: ReturnType<typeof getDb> | null = null;
function init(): void {
  const db = getDb();
  // Restore/replace reconnects SQLite in the same process; initialize the new connection.
  if (initializedDb === db) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_digest_settings (
      userId TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      morningEnabled INTEGER NOT NULL DEFAULT 0,
      eveningEnabled INTEGER NOT NULL DEFAULT 0,
      dueEnabled INTEGER NOT NULL DEFAULT 0,
      morningTime TEXT NOT NULL DEFAULT '09:00',
      eveningTime TEXT NOT NULL DEFAULT '21:00',
      timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
      updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS task_digest_dispatches (
      userId TEXT NOT NULL,
      localDate TEXT NOT NULL,
      kind TEXT NOT NULL,
      emittedAt TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY(userId, localDate, kind)
    );
    CREATE TABLE IF NOT EXISTS task_digest_deadlines (
      userId TEXT NOT NULL,
      taskId TEXT NOT NULL,
      dueAt TEXT NOT NULL,
      PRIMARY KEY(userId, taskId, dueAt)
    );
  `);
  const columns = db.prepare("PRAGMA table_info(task_digest_settings)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "dueEnabled")) {
    db.exec("ALTER TABLE task_digest_settings ADD COLUMN dueEnabled INTEGER NOT NULL DEFAULT 0");
  }
  initializedDb = db;
}
function getSettings(userId: string): DigestSettings {
  init();
  const row = getDb().prepare("SELECT * FROM task_digest_settings WHERE userId=?").get(userId) as DigestSettings | undefined;
  return { userId, ...DEFAULTS, ...row };
}
function localParts(date: Date, timezone: string): { day: string; time: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const v = (type: string) => parts.find((part) => part.type === type)?.value || "00";
  return { day: `${v("year")}-${v("month")}-${v("day")}`, time: `${v("hour")}:${v("minute")}` };
}
function isTimezone(value: string): boolean {
  try { new Intl.DateTimeFormat("en-US", { timeZone: value }); return true; }
  catch { return false; }
}
function taskDay(task: { dueAt: string | null; dueDate: string | null }): string | null {
  return (task.dueAt || task.dueDate || "").slice(0, 10) || null;
}
export function buildTaskDigest(userId: string, kind: DigestKind, now = new Date(), timezone?: string) {
  const tz = timezone || getSettings(userId).timezone;
  const day = localParts(now, tz).day;
  const rows = getDb().prepare(
    "SELECT id,title,priority,dueAt,dueDate,isCompleted,completedAt FROM tasks WHERE userId=? AND workspaceId IS NULL ORDER BY priority DESC, createdAt ASC"
  ).all(userId) as Array<{
    id: string; title: string; priority: number; dueAt: string | null;
    dueDate: string | null; isCompleted: number; completedAt: string | null;
  }>;
  const completedToday = rows.filter((task) =>
    task.completedAt && Number.isFinite(Date.parse(task.completedAt))
      && localParts(new Date(task.completedAt), tz).day === day);
  const dueToday = rows.filter((task) => taskDay(task) === day);
  const overdue = rows.filter((task) => !task.isCompleted && taskDay(task) !== null && taskDay(task)! < day);
  const pendingToday = dueToday.filter((task) => !task.isCompleted);
  const completedDueToday = dueToday.filter((task) => !!task.isCompleted);
  const focus = kind === "morning" ? pendingToday.concat(overdue) : pendingToday;
  const details = focus.slice(0, 8).map((task) => ({ taskId: task.id, title: task.title, dueAt: task.dueAt, dueDate: task.dueDate }));
  const counts = {
    dueToday: dueToday.length,
    pendingToday: pendingToday.length,
    completedDueToday: completedDueToday.length,
    completedToday: completedToday.length,
    overdue: overdue.length,
  };
  const summary = kind === "morning"
    ? `今日到期 ${counts.dueToday} 项，待完成 ${counts.pendingToday} 项，逾期 ${counts.overdue} 项`
    : `今日完成 ${counts.completedToday} 项，今日到期任务完成 ${counts.completedDueToday}/${counts.dueToday} 项，尚未完成 ${counts.pendingToday} 项`;
  return { kind, date: day, timezone: tz, summary, counts, tasks: details };
}
router.get("/", (c) => {
  const userId = c.req.header("X-User-Id") || "";
  if (!userId) return c.json({ error: "Unauthorized" }, 401);
  return c.json(getSettings(userId));
});
router.put("/", async (c) => {
  const userId = c.req.header("X-User-Id") || "";
  if (!userId) return c.json({ error: "Unauthorized" }, 401);
  const input = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const existing = getSettings(userId);
  const morningTime = String(input.morningTime ?? existing.morningTime);
  const eveningTime = String(input.eveningTime ?? existing.eveningTime);
  const timezone = String(input.timezone ?? existing.timezone);
  const isClock = (time: string) => /^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(time);
  if (!isClock(morningTime) || !isClock(eveningTime) || !isTimezone(timezone)) {
    return c.json({ error: "时间或时区格式不正确" }, 400);
  }
  const morningEnabled = input.morningEnabled === undefined ? existing.morningEnabled : (input.morningEnabled === true || input.morningEnabled === 1 ? 1 : 0);
  const eveningEnabled = input.eveningEnabled === undefined ? existing.eveningEnabled : (input.eveningEnabled === true || input.eveningEnabled === 1 ? 1 : 0);
  const dueEnabled = input.dueEnabled === undefined ? existing.dueEnabled : (input.dueEnabled === true || input.dueEnabled === 1 ? 1 : 0);
  getDb().prepare(`INSERT INTO task_digest_settings(userId,morningEnabled,eveningEnabled,dueEnabled,morningTime,eveningTime,timezone)
    VALUES (?,?,?,?,?,?,?) ON CONFLICT(userId) DO UPDATE SET
    morningEnabled=excluded.morningEnabled,eveningEnabled=excluded.eveningEnabled,dueEnabled=excluded.dueEnabled,
    morningTime=excluded.morningTime,eveningTime=excluded.eveningTime,
    timezone=excluded.timezone,updatedAt=datetime('now')`
  ).run(userId, morningEnabled, eveningEnabled, dueEnabled, morningTime, eveningTime, timezone);
  return c.json(getSettings(userId));
});
router.get("/preview", (c) => {
  const userId = c.req.header("X-User-Id") || "";
  if (!userId) return c.json({ error: "Unauthorized" }, 401);
  const kind: DigestKind = c.req.query("kind") === "evening" ? "evening" : "morning";
  return c.json(buildTaskDigest(userId, kind));
});
router.post("/test", async (c) => {
  const userId = c.req.header("X-User-Id") || "";
  if (!userId) return c.json({ error: "Unauthorized" }, 401);
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const kind: DigestKind = body.kind === "evening" ? "evening" : "morning";
  const digest = buildTaskDigest(userId, kind);
  await emitWebhook(`task.digest.${kind}`, userId, { ...digest, test: true });
  return c.json({ queued: true, digest });
});
function dispatchTaskDeadlines(setting: DigestSettings, local: { day: string; time: string }): number {
  const tasks = getDb().prepare(
    "SELECT id,title,dueAt FROM tasks WHERE userId=? AND workspaceId IS NULL AND isCompleted=0 AND dueAt IS NOT NULL"
  ).all(setting.userId) as Array<{ id: string; title: string; dueAt: string }>;
  let count = 0;
  for (const task of tasks) {
    const due = task.dueAt.replace(" ", "T");
    const hasOffset = /(?:Z|[+-][0-9]{2}:[0-9]{2})$/.test(due);
    const localDue = hasOffset && Number.isFinite(Date.parse(due))
      ? localParts(new Date(due), setting.timezone)
      : { day: due.slice(0, 10), time: due.slice(11, 16) };
    if (localDue.day !== local.day || localDue.time !== local.time) continue;
    const result = getDb().prepare("INSERT OR IGNORE INTO task_digest_deadlines(userId,taskId,dueAt) VALUES(?,?,?)")
      .run(setting.userId, task.id, task.dueAt);
    if (!result.changes) continue;
    void emitWebhook("task.due", setting.userId, {
      taskId: task.id, title: task.title, dueAt: task.dueAt, date: local.day, time: local.time,
    });
    count++;
  }
  return count;
}

export function dispatchScheduledTaskDigests(now = new Date()): number {
  init();
  const settings = getDb().prepare("SELECT * FROM task_digest_settings WHERE morningEnabled=1 OR eveningEnabled=1 OR dueEnabled=1").all() as DigestSettings[];
  let emitted = 0;
  for (const setting of settings) {
    try {
      const local = localParts(now, setting.timezone);
      if (setting.dueEnabled) emitted += dispatchTaskDeadlines(setting, local);
      const kinds: DigestKind[] = [];
      if (setting.morningEnabled && local.time === setting.morningTime) kinds.push("morning");
      if (setting.eveningEnabled && local.time === setting.eveningTime) kinds.push("evening");
      for (const kind of kinds) {
        const claim = getDb().prepare("INSERT OR IGNORE INTO task_digest_dispatches(userId,localDate,kind) VALUES(?,?,?)")
          .run(setting.userId, local.day, kind);
        if (!claim.changes) continue;
        const digest = buildTaskDigest(setting.userId, kind, now, setting.timezone);
        void emitWebhook(`task.digest.${kind}`, setting.userId, digest);
        emitted++;
      }
    } catch (error) {
      console.error("[task-digest] dispatch failed:", error);
    }
  }
  return emitted;
}
export default router;
