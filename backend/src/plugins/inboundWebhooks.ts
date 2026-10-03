import crypto from "node:crypto";
import { getDb } from "../db/schema.js";
import { WorkflowRepository } from "../automation/workflowRepository.js";
import { eventPublisher } from "../automation/eventPublisher.js";
import { PluginRegistry } from "./registry.js";
import type { PluginInboundWebhookContribution, PluginManifest } from "./types.js";

export interface InboundWebhookRow {
  pluginId: string; hookId: string; ownerUserId: string; tokenHash: string;
  tokenVersion: number; workflowId: string | null; declarationJson: string;
  requestsInWindow: number; windowStartedAt: number;
}

export function requireInboundDeclaration(pluginId: string, hookId: string): PluginInboundWebhookContribution {
  const record = new PluginRegistry().get(pluginId);
  if (!record || record.status !== "enabled") throw Object.assign(new Error("插件未启用"), { code: "PLUGIN_NOT_ENABLED" });
  const manifest = JSON.parse(record.manifestJson) as PluginManifest;
  const hook = manifest.apiVersion === 2 && manifest.runtime !== "declarative" ? manifest.contributes?.inboundWebhooks?.find((item) => item.id === hookId) : undefined;
  if (!hook) throw Object.assign(new Error("Inbound Webhook 未声明"), { code: "PLUGIN_ACTION_NOT_FOUND" });
  return hook;
}

export function listInboundWebhooks(pluginId: string, userId: string) {
  return getDb().prepare("SELECT hookId FROM plugin_inbound_webhooks WHERE pluginId=? AND ownerUserId=?").all(pluginId, userId);
}

export function removeInboundWebhook(pluginId: string, hookId: string, userId: string): void {
  const db = getDb();
  db.transaction(() => {
    const row = db.prepare("SELECT workflowId FROM plugin_inbound_webhooks WHERE pluginId=? AND hookId=? AND ownerUserId=?").get(pluginId, hookId, userId) as { workflowId: string | null } | undefined;
    db.prepare("DELETE FROM plugin_inbound_webhooks WHERE pluginId=? AND hookId=? AND ownerUserId=?").run(pluginId, hookId, userId);
    if (row?.workflowId) new WorkflowRepository().remove(row.workflowId);
  })();
}

export function createInboundWebhook(pluginId: string, hookId: string, userId: string): { path: string } {
  const hook = requireInboundDeclaration(pluginId, hookId);
  const db = getDb();
  const user = db.prepare("SELECT tokenVersion,isDisabled FROM users WHERE id=?").get(userId) as { tokenVersion: number; isDisabled: number } | undefined;
  if (!user || user.isDisabled) throw Object.assign(new Error("用户不可用"), { code: "RESOURCE_FORBIDDEN" });
  const token = crypto.randomBytes(32).toString("base64url");
  db.transaction(() => {
    removeInboundWebhook(pluginId, hookId, userId);
    let workflowId: string | null = null;
    if (hook.backgroundAction) {
      const repository = new WorkflowRepository();
      const { workflow } = repository.create(userId, { name: `${pluginId}/${hookId}`, definition: { version: 1, trigger: { type: "manual" }, steps: [{ id: "capture", type: "action", pluginId, actionId: hook.backgroundAction, input: "{{event.data.input}}", maxAttempts: 3 }] } });
      repository.setEnabled(workflow.id, true);
      workflowId = workflow.id;
    }
    db.prepare(`INSERT INTO plugin_inbound_webhooks(pluginId,hookId,ownerUserId,tokenHash,tokenVersion,workflowId,declarationJson) VALUES (?,?,?,?,?,?,?)`)
      .run(pluginId, hookId, userId, crypto.createHash("sha256").update(token).digest("hex"), user.tokenVersion || 0, workflowId, JSON.stringify(hook));
  })();
  return { path: `/api/plugin-inbound/${pluginId}/${hook.path}/${token}` };
}

export function enqueueInboundAction(row: InboundWebhookRow, input: unknown, key: string): string {
  const repository = new WorkflowRepository();
  const workflow = row.workflowId ? repository.get(row.workflowId) : undefined;
  if (!workflow?.enabled) throw new Error("Inbound 后台工作流不可用");
  return getDb().transaction(() => {
    const event = eventPublisher.publish({ id: crypto.createHash("sha256").update(`${row.tokenHash}:${key}`).digest("hex"), type: "webhook.triggered", userId: row.ownerUserId, source: "system", sourceId: "plugin-inbound", resourceType: "workflow", resourceId: workflow.id, data: { input } });
    return repository.createRun(workflow, event.id, event.metadata.correlationId).id;
  })();
}

export function assertInboundWorkflowOwner(workflowId: string): void {
  const row = getDb().prepare("SELECT * FROM plugin_inbound_webhooks WHERE workflowId=?").get(workflowId) as InboundWebhookRow | undefined;
  if (!row) return;
  const user = getDb().prepare("SELECT isDisabled,tokenVersion FROM users WHERE id=?").get(row.ownerUserId) as { isDisabled: number; tokenVersion: number } | undefined;
  const declaration = requireInboundDeclaration(row.pluginId, row.hookId);
  if (!user || user.isDisabled || user.tokenVersion !== row.tokenVersion || JSON.stringify(declaration) !== row.declarationJson) throw Object.assign(new Error("入站工作流授权已失效"), { code: "RESOURCE_FORBIDDEN" });
}
