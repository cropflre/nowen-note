import crypto from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getDb } from "../db/schema.js";
import { logAudit } from "../services/audit.js";
import { eventPublisher } from "./eventPublisher.js";
import { decryptAutomationSecret } from "./secretCrypto.js";
import { WorkflowRepository } from "./workflowRepository.js";

const router = new Hono();
const repository = new WorkflowRepository();

function equalSignature(actual: string, expected: string): boolean {
  const left = Buffer.from(actual.replace(/^sha256=/, ""), "hex");
  const right = Buffer.from(expected, "hex");
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

router.post("/:token", bodyLimit({
  maxSize: 256 * 1024,
  onError: (c) => c.json({ error: "Webhook payload 不能超过 256KB", code: "WEBHOOK_PAYLOAD_TOO_LARGE" }, 413),
}), async (c) => {
  const tokenHash = crypto.createHash("sha256").update(c.req.param("token")).digest("hex");
  const hook = getDb().prepare("SELECT * FROM automation_webhooks WHERE tokenHash=? AND enabled=1").get(tokenHash) as Record<string, unknown> | undefined;
  if (!hook) return c.json({ error: "Webhook 不存在或未启用", code: "WEBHOOK_NOT_FOUND" }, 404);
  const workflow = repository.get(String(hook.workflowId));
  if (!workflow?.enabled) return c.json({ error: "工作流未启用", code: "AUTOMATION_DISABLED" }, 409);
  const now = Date.now();
  const windowStart = hook.windowStartedAt ? Date.parse(String(hook.windowStartedAt)) : 0;
  const requests = now - windowStart < 60_000 ? Number(hook.requestsInWindow || 0) : 0;
  if (requests >= 60) return c.json({ error: "Webhook 请求过于频繁", code: "RATE_LIMITED" }, 429);
  const raw = Buffer.from(await c.req.arrayBuffer());
  if (hook.secretEncrypted) {
    const timestamp = c.req.header("X-Nowen-Timestamp") || "";
    const timestampMs = Number(timestamp) * 1000;
    if (!timestamp || !Number.isFinite(timestampMs) || Math.abs(now - timestampMs) > 5 * 60_000) return c.json({ error: "Webhook 时间戳无效或已过期", code: "WEBHOOK_REPLAY_REJECTED" }, 401);
    const provided = c.req.header("X-Nowen-Signature") || "";
    const secret = decryptAutomationSecret(String(hook.secretEncrypted), String(hook.secretIv), String(hook.secretTag));
    const expected = crypto.createHmac("sha256", secret).update(`${timestamp}.`).update(raw).digest("hex");
    if (!equalSignature(provided, expected)) return c.json({ error: "Webhook 签名无效", code: "WEBHOOK_SIGNATURE_INVALID" }, 401);
    const replayKey = crypto.createHash("sha256").update(`${hook.workflowId}:${timestamp}:${provided}`).digest("hex");
    try {
      getDb().prepare("INSERT INTO automation_idempotency(idempotencyKey,operation,resultJson,createdAt) VALUES (?,'webhook-signature','{}',?)").run(replayKey, new Date().toISOString());
    } catch { return c.json({ error: "Webhook 请求已处理", code: "WEBHOOK_REPLAY_REJECTED" }, 409); }
  }
  let payload: Record<string, unknown> = {};
  if (raw.length) {
    try { payload = JSON.parse(raw.toString("utf8")) as Record<string, unknown>; }
    catch { return c.json({ error: "Webhook 必须是 JSON", code: "INVALID_ARGUMENT" }, 400); }
  }
  const event = eventPublisher.publish({
    type: "webhook.triggered", userId: workflow.userId, workspaceId: workflow.workspaceId, resourceType: "workflow", resourceId: workflow.id,
    source: "system", sourceId: "webhook", data: { payload },
  });
  const run = repository.createRun(workflow, event.id, event.metadata.correlationId);
  getDb().prepare(`UPDATE automation_webhooks SET requestsInWindow=?,windowStartedAt=?,lastTriggeredAt=? WHERE workflowId=?`)
    .run(requests + 1, requests === 0 ? new Date().toISOString() : hook.windowStartedAt, new Date().toISOString(), workflow.id);
  logAudit(workflow.userId, "system", "webhook_trigger", { workflowId: workflow.id, runId: run.id, ip: c.req.header("x-forwarded-for") || "" }, { targetType: "automation_run", targetId: run.id });
  return c.json({ success: true, runId: run.id }, 202);
});

export default router;
