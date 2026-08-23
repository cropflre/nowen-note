import crypto from "node:crypto";
import { getDb } from "../db/schema.js";
import { eventPublisher } from "./eventPublisher.js";
import type { WorkflowRecord } from "./types.js";
import { WorkflowRepository } from "./workflowRepository.js";
import { WorkflowRunner } from "./workflowRunner.js";

const INSTANCE_ID = `automation-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
const GLOBAL_CONCURRENCY = 4;
const EVENT_BATCH = 100;

class AutomationRuntime {
  private timer: NodeJS.Timeout | null = null;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private ticking = false;
  private active = new Map<string, string>();
  private repository = new WorkflowRepository();
  private runner = new WorkflowRunner(this.repository);

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), 1000);
    this.timer.unref();
    this.cleanupTimer = setInterval(() => eventPublisher.cleanup(), 60 * 60 * 1000);
    this.cleanupTimer.unref();
    eventPublisher.publish({ type: "app.started", userId: "system", resourceType: "app", resourceId: "nowen", source: "system", sourceId: INSTANCE_ID, data: {} });
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.timer = null;
    this.cleanupTimer = null;
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      this.dispatchEvents();
      this.claimSchedules();
      this.dispatchRuns();
    } finally {
      this.ticking = false;
    }
  }

  private dispatchEvents(): void {
    const rows = getDb().prepare("SELECT * FROM automation_events WHERE dispatchState='pending' ORDER BY occurredAt LIMIT ?").all(EVENT_BATCH) as Array<Record<string, unknown>>;
    for (const event of rows) {
      const claimed = getDb().prepare("UPDATE automation_events SET dispatchState='processing',lockedBy=?,lockedAt=? WHERE id=? AND dispatchState='pending'")
        .run(INSTANCE_ID, new Date().toISOString(), event.id).changes;
      if (!claimed) continue;
      try {
        const workflows = getDb().prepare("SELECT * FROM automation_workflows WHERE enabled=1 AND triggerType='event'").all() as WorkflowRecord[];
        for (const workflow of workflows) {
          const trigger = JSON.parse(workflow.triggerConfigJson) as { event?: string };
          if (trigger.event !== event.type) continue;
          if (workflow.ignoreSync && event.source === "sync") continue;
          if (workflow.ignoreBulk && event.batchId) continue;
          this.repository.createRun(workflow, String(event.id), String(event.correlationId));
        }
        getDb().prepare("UPDATE automation_events SET dispatchState='dispatched',dispatchedAt=?,lockedBy=NULL,lockedAt=NULL WHERE id=?")
          .run(new Date().toISOString(), event.id);
      } catch {
        getDb().prepare("UPDATE automation_events SET dispatchState='pending',lockedBy=NULL,lockedAt=NULL WHERE id=?").run(event.id);
      }
    }
  }

  private claimSchedules(): void {
    const now = new Date().toISOString();
    const schedules = getDb().prepare(`SELECT s.*,w.* FROM automation_schedules s JOIN automation_workflows w ON w.id=s.workflowId
      WHERE s.enabled=1 AND w.enabled=1 AND s.nextRunAt<=? AND (s.lockedAt IS NULL OR s.lockedAt<?) ORDER BY s.nextRunAt LIMIT 20`)
      .all(now, new Date(Date.now() - 60_000).toISOString()) as Array<Record<string, unknown>>;
    for (const schedule of schedules) {
      const claimed = getDb().prepare("UPDATE automation_schedules SET lockedBy=?,lockedAt=? WHERE workflowId=? AND enabled=1 AND nextRunAt<=?")
        .run(INSTANCE_ID, now, schedule.workflowId, now).changes;
      if (!claimed) continue;
      const workflow = this.repository.get(String(schedule.workflowId));
      if (!workflow) continue;
      const event = eventPublisher.publish({
        type: "schedule.triggered", userId: workflow.userId, workspaceId: workflow.workspaceId, resourceType: "workflow", resourceId: workflow.id,
        source: "system", sourceId: "scheduler", data: { scheduledFor: schedule.nextRunAt, timezone: schedule.timezone },
      });
      this.repository.createRun(workflow, event.id, event.metadata.correlationId);
      const nextRunAt = this.repository.nextSchedule(String(schedule.cronExpression), String(schedule.timezone), new Date());
      getDb().prepare("UPDATE automation_schedules SET lastRunAt=?,nextRunAt=?,lockedBy=NULL,lockedAt=NULL WHERE workflowId=?")
        .run(now, nextRunAt, workflow.id);
    }
  }

  private dispatchRuns(): void {
    if (this.active.size >= GLOBAL_CONCURRENCY) return;
    const available = GLOBAL_CONCURRENCY - this.active.size;
    const rows = getDb().prepare(`SELECT * FROM automation_workflow_runs r
      WHERE (r.status='queued' OR (r.status='waiting' AND r.resumeAt<=?))
      AND NOT EXISTS (SELECT 1 FROM automation_workflow_runs x WHERE x.workflowId=r.workflowId AND x.status='running')
      ORDER BY r.createdAt LIMIT ?`).all(new Date().toISOString(), available) as Array<Record<string, unknown>>;
    for (const row of rows) {
      if ([...this.active.values()].includes(String(row.workflowId))) continue;
      const claimed = getDb().prepare("UPDATE automation_workflow_runs SET lockedBy=?,lockedAt=? WHERE id=? AND status IN ('queued','waiting')")
        .run(INSTANCE_ID, new Date().toISOString(), row.id).changes;
      if (!claimed) continue;
      this.active.set(String(row.id), String(row.workflowId));
      void this.runner.run(String(row.id)).finally(() => this.active.delete(String(row.id)));
    }
  }

  status(): Record<string, unknown> {
    const db = getDb();
    const count = (sql: string, ...params: unknown[]) => Number((db.prepare(sql).get(...params) as { count: number }).count);
    const oldest = db.prepare("SELECT MIN(createdAt) AS value FROM automation_workflow_runs WHERE status='queued'").get() as { value: string | null };
    return {
      instanceId: INSTANCE_ID,
      pendingEvents: count("SELECT COUNT(*) count FROM automation_events WHERE dispatchState='pending'"),
      queuedWorkflows: count("SELECT COUNT(*) count FROM automation_workflow_runs WHERE status='queued'"),
      runningWorkflows: count("SELECT COUNT(*) count FROM automation_workflow_runs WHERE status='running'"),
      failedLastHour: count("SELECT COUNT(*) count FROM automation_workflow_runs WHERE status='failed' AND finishedAt>=?", new Date(Date.now() - 3600000).toISOString()),
      oldestQueuedAt: oldest.value,
      globalConcurrency: GLOBAL_CONCURRENCY,
      active: this.active.size,
    };
  }
}

export const automationRuntime = new AutomationRuntime();
