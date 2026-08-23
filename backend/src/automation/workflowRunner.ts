import crypto from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { getDb } from "../db/schema.js";
import { getPluginService } from "../plugins/pluginService.js";
import { evaluateCondition } from "./conditionEvaluator.js";
import { rowToEvent } from "./eventPublisher.js";
import { resolveTemplates } from "./templateResolver.js";
import type { ExecutionVariables, NowenEvent, WorkflowDefinition, WorkflowRecord, WorkflowRunRecord, WorkflowStep } from "./types.js";
import { WorkflowRepository } from "./workflowRepository.js";

const RETRYABLE = new Set(["NETWORK_UNAVAILABLE", "RATE_LIMITED", "REMOTE_TIMEOUT", "PLUGIN_WORKER_CRASH", "PLUGIN_TIMEOUT"]);
const RETRY_DELAYS = [1000, 5000, 30000];

function preview(value: unknown): string {
  const text = JSON.stringify(value ?? null);
  return Buffer.byteLength(text, "utf8") <= 4096 ? text : `${text.slice(0, 4000)}…`;
}

function codeOf(error: unknown): string {
  return String((error as { code?: string })?.code || "AUTOMATION_STEP_FAILED");
}

export class WorkflowRunner {
  constructor(private readonly repository = new WorkflowRepository()) {}

  async run(runId: string): Promise<void> {
    const run = this.repository.getRun(runId);
    if (!run || run.status === "cancelled") return;
    const workflow = this.repository.get(run.workflowId);
    if (!workflow) return this.fail(runId, "AUTOMATION_NOT_FOUND", "工作流不存在");
    const definition = JSON.parse(workflow.definitionJson) as WorkflowDefinition;
    const event = this.loadEvent(run, workflow);
    const variables: ExecutionVariables = {
      event,
      steps: this.loadPreviousOutputs(runId),
      workflow: { id: workflow.id, name: workflow.name },
      user: { id: workflow.userId },
      workspace: { id: workflow.workspaceId },
    };
    const startedAt = new Date().toISOString();
    getDb().prepare("UPDATE automation_workflow_runs SET status='running',startedAt=COALESCE(startedAt,?),resumeAt=NULL,errorCode=NULL,errorMessage=NULL WHERE id=? AND status IN ('queued','waiting')")
      .run(startedAt, runId);
    let index = run.currentStep;
    try {
      while (index < definition.steps.length) {
        const latest = this.repository.getRun(runId);
        if (!latest || latest.status === "cancelled") return;
        const step = definition.steps[index];
        const outcome = await this.executeStep(run, workflow, step, variables);
        if (outcome.waitUntil) {
          getDb().prepare("UPDATE automation_workflow_runs SET status='waiting',resumeAt=?,currentStep=?,lockedBy=NULL,lockedAt=NULL WHERE id=?")
            .run(outcome.waitUntil, index + 1, runId);
          return;
        }
        if (outcome.output !== undefined) variables.steps[step.id] = { output: outcome.output };
        if (outcome.stop) break;
        if (outcome.nextStepId) {
          const target = definition.steps.findIndex((candidate) => candidate.id === outcome.nextStepId);
          if (target < 0) throw Object.assign(new Error(`步骤跳转目标不存在: ${outcome.nextStepId}`), { code: "AUTOMATION_DEFINITION_INVALID" });
          index = target;
        } else index += 1;
        getDb().prepare("UPDATE automation_workflow_runs SET currentStep=? WHERE id=?").run(index, runId);
      }
      getDb().prepare("UPDATE automation_workflow_runs SET status='completed',finishedAt=?,currentStep=?,lockedBy=NULL,lockedAt=NULL WHERE id=? AND status='running'")
        .run(new Date().toISOString(), definition.steps.length, runId);
    } catch (error) {
      this.fail(runId, codeOf(error), error instanceof Error ? error.message : String(error));
    }
  }

  private async executeStep(run: WorkflowRunRecord, workflow: WorkflowRecord, step: WorkflowStep, variables: ExecutionVariables): Promise<{ output?: unknown; nextStepId?: string; waitUntil?: string; stop?: boolean }> {
    const idempotencyKey = `${run.id}:${step.id}`;
    const existing = getDb().prepare("SELECT * FROM automation_workflow_steps WHERE runId=? AND stepId=?").get(run.id, step.id) as Record<string, unknown> | undefined;
    if (existing?.status === "completed" && existing.outputPreview) {
      try { return { output: JSON.parse(String(existing.outputPreview)) }; } catch { return {}; }
    }
    const stepRecordId = existing?.id || crypto.randomUUID();
    const startedAt = new Date().toISOString();
    const input = step.type === "action" ? resolveTemplates(step.input || {}, variables) : step.type === "transform" ? resolveTemplates(step.output, variables) : step.type === "condition" ? resolveTemplates(step.if, variables) : {};
    getDb().prepare(`INSERT INTO automation_workflow_steps
      (id,runId,stepId,stepType,pluginId,actionId,status,attempt,maxAttempts,idempotencyKey,startedAt,inputJson)
      VALUES (?,?,?,?,?,?,'running',0,?,?,?,?)
      ON CONFLICT(runId,stepId) DO UPDATE SET status='running',startedAt=excluded.startedAt,inputJson=excluded.inputJson,errorCode=NULL,errorMessage=NULL`)
      .run(stepRecordId, run.id, step.id, step.type, step.type === "action" ? step.pluginId : null, step.type === "action" ? step.actionId : null,
        step.type === "action" ? Math.min(3, Math.max(1, step.maxAttempts || 3)) : 1, idempotencyKey, startedAt, preview(input));
    try {
      let result: { output?: unknown; nextStepId?: string; waitUntil?: string; stop?: boolean };
      if (step.type === "action") result = { output: await this.executeAction(run, workflow, step, input as Record<string, unknown>, idempotencyKey) };
      else if (step.type === "condition") {
        const condition = input as { left: unknown; operator: string; right?: unknown };
        const passed = evaluateCondition(condition.left, condition.operator, condition.right);
        const branch = passed ? step.then : step.else;
        result = branch === "stop" ? { output: passed, stop: true } : { output: passed, ...(branch ? { nextStepId: branch } : {}) };
      } else if (step.type === "transform") result = { output: input };
      else if (step.type === "delay") result = { waitUntil: new Date(Date.now() + step.seconds * 1000).toISOString() };
      else result = { stop: true, output: { reason: step.reason || "stopped" } };
      getDb().prepare("UPDATE automation_workflow_steps SET status='completed',finishedAt=?,outputPreview=? WHERE runId=? AND stepId=?")
        .run(new Date().toISOString(), preview(result.output), run.id, step.id);
      return result;
    } catch (error) {
      getDb().prepare("UPDATE automation_workflow_steps SET status='failed',finishedAt=?,errorCode=?,errorMessage=? WHERE runId=? AND stepId=?")
        .run(new Date().toISOString(), codeOf(error), (error instanceof Error ? error.message : String(error)).slice(0, 2000), run.id, step.id);
      throw error;
    }
  }

  private async executeAction(run: WorkflowRunRecord, workflow: WorkflowRecord, step: Extract<WorkflowStep, { type: "action" }>, input: Record<string, unknown>, idempotencyKey: string): Promise<unknown> {
    const plugin = getPluginService().get(step.pluginId) as { actions?: Array<{ id: string; idempotent?: boolean; retryable?: boolean }> };
    const action = plugin.actions?.find((candidate) => candidate.id === step.actionId);
    const requestedAttempts = Math.min(3, Math.max(1, step.maxAttempts || 3));
    const maxAttempts = action?.idempotent === true && action.retryable !== false ? requestedAttempts : 1;
    const prior = getDb().prepare("SELECT resultJson FROM automation_idempotency WHERE idempotencyKey=? AND operation=?").get(idempotencyKey, "plugin-action") as { resultJson: string } | undefined;
    if (prior) return JSON.parse(prior.resultJson);
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      getDb().prepare("UPDATE automation_workflow_steps SET attempt=?,maxAttempts=? WHERE runId=? AND stepId=?").run(attempt, maxAttempts, run.id, step.id);
      try {
        const execution = await getPluginService().execute(step.pluginId, step.actionId, workflow.userId, workflow.workspaceId, input, undefined, {
          source: "workflow", sourceId: workflow.id, correlationId: run.correlationId, causationId: run.eventId || undefined,
          depth: (this.loadEvent(run, workflow).metadata.depth || 0) + 1, idempotencyKey,
        });
        getDb().prepare("INSERT OR IGNORE INTO automation_idempotency(idempotencyKey,operation,resultJson,createdAt) VALUES (?,?,?,?)")
          .run(idempotencyKey, "plugin-action", JSON.stringify(execution.result), new Date().toISOString());
        return execution.result;
      } catch (error) {
        lastError = error;
        if (attempt >= maxAttempts || !RETRYABLE.has(codeOf(error))) break;
        await delay(RETRY_DELAYS[attempt - 1]);
      }
    }
    throw lastError;
  }

  private loadEvent(run: WorkflowRunRecord, workflow: WorkflowRecord): NowenEvent {
    if (run.eventId) {
      const row = getDb().prepare("SELECT * FROM automation_events WHERE id=?").get(run.eventId) as Record<string, unknown> | undefined;
      if (row) return rowToEvent(row);
    }
    return {
      id: `manual:${run.id}`, type: "workflow.manual", apiVersion: 1, occurredAt: run.createdAt,
      actor: { userId: workflow.userId }, scope: workflow.workspaceId ? { type: "workspace", workspaceId: workflow.workspaceId } : { type: "personal" },
      resource: { type: "workflow", id: workflow.id }, data: {},
      metadata: { source: "user", correlationId: run.correlationId, depth: 0 },
    };
  }

  private loadPreviousOutputs(runId: string): Record<string, { output: unknown }> {
    const rows = getDb().prepare("SELECT stepId,outputPreview FROM automation_workflow_steps WHERE runId=? AND status='completed'").all(runId) as Array<{ stepId: string; outputPreview: string | null }>;
    const outputs: Record<string, { output: unknown }> = {};
    for (const row of rows) {
      try { outputs[row.stepId] = { output: JSON.parse(row.outputPreview || "null") }; } catch { outputs[row.stepId] = { output: row.outputPreview }; }
    }
    return outputs;
  }

  private fail(runId: string, code: string, message: string): void {
    getDb().prepare("UPDATE automation_workflow_runs SET status='failed',finishedAt=?,errorCode=?,errorMessage=?,requiresAttention=1,lockedBy=NULL,lockedAt=NULL WHERE id=?")
      .run(new Date().toISOString(), code, message.slice(0, 2000), runId);
  }
}
