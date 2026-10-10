import { getDb } from "../db/schema.js";
import { getUserWorkspaceRole, hasRole, isSystemAdmin } from "../middleware/acl.js";
import { getPluginService } from "../plugins/pluginService.js";
import { logAudit } from "../services/audit.js";
import { eventPublisher } from "./eventPublisher.js";
import type { WorkflowDefinition, WorkflowRecord } from "./types.js";
import { validateWorkflowDefinition } from "./workflowValidator.js";
import { WorkflowRepository, type WorkflowInput } from "./workflowRepository.js";

function coded(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

export class WorkflowService {
  constructor(readonly repository = new WorkflowRepository()) {
    this.recover();
  }

  private recover(): void {
    getDb().prepare(`UPDATE automation_workflow_runs SET status='interrupted',finishedAt=?,errorCode='HOST_RESTARTED',errorMessage='Nowen 重启，运行已中断',requiresAttention=1,lockedBy=NULL,lockedAt=NULL WHERE status='running'`)
      .run(new Date().toISOString());
    getDb().prepare("UPDATE automation_workflow_runs SET lockedBy=NULL,lockedAt=NULL WHERE status IN ('queued','waiting')").run();
    getDb().prepare("UPDATE automation_events SET dispatchState='pending',lockedBy=NULL,lockedAt=NULL WHERE dispatchState='processing'").run();
    getDb().prepare("UPDATE automation_schedules SET lockedBy=NULL,lockedAt=NULL").run();
  }

  private assertManage(record: WorkflowRecord, userId: string): void {
    if (isSystemAdmin(userId) || record.userId === userId) return;
    if (record.workspaceId && hasRole(getUserWorkspaceRole(record.workspaceId, userId), "admin")) return;
    throw coded("无权管理该工作流", "RESOURCE_FORBIDDEN");
  }

  private assertWorkspaceManage(workspaceId: string | null | undefined, userId: string): void {
    if (!workspaceId || isSystemAdmin(userId)) return;
    if (!hasRole(getUserWorkspaceRole(workspaceId, userId), "admin")) throw coded("工作区自动化仅 owner/admin 可管理", "RESOURCE_FORBIDDEN");
  }

  private validateActions(definition: WorkflowDefinition): void {
    const actions = new Set(getPluginService().listActions().map((item: any) => `${item.pluginId}:${item.id || item.actionId}`));
    for (const step of definition.steps) if (step.type === "action" && !actions.has(`${step.pluginId}:${step.actionId}`)) {
      throw coded(`插件 Action 不存在或未启用: ${step.pluginId}/${step.actionId}`, "PLUGIN_ACTION_NOT_FOUND");
    }
  }

  list(userId: string): Record<string, unknown>[] {
    return this.repository.list(userId, isSystemAdmin(userId)).map((record) => this.publicRecord(record));
  }

  get(id: string, userId: string): Record<string, unknown> {
    const record = this.repository.get(id);
    if (!record) throw coded("工作流不存在", "AUTOMATION_NOT_FOUND");
    this.assertManage(record, userId);
    return this.publicRecord(record);
  }

  create(userId: string, raw: Omit<WorkflowInput, "definition"> & { definition: unknown }): Record<string, unknown> {
    this.assertWorkspaceManage(raw.workspaceId, userId);
    const definition = validateWorkflowDefinition(raw.definition);
    this.validateActions(definition);
    if (!raw.name?.trim() || raw.name.length > 120) throw coded("工作流名称无效", "INVALID_ARGUMENT");
    const result = this.repository.create(userId, { ...raw, name: raw.name.trim(), definition });
    logAudit(userId, "system", "workflow_create", { workflowId: result.workflow.id }, { targetType: "automation", targetId: result.workflow.id });
    return { ...this.publicRecord(result.workflow), webhookCredentials: result.webhook };
  }

  update(id: string, userId: string, raw: Omit<WorkflowInput, "definition"> & { definition: unknown }): Record<string, unknown> {
    const existing = this.repository.get(id);
    if (!existing) throw coded("工作流不存在", "AUTOMATION_NOT_FOUND");
    this.assertManage(existing, userId);
    this.assertWorkspaceManage(raw.workspaceId, userId);
    const definition = validateWorkflowDefinition(raw.definition);
    this.validateActions(definition);
    const result = this.repository.update(id, { ...raw, name: raw.name.trim(), definition });
    logAudit(userId, "system", "workflow_update", { workflowId: id }, { targetType: "automation", targetId: id });
    return { ...this.publicRecord(result.workflow), webhookCredentials: result.webhook };
  }

  enable(id: string, userId: string, enabled: boolean): Record<string, unknown> {
    const record = this.repository.get(id);
    if (!record) throw coded("工作流不存在", "AUTOMATION_NOT_FOUND");
    this.assertManage(record, userId);
    if (enabled) this.validateActions(JSON.parse(record.definitionJson) as WorkflowDefinition);
    const updated = this.repository.setEnabled(id, enabled);
    logAudit(userId, "system", enabled ? "workflow_enable" : "workflow_disable", { workflowId: id }, { targetType: "automation", targetId: id });
    return this.publicRecord(updated);
  }

  remove(id: string, userId: string): void {
    const record = this.repository.get(id);
    if (!record) throw coded("工作流不存在", "AUTOMATION_NOT_FOUND");
    this.assertManage(record, userId);
    this.repository.remove(id);
    logAudit(userId, "system", "workflow_delete", { workflowId: id }, { targetType: "automation", targetId: id });
  }

  run(id: string, userId: string): Record<string, unknown> {
    const record = this.repository.get(id);
    if (!record) throw coded("工作流不存在", "AUTOMATION_NOT_FOUND");
    this.assertManage(record, userId);
    const run = this.repository.createRun(record, null);
    logAudit(userId, "system", "workflow_run", { workflowId: id, runId: run.id }, { targetType: "automation_run", targetId: run.id });
    return run as unknown as Record<string, unknown>;
  }

  runs(id: string, userId: string): Record<string, unknown>[] {
    const record = this.repository.get(id);
    if (!record) throw coded("工作流不存在", "AUTOMATION_NOT_FOUND");
    this.assertManage(record, userId);
    return this.repository.listRuns(id) as unknown as Record<string, unknown>[];
  }

  runDetail(id: string, userId: string): Record<string, unknown> {
    const run = this.repository.getRun(id);
    if (!run) throw coded("运行记录不存在", "AUTOMATION_RUN_NOT_FOUND");
    const workflow = this.repository.get(run.workflowId)!;
    this.assertManage(workflow, userId);
    return { ...run, steps: this.repository.listSteps(id) };
  }

  cancelRun(id: string, userId: string): Record<string, unknown> {
    const run = this.repository.getRun(id);
    if (!run) throw coded("运行记录不存在", "AUTOMATION_RUN_NOT_FOUND");
    this.assertManage(this.repository.get(run.workflowId)!, userId);
    getDb().prepare(`UPDATE automation_workflow_runs SET status='cancelled',finishedAt=?,errorCode='AUTOMATION_CANCELLED',errorMessage='用户取消',lockedBy=NULL,lockedAt=NULL WHERE id=? AND status IN ('queued','running','waiting')`)
      .run(new Date().toISOString(), id);
    logAudit(userId, "system", "workflow_cancel", { runId: id }, { targetType: "automation_run", targetId: id });
    return this.repository.getRun(id) as unknown as Record<string, unknown>;
  }

  events(userId: string): ReturnType<typeof eventPublisher.list> {
    return eventPublisher.list(userId, isSystemAdmin(userId));
  }

  replayEvent(id: string, userId: string): ReturnType<typeof eventPublisher.replay> {
    if (!isSystemAdmin(userId)) throw coded("仅管理员可重放事件", "RESOURCE_FORBIDDEN");
    return eventPublisher.replay(id, userId);
  }

  private publicRecord(record: WorkflowRecord): Record<string, unknown> {
    const schedule = getDb().prepare("SELECT cronExpression,timezone,nextRunAt,lastRunAt,enabled FROM automation_schedules WHERE workflowId=?").get(record.id);
    const webhook = getDb().prepare("SELECT enabled,lastTriggeredAt,createdAt,secretEncrypted IS NOT NULL AS signatureRequired FROM automation_webhooks WHERE workflowId=?").get(record.id);
    return { ...record, enabled: record.enabled === 1, ignoreSync: record.ignoreSync === 1, ignoreBulk: record.ignoreBulk === 1,
      trigger: JSON.parse(record.triggerConfigJson), definition: JSON.parse(record.definitionJson), schedule: schedule || null, webhook: webhook || null };
  }
}

let singleton: WorkflowService | null = null;
export function getWorkflowService(): WorkflowService {
  if (!singleton) singleton = new WorkflowService();
  return singleton;
}
