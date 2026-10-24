import { getDb } from "../db/schema.js";
import { agentWorkflowRuntime, workflowScope } from "./workflowRuntime.js";
import { getAgentTemplate, p2Error } from "./templates.js";
import type { WorkflowRecord, WorkflowRunRecord } from "../automation/types.js";

export function triggerAgentTemplate(run: WorkflowRunRecord, workflow: WorkflowRecord, templateId: string, revision: string) {
  return getDb().transaction(() => {
    const existing = getDb().prepare("SELECT agentRunId FROM agent_trigger_runs WHERE automationRunId=?").get(run.id) as { agentRunId: string } | undefined;
    if (existing) return { agentRunId: existing.agentRunId };
    const template = getAgentTemplate(templateId, workflow.userId, workflow.workspaceId);
    if (template.revision !== revision) throw p2Error("TEMPLATE_CHANGED");
    const current = getDb().prepare("SELECT w.enabled,r.status FROM automation_workflow_runs r JOIN automation_workflows w ON w.id=r.workflowId WHERE r.id=? AND w.id=? AND w.userId=? AND w.workspaceId IS ?")
      .get(run.id, workflow.id, workflow.userId, workflow.workspaceId) as { enabled: number; status: string } | undefined;
    if (!current?.enabled || !["queued", "running"].includes(current.status)) throw p2Error("AUTOMATION_DISABLED");
    // Never forward event/webhook payloads into prompts or let them change scope.
    if (run.eventId) {
      const event = getDb().prepare("SELECT userId,workspaceId,source,depth,resourceType,resourceId FROM automation_events WHERE id=?").get(run.eventId) as { userId: string; workspaceId: string | null; source: string; depth: number; resourceType: string; resourceId: string } | undefined;
      if (!event || event.workspaceId !== workflow.workspaceId || event.userId !== workflow.userId || ["workflow", "plugin", "sync"].includes(event.source) || event.depth > 0) throw p2Error("AGENT_TRIGGER_DENIED", 403);
      if (event.resourceType === "note") {
        const note = getDb().prepare("SELECT notebookId FROM notes WHERE id=? AND isTrashed=0").get(event.resourceId) as { notebookId: string } | undefined;
        const scope = workflowScope(workflow.userId, template.config.input.notebookId, workflow.workspaceId, template.config.input.includeChildren);
        if (!note || !scope.notebookIds.includes(note.notebookId)) throw p2Error("AGENT_TRIGGER_DENIED", 403);
      }
    }
    const created = agentWorkflowRuntime.create(workflow.userId, workflow.workspaceId, { ...template.config.input, templateId, templateRevision: revision });
    getDb().prepare("INSERT INTO agent_trigger_runs(automationRunId,agentRunId,templateId) VALUES (?,?,?)").run(run.id, created.id, templateId);
    return { agentRunId: created.id };
  })();
}
