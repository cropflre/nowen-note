import crypto from "node:crypto";
import cronParser from "cron-parser";
import { getDb } from "../db/schema.js";
import { encryptAutomationSecret } from "./secretCrypto.js";
import type { WorkflowDefinition, WorkflowRecord, WorkflowRunRecord } from "./types.js";

export interface WorkflowInput {
  name: string;
  description?: string;
  workspaceId?: string | null;
  definition: WorkflowDefinition;
  ignoreSync?: boolean;
  ignoreBulk?: boolean;
}

function nextSchedule(cron: string, timezone: string, currentDate = new Date()): string {
  return cronParser.parseExpression(cron, { currentDate, tz: timezone }).next().toDate().toISOString();
}

export class WorkflowRepository {
  list(userId: string, isAdmin: boolean): WorkflowRecord[] {
    return (isAdmin
      ? getDb().prepare("SELECT * FROM automation_workflows ORDER BY updatedAt DESC").all()
      : getDb().prepare(`SELECT w.* FROM automation_workflows w
          WHERE w.userId=? OR (w.workspaceId IS NOT NULL AND EXISTS (
            SELECT 1 FROM workspace_members wm WHERE wm.workspaceId=w.workspaceId AND wm.userId=?
          )) ORDER BY w.updatedAt DESC`).all(userId, userId)) as WorkflowRecord[];
  }

  get(id: string): WorkflowRecord | undefined {
    return getDb().prepare("SELECT * FROM automation_workflows WHERE id=?").get(id) as WorkflowRecord | undefined;
  }

  create(userId: string, input: WorkflowInput): { workflow: WorkflowRecord; webhook?: { token: string; secret?: string } } {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const trigger = input.definition.trigger;
    getDb().prepare(`INSERT INTO automation_workflows
      (id,name,description,userId,workspaceId,enabled,triggerType,triggerConfigJson,definitionJson,ignoreSync,ignoreBulk,createdAt,updatedAt)
      VALUES (?,?,?,?,?,0,?,?,?,?,?,?,?)`)
      .run(id, input.name, input.description || "", userId, input.workspaceId || null, trigger.type, JSON.stringify(trigger), JSON.stringify(input.definition),
        input.ignoreSync === false ? 0 : 1, input.ignoreBulk === false ? 0 : 1, now, now);
    const webhook = this.configureTrigger(id, input.definition, false);
    return { workflow: this.get(id)!, ...(webhook ? { webhook } : {}) };
  }

  update(id: string, input: WorkflowInput): { workflow: WorkflowRecord; webhook?: { token: string; secret?: string } } {
    const existing = this.get(id);
    if (!existing) throw Object.assign(new Error("工作流不存在"), { code: "AUTOMATION_NOT_FOUND" });
    const trigger = input.definition.trigger;
    getDb().prepare(`UPDATE automation_workflows SET name=?,description=?,workspaceId=?,enabled=0,triggerType=?,triggerConfigJson=?,definitionJson=?,ignoreSync=?,ignoreBulk=?,updatedAt=? WHERE id=?`)
      .run(input.name, input.description || "", input.workspaceId || null, trigger.type, JSON.stringify(trigger), JSON.stringify(input.definition),
        input.ignoreSync === false ? 0 : 1, input.ignoreBulk === false ? 0 : 1, new Date().toISOString(), id);
    const webhook = this.configureTrigger(id, input.definition, true);
    return { workflow: this.get(id)!, ...(webhook ? { webhook } : {}) };
  }

  private configureTrigger(id: string, definition: WorkflowDefinition, rotateWebhook: boolean): { token: string; secret?: string } | undefined {
    const trigger = definition.trigger;
    if (trigger.type !== "schedule") getDb().prepare("DELETE FROM automation_schedules WHERE workflowId=?").run(id);
    if (trigger.type !== "webhook") getDb().prepare("DELETE FROM automation_webhooks WHERE workflowId=?").run(id);
    if (trigger.type === "schedule") {
      const nextRunAt = nextSchedule(trigger.cron, trigger.timezone);
      getDb().prepare(`INSERT INTO automation_schedules(workflowId,cronExpression,timezone,nextRunAt,enabled)
        VALUES (?,?,?,?,0) ON CONFLICT(workflowId) DO UPDATE SET cronExpression=excluded.cronExpression,timezone=excluded.timezone,nextRunAt=excluded.nextRunAt,enabled=0,lockedBy=NULL,lockedAt=NULL`)
        .run(id, trigger.cron, trigger.timezone, nextRunAt);
    }
    if (trigger.type === "webhook") {
      const existing = getDb().prepare("SELECT workflowId FROM automation_webhooks WHERE workflowId=?").get(id);
      if (existing && !rotateWebhook) return undefined;
      const token = crypto.randomBytes(32).toString("base64url");
      const secret = trigger.requireSignature ? crypto.randomBytes(32).toString("base64url") : undefined;
      const encrypted = secret ? encryptAutomationSecret(secret) : undefined;
      getDb().prepare(`INSERT INTO automation_webhooks
        (workflowId,tokenHash,secretEncrypted,secretIv,secretTag,enabled,createdAt)
        VALUES (?,?,?,?,?,0,?) ON CONFLICT(workflowId) DO UPDATE SET tokenHash=excluded.tokenHash,secretEncrypted=excluded.secretEncrypted,secretIv=excluded.secretIv,secretTag=excluded.secretTag,enabled=0,requestsInWindow=0,windowStartedAt=NULL`)
        .run(id, crypto.createHash("sha256").update(token).digest("hex"), encrypted?.encrypted || null, encrypted?.iv || null, encrypted?.tag || null, new Date().toISOString());
      return { token, ...(secret ? { secret } : {}) };
    }
    return undefined;
  }

  setEnabled(id: string, enabled: boolean): WorkflowRecord {
    getDb().transaction(() => {
      getDb().prepare("UPDATE automation_workflows SET enabled=?,updatedAt=? WHERE id=?").run(enabled ? 1 : 0, new Date().toISOString(), id);
      getDb().prepare("UPDATE automation_schedules SET enabled=?,lockedBy=NULL,lockedAt=NULL WHERE workflowId=?").run(enabled ? 1 : 0, id);
      getDb().prepare("UPDATE automation_webhooks SET enabled=? WHERE workflowId=?").run(enabled ? 1 : 0, id);
    })();
    return this.get(id)!;
  }

  remove(id: string): void {
    getDb().prepare("DELETE FROM automation_workflows WHERE id=?").run(id);
  }

  createRun(workflow: WorkflowRecord, eventId: string | null, correlationId: string = crypto.randomUUID()): WorkflowRunRecord {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    getDb().prepare(`INSERT OR IGNORE INTO automation_workflow_runs
      (id,workflowId,eventId,userId,workspaceId,status,currentStep,correlationId,createdAt)
      VALUES (?,?,?,?,?,'queued',0,?,?)`).run(id, workflow.id, eventId, workflow.userId, workflow.workspaceId, correlationId, now);
    const row = eventId
      ? getDb().prepare("SELECT * FROM automation_workflow_runs WHERE workflowId=? AND eventId=?").get(workflow.id, eventId)
      : getDb().prepare("SELECT * FROM automation_workflow_runs WHERE id=?").get(id);
    return row as WorkflowRunRecord;
  }

  getRun(id: string): WorkflowRunRecord | undefined {
    return getDb().prepare("SELECT * FROM automation_workflow_runs WHERE id=?").get(id) as WorkflowRunRecord | undefined;
  }

  listRuns(workflowId: string, limit = 100): WorkflowRunRecord[] {
    return getDb().prepare("SELECT * FROM automation_workflow_runs WHERE workflowId=? ORDER BY createdAt DESC LIMIT ?").all(workflowId, Math.min(500, limit)) as WorkflowRunRecord[];
  }

  listSteps(runId: string): Record<string, unknown>[] {
    return getDb().prepare("SELECT * FROM automation_workflow_steps WHERE runId=? ORDER BY startedAt,id").all(runId) as Record<string, unknown>[];
  }

  nextSchedule(cron: string, timezone: string, currentDate?: Date): string {
    return nextSchedule(cron, timezone, currentDate);
  }
}
