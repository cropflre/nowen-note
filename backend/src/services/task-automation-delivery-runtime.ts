import { createHash, randomUUID } from "node:crypto";

import type { DatabaseAdapter } from "../db/adapters/types";

const DEFAULT_SCAN_INTERVAL_MS = 30_000;
const DEFAULT_LEASE_MS = 45_000;
const SCANNER_LEASE_NAME = "task-automation-delivery";
const OVERDUE_RETENTION_DAYS = 90;

export type TaskAutomationNotificationType = "dependency_ready" | "overdue_daily";

interface DependencyReadyRow {
  taskId: string;
  userId: string;
  taskTitle: string;
  dependencyFingerprint: string;
}

interface OverdueTaskRow {
  taskId: string;
  userId: string;
  taskTitle: string;
  dueAt: string | Date | null;
  dueDate: string | null;
}

interface AutomationDeliveryRow {
  deliveryId: string;
  taskId: string;
  userId: string;
  taskTitle: string;
  type: TaskAutomationNotificationType;
  triggeredAt: string | Date;
  ackedAt: string | Date | null;
}

export interface RecentTaskAutomationDelivery {
  reminderId: string;
  taskId: string;
  taskTitle: string;
  triggeredAt: number;
  type: TaskAutomationNotificationType;
}

export interface TaskAutomationDeliveryScanResult {
  acquired: boolean;
  dependencyReady: number;
  overdue: number;
  materialized: number;
  retired: number;
}

export interface TaskAutomationDeliveryRuntimeOptions {
  instanceId?: string;
  scanIntervalMs?: number;
  leaseMs?: number;
}

function toMs(value: string | Date | null): number | null {
  if (!value) return null;
  const parsed = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function utcDayKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

function dependencyDeliveryId(row: DependencyReadyRow): string {
  const digest = createHash("sha256")
    .update(`${row.userId}:${row.taskId}:${row.dependencyFingerprint}`)
    .digest("hex")
    .slice(0, 20);
  return `dep-ready:${row.taskId}:${digest}`;
}

function overdueDeliveryId(row: OverdueTaskRow, dayKey: string): string {
  return `overdue-daily:${row.taskId}:${dayKey}`;
}

function isOverdue(row: OverdueTaskRow, nowMs: number, dayKey: string): boolean {
  const dueAtMs = toMs(row.dueAt);
  if (dueAtMs !== null) return dueAtMs < nowMs;
  if (!row.dueDate) return false;
  return row.dueDate < dayKey;
}

export function createTaskAutomationDeliveryRuntime(
  adapter: DatabaseAdapter,
  options: TaskAutomationDeliveryRuntimeOptions = {},
) {
  const instanceId = options.instanceId || randomUUID();
  const scanIntervalMs = Math.max(1_000, options.scanIntervalMs ?? DEFAULT_SCAN_INTERVAL_MS);
  const leaseMs = Math.max(scanIntervalMs + 5_000, options.leaseMs ?? DEFAULT_LEASE_MS);
  let timer: ReturnType<typeof setInterval> | null = null;
  let startupTimer: ReturnType<typeof setTimeout> | null = null;
  let activeScan: Promise<TaskAutomationDeliveryScanResult> | null = null;
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

  async function materializeDelivery(input: {
    deliveryId: string;
    taskId: string;
    userId: string;
    taskTitle: string;
    type: TaskAutomationNotificationType;
    scheduledFor: string;
    triggeredAt: string;
  }): Promise<boolean> {
    const result = await adapter.execute(
      `INSERT INTO task_automation_delivery_state (
         "deliveryId", "taskId", "userId", "taskTitle", type,
         "scheduledFor", "triggeredAt", "createdAt", "updatedAt"
       ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT ("deliveryId") DO NOTHING`,
      [
        input.deliveryId,
        input.taskId,
        input.userId,
        input.taskTitle,
        input.type,
        input.scheduledFor,
        input.triggeredAt,
      ],
    );
    return result.changes === 1;
  }

  async function listDependencyReadyCandidates(): Promise<DependencyReadyRow[]> {
    return adapter.queryMany<DependencyReadyRow>(
      `SELECT succ.id AS "taskId",
              succ."userId" AS "userId",
              succ.title AS "taskTitle",
              STRING_AGG(
                d."predecessorTaskId" || ':' || COALESCE(pred."completedAt"::text, 'done'),
                ',' ORDER BY d."predecessorTaskId"
              ) AS "dependencyFingerprint"
         FROM task_dependencies d
         JOIN tasks succ ON succ.id = d."successorTaskId"
         JOIN tasks pred ON pred.id = d."predecessorTaskId"
        WHERE d.type = 'finish_to_start'
          AND succ."isCompleted" = false
        GROUP BY succ.id, succ."userId", succ.title
       HAVING BOOL_AND(pred."isCompleted" = true)`,
    );
  }

  async function listOverdueCandidates(): Promise<OverdueTaskRow[]> {
    return adapter.queryMany<OverdueTaskRow>(
      `SELECT id AS "taskId", "userId", title AS "taskTitle", "dueAt", "dueDate"
         FROM tasks
        WHERE "isCompleted" = false
          AND ("dueAt" IS NOT NULL OR "dueDate" IS NOT NULL)`,
    );
  }

  async function retireInactiveDeliveries(activeDeliveryIds: Set<string>): Promise<number> {
    const pending = await adapter.queryMany<{ deliveryId: string }>(
      `SELECT "deliveryId"
         FROM task_automation_delivery_state
        WHERE "ackedAt" IS NULL`,
    );
    let retired = 0;
    for (const row of pending) {
      if (activeDeliveryIds.has(row.deliveryId)) continue;
      const result = await adapter.execute(
        `UPDATE task_automation_delivery_state
            SET "ackedAt" = CURRENT_TIMESTAMP,
                "updatedAt" = CURRENT_TIMESTAMP
          WHERE "deliveryId" = ? AND "ackedAt" IS NULL`,
        [row.deliveryId],
      );
      retired += result.changes;
    }
    return retired;
  }

  async function cleanupAcknowledgedOverdue(nowMs: number): Promise<void> {
    const cutoff = new Date(nowMs - OVERDUE_RETENTION_DAYS * 24 * 60 * 60 * 1_000).toISOString();
    await adapter.execute(
      `DELETE FROM task_automation_delivery_state
        WHERE type = 'overdue_daily'
          AND "ackedAt" IS NOT NULL
          AND "triggeredAt" < ?`,
      [cutoff],
    );
  }

  async function scanOnce(nowInput: Date | number = new Date()): Promise<TaskAutomationDeliveryScanResult> {
    const nowMs = nowInput instanceof Date ? nowInput.getTime() : Number(nowInput);
    if (!Number.isFinite(nowMs)) throw new Error("Invalid automation scan time");
    if (!(await acquireLease(nowMs))) {
      return { acquired: false, dependencyReady: 0, overdue: 0, materialized: 0, retired: 0 };
    }

    const nowIso = new Date(nowMs).toISOString();
    const dayKey = utcDayKey(nowMs);
    const [dependencyRows, overdueRows] = await Promise.all([
      listDependencyReadyCandidates(),
      listOverdueCandidates(),
    ]);

    const activeDeliveryIds = new Set<string>();
    let dependencyReady = 0;
    let overdue = 0;
    let materialized = 0;

    for (const row of dependencyRows) {
      const deliveryId = dependencyDeliveryId(row);
      activeDeliveryIds.add(deliveryId);
      dependencyReady += 1;
      if (await materializeDelivery({
        deliveryId,
        taskId: row.taskId,
        userId: row.userId,
        taskTitle: row.taskTitle,
        type: "dependency_ready",
        scheduledFor: nowIso,
        triggeredAt: nowIso,
      })) materialized += 1;
    }

    for (const row of overdueRows) {
      if (!isOverdue(row, nowMs, dayKey)) continue;
      const deliveryId = overdueDeliveryId(row, dayKey);
      activeDeliveryIds.add(deliveryId);
      overdue += 1;
      if (await materializeDelivery({
        deliveryId,
        taskId: row.taskId,
        userId: row.userId,
        taskTitle: row.taskTitle,
        type: "overdue_daily",
        scheduledFor: nowIso,
        triggeredAt: nowIso,
      })) materialized += 1;
    }

    const retired = await retireInactiveDeliveries(activeDeliveryIds);
    await cleanupAcknowledgedOverdue(nowMs);

    return { acquired: true, dependencyReady, overdue, materialized, retired };
  }

  async function listRecent(userId: string, _sinceMs = 0): Promise<RecentTaskAutomationDelivery[]> {
    const rows = await adapter.queryMany<AutomationDeliveryRow>(
      `SELECT d."deliveryId", d."taskId", d."userId", d."taskTitle", d.type,
              d."triggeredAt", d."ackedAt"
         FROM task_automation_delivery_state d
         JOIN tasks t ON t.id = d."taskId"
        WHERE d."userId" = ?
          AND d."triggeredAt" IS NOT NULL
          AND d."ackedAt" IS NULL
          AND t."isCompleted" = false
        ORDER BY d."triggeredAt" ASC
        LIMIT 200`,
      [userId],
    );

    return rows.flatMap((row) => {
      const triggeredAt = toMs(row.triggeredAt);
      if (triggeredAt === null) return [];
      return [{
        reminderId: row.deliveryId,
        taskId: row.taskId,
        taskTitle: row.taskTitle,
        triggeredAt,
        type: row.type,
      }];
    });
  }

  async function acknowledge(userId: string, reminderIds: string[]): Promise<number> {
    const ids = [...new Set(reminderIds.filter((id) => typeof id === "string" && id.length > 0))].slice(0, 200);
    let acked = 0;
    for (const deliveryId of ids) {
      const result = await adapter.execute(
        `UPDATE task_automation_delivery_state
            SET "ackedAt" = CURRENT_TIMESTAMP,
                "updatedAt" = CURRENT_TIMESTAMP
          WHERE "deliveryId" = ?
            AND "userId" = ?
            AND "triggeredAt" IS NOT NULL
            AND "ackedAt" IS NULL`,
        [deliveryId, userId],
      );
      acked += result.changes;
    }
    return acked;
  }

  function start(): void {
    if (timer || startupTimer || stopped) return;
    const run = () => {
      if (stopped || activeScan) return;
      activeScan = scanOnce()
        .catch((error) => {
          console.warn("[task-automation] PostgreSQL delivery scan failed:", error instanceof Error ? error.message : String(error));
          return { acquired: false, dependencyReady: 0, overdue: 0, materialized: 0, retired: 0 };
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

export type TaskAutomationDeliveryRuntime = ReturnType<typeof createTaskAutomationDeliveryRuntime>;
