import { randomUUID } from "node:crypto";

import {
  DbStatementChangeError,
  type DatabaseAdapter,
} from "../db/adapters/types";

const DEFAULT_SCAN_INTERVAL_MS = 30_000;
const DEFAULT_LEASE_MS = 45_000;
const SCANNER_LEASE_NAME = "task-reminder-delivery";
const MIN_TIMEZONE_OFFSET_MINUTES = -14 * 60;
const MAX_TIMEZONE_OFFSET_MINUTES = 14 * 60;

interface ReminderCandidateRow {
  reminderId: string;
  taskId: string;
  userId: string;
  taskTitle: string;
  offsetMinutes: number;
  timezoneOffsetMinutes: number | null;
  snoozedUntil: string | Date | null;
  lastNotifiedAt: string | Date | null;
  dueDate: string | null;
  dueAt: string | Date | null;
}

interface DeliveryStateRow {
  reminderId: string;
  taskId: string;
  userId: string;
  taskTitle: string;
  scheduledFor: string | Date;
  triggeredAt: string | Date | null;
  ackedAt: string | Date | null;
}

export interface RecentTaskReminderDelivery {
  reminderId: string;
  taskId: string;
  taskTitle: string;
  triggeredAt: number;
  type: "task_reminder";
}

export interface TaskReminderDeliveryScanResult {
  acquired: boolean;
  scanned: number;
  due: number;
  materialized: number;
}

export interface TaskReminderDeliveryRuntimeOptions {
  instanceId?: string;
  scanIntervalMs?: number;
  leaseMs?: number;
}

function toMs(value: string | Date | null): number | null {
  if (!value) return null;
  const parsed = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeTimezoneOffsetMinutes(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return null;
  if (parsed < MIN_TIMEZONE_OFFSET_MINUTES || parsed > MAX_TIMEZONE_OFFSET_MINUTES) return null;
  return parsed;
}

function parseFloatingLocalDateTime(value: string, timezoneOffsetMinutes: number | null): number {
  if (timezoneOffsetMinutes === null) return new Date(value).getTime();
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!match) return Number.NaN;
  const [, year, month, day, hour, minute, second = "0"] = match;
  return Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  ) + timezoneOffsetMinutes * 60_000;
}

export function resolveTaskReminderAtMs(row: {
  dueAt: string | Date | null;
  dueDate: string | null;
  snoozedUntil: string | Date | null;
  offsetMinutes: number;
  timezoneOffsetMinutes: number | null;
}): number | null {
  if (row.snoozedUntil) return toMs(row.snoozedUntil);

  const timezoneOffsetMinutes = normalizeTimezoneOffsetMinutes(row.timezoneOffsetMinutes);
  let dueMs: number | null = null;
  if (row.dueAt instanceof Date) {
    dueMs = toMs(row.dueAt);
  } else if (row.dueAt) {
    const dueAt = String(row.dueAt);
    const hasExplicitZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(dueAt);
    const parsed = hasExplicitZone
      ? new Date(dueAt).getTime()
      : parseFloatingLocalDateTime(dueAt, timezoneOffsetMinutes);
    dueMs = Number.isFinite(parsed) ? parsed : null;
  } else if (row.dueDate) {
    if (timezoneOffsetMinutes === null) {
      const parsed = new Date(`${row.dueDate}T23:59:59`).getTime();
      dueMs = Number.isFinite(parsed) ? parsed : null;
    } else {
      const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(row.dueDate);
      if (match) {
        const [, year, month, day] = match;
        dueMs = Date.UTC(Number(year), Number(month) - 1, Number(day) + 1, 0, 0, 0)
          + timezoneOffsetMinutes * 60_000;
      }
    }
  }

  if (dueMs === null) return null;
  const offsetMinutes = Number(row.offsetMinutes || 0);
  if (!Number.isFinite(offsetMinutes)) return null;
  return dueMs - offsetMinutes * 60_000;
}

export function createTaskReminderDeliveryRuntime(
  adapter: DatabaseAdapter,
  options: TaskReminderDeliveryRuntimeOptions = {},
) {
  const instanceId = options.instanceId || randomUUID();
  const scanIntervalMs = Math.max(1_000, options.scanIntervalMs ?? DEFAULT_SCAN_INTERVAL_MS);
  const leaseMs = Math.max(scanIntervalMs + 5_000, options.leaseMs ?? DEFAULT_LEASE_MS);
  let timer: ReturnType<typeof setInterval> | null = null;
  let startupTimer: ReturnType<typeof setTimeout> | null = null;
  let activeScan: Promise<TaskReminderDeliveryScanResult> | null = null;
  let stopped = false;

  async function acquireLease(nowMs: number): Promise<boolean> {
    const now = new Date(nowMs).toISOString();
    const leaseUntil = new Date(nowMs + leaseMs).toISOString();
    const result = await adapter.execute(
      `INSERT INTO task_reminder_scanner_leases (name, "ownerId", "leaseUntil", "updatedAt")
       VALUES (?, ?, ?, ?)
       ON CONFLICT (name) DO UPDATE
         SET "ownerId" = EXCLUDED."ownerId",
             "leaseUntil" = EXCLUDED."leaseUntil",
             "updatedAt" = EXCLUDED."updatedAt"
       WHERE task_reminder_scanner_leases."leaseUntil" <= EXCLUDED."updatedAt"
          OR task_reminder_scanner_leases."ownerId" = EXCLUDED."ownerId"`,
      [SCANNER_LEASE_NAME, instanceId, leaseUntil, now],
    );
    return result.changes === 1;
  }

  async function materializeCandidate(row: ReminderCandidateRow, nowMs: number): Promise<boolean> {
    const scheduledForMs = resolveTaskReminderAtMs(row);
    if (scheduledForMs === null) return false;

    const lastNotifiedAtMs = toMs(row.lastNotifiedAt);
    const alreadyAcknowledged = lastNotifiedAtMs !== null && lastNotifiedAtMs >= scheduledForMs;
    const scheduledFor = new Date(scheduledForMs).toISOString();
    const triggeredAt = scheduledForMs <= nowMs && !alreadyAcknowledged
      ? new Date(nowMs).toISOString()
      : null;
    const ackedAt = alreadyAcknowledged && lastNotifiedAtMs !== null
      ? new Date(lastNotifiedAtMs).toISOString()
      : null;

    await adapter.execute(
      `INSERT INTO task_reminder_delivery_state (
         "reminderId", "taskId", "userId", "taskTitle", "scheduledFor", "triggeredAt", "ackedAt", "updatedAt"
       ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT ("reminderId") DO UPDATE SET
         "taskId" = EXCLUDED."taskId",
         "userId" = EXCLUDED."userId",
         "taskTitle" = EXCLUDED."taskTitle",
         "scheduledFor" = EXCLUDED."scheduledFor",
         "triggeredAt" = CASE
           WHEN task_reminder_delivery_state."scheduledFor" <> EXCLUDED."scheduledFor"
             THEN EXCLUDED."triggeredAt"
           WHEN task_reminder_delivery_state."ackedAt" IS NOT NULL
             THEN task_reminder_delivery_state."triggeredAt"
           ELSE COALESCE(task_reminder_delivery_state."triggeredAt", EXCLUDED."triggeredAt")
         END,
         "ackedAt" = CASE
           WHEN task_reminder_delivery_state."scheduledFor" = EXCLUDED."scheduledFor"
             THEN task_reminder_delivery_state."ackedAt"
           ELSE EXCLUDED."ackedAt"
         END,
         "updatedAt" = CURRENT_TIMESTAMP`,
      [row.reminderId, row.taskId, row.userId, row.taskTitle, scheduledFor, triggeredAt, ackedAt],
    );
    return scheduledForMs <= nowMs && !alreadyAcknowledged;
  }

  async function scanOnce(nowInput: Date | number = new Date()): Promise<TaskReminderDeliveryScanResult> {
    const nowMs = nowInput instanceof Date ? nowInput.getTime() : Number(nowInput);
    if (!Number.isFinite(nowMs)) throw new Error("Invalid reminder scan time");
    if (!(await acquireLease(nowMs))) {
      return { acquired: false, scanned: 0, due: 0, materialized: 0 };
    }

    const rows = await adapter.queryMany<ReminderCandidateRow>(
      `SELECT r.id AS "reminderId", r."taskId", r."userId", r."offsetMinutes",
              r."timezoneOffsetMinutes", r."snoozedUntil", r."lastNotifiedAt",
              t.title AS "taskTitle", t."dueDate", t."dueAt"
         FROM task_reminders r
         JOIN tasks t ON t.id = r."taskId"
        WHERE r.enabled = true
          AND t."isCompleted" = false
          AND (r."snoozedUntil" IS NOT NULL OR t."dueAt" IS NOT NULL OR t."dueDate" IS NOT NULL)`,
    );

    let due = 0;
    let materialized = 0;
    for (const row of rows) {
      const reminderAtMs = resolveTaskReminderAtMs(row);
      if (reminderAtMs !== null && reminderAtMs <= nowMs) due += 1;
      if (await materializeCandidate(row, nowMs)) materialized += 1;
    }

    await adapter.execute(
      `DELETE FROM task_reminder_delivery_state d
        USING task_reminders r, tasks t
        WHERE d."reminderId" = r.id
          AND r."taskId" = t.id
          AND (r.enabled = false OR t."isCompleted" = true)`,
    );

    return { acquired: true, scanned: rows.length, due, materialized };
  }

  async function listRecent(userId: string, _sinceMs = 0): Promise<RecentTaskReminderDelivery[]> {
    const rows = await adapter.queryMany<DeliveryStateRow>(
      `SELECT d."reminderId", d."taskId", d."userId", d."taskTitle",
              d."scheduledFor", d."triggeredAt", d."ackedAt"
         FROM task_reminder_delivery_state d
         JOIN task_reminders r ON r.id = d."reminderId"
         JOIN tasks t ON t.id = d."taskId"
        WHERE d."userId" = ?
          AND d."triggeredAt" IS NOT NULL
          AND d."ackedAt" IS NULL
          AND r.enabled = true
          AND t."isCompleted" = false
        ORDER BY d."triggeredAt" ASC
        LIMIT 200`,
      [userId],
    );

    return rows.flatMap((row) => {
      const triggeredAt = toMs(row.triggeredAt);
      if (triggeredAt === null) return [];
      return [{
        reminderId: row.reminderId,
        taskId: row.taskId,
        taskTitle: row.taskTitle,
        triggeredAt,
        type: "task_reminder" as const,
      }];
    });
  }

  async function acknowledge(userId: string, reminderIds: string[]): Promise<number> {
    const ids = [...new Set(reminderIds.filter((id) => typeof id === "string" && id.length > 0))].slice(0, 200);
    let acked = 0;

    for (const reminderId of ids) {
      const state = await adapter.queryOne<DeliveryStateRow>(
        `SELECT "reminderId", "taskId", "userId", "taskTitle", "scheduledFor", "triggeredAt", "ackedAt"
           FROM task_reminder_delivery_state
          WHERE "reminderId" = ? AND "userId" = ? AND "triggeredAt" IS NOT NULL AND "ackedAt" IS NULL`,
        [reminderId, userId],
      );
      if (!state) continue;

      const scheduledFor = state.scheduledFor instanceof Date
        ? state.scheduledFor.toISOString()
        : new Date(state.scheduledFor).toISOString();
      try {
        await adapter.executeStatements([
          {
            sql: `UPDATE task_reminder_delivery_state
                     SET "ackedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
                   WHERE "reminderId" = ? AND "userId" = ? AND "ackedAt" IS NULL`,
            params: [reminderId, userId],
            requireChanges: 1,
          },
          {
            sql: `UPDATE task_reminders
                     SET "lastNotifiedAt" = CURRENT_TIMESTAMP,
                         "snoozedUntil" = CASE
                           WHEN "snoozedUntil" IS NOT NULL AND "snoozedUntil" <= ? THEN NULL
                           ELSE "snoozedUntil"
                         END,
                         "updatedAt" = CURRENT_TIMESTAMP
                   WHERE id = ? AND "userId" = ?`,
            params: [scheduledFor, reminderId, userId],
            requireChanges: 1,
          },
        ]);
        acked += 1;
      } catch (error) {
        if (error instanceof DbStatementChangeError) continue;
        throw error;
      }
    }

    return acked;
  }

  function start(): void {
    if (timer || startupTimer || stopped) return;
    const run = () => {
      if (stopped || activeScan) return;
      activeScan = scanOnce()
        .catch((error) => {
          console.warn("[task-reminder] PostgreSQL delivery scan failed:", error instanceof Error ? error.message : String(error));
          return { acquired: false, scanned: 0, due: 0, materialized: 0 };
        })
        .finally(() => {
          activeScan = null;
        });
    };
    startupTimer = setTimeout(() => {
      startupTimer = null;
      run();
    }, 1_000);
    startupTimer.unref?.();
    timer = setInterval(run, scanIntervalMs);
    timer.unref?.();
  }

  async function shutdown(): Promise<void> {
    stopped = true;
    if (startupTimer) clearTimeout(startupTimer);
    if (timer) clearInterval(timer);
    startupTimer = null;
    timer = null;
    if (activeScan) await activeScan;
  }

  return {
    instanceId,
    scanOnce,
    listRecent,
    acknowledge,
    start,
    shutdown,
  };
}

export type TaskReminderDeliveryRuntime = ReturnType<typeof createTaskReminderDeliveryRuntime>;
