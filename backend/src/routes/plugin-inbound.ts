import crypto from "node:crypto";
import { Hono } from "hono";
import { getDb } from "../db/schema.js";
import { logAudit } from "../services/audit.js";
import { enqueueInboundAction, requireInboundDeclaration, type InboundWebhookRow } from "../plugins/inboundWebhooks.js";

const HEADER_NAMES = new Set(["content-type", "x-hub-signature", "x-hub-signature-256", "x-signature", "x-timestamp", "x-slack-signature", "x-slack-request-timestamp", "x-github-event", "x-github-delivery"]);
const CONTENT_TYPES = new Set(["text/plain", "text/xml", "application/xml", "application/json"]);

async function readBody(request: Request, maxBytes: number): Promise<string> {
  if (Number(request.headers.get("content-length") || 0) > maxBytes) throw Object.assign(new Error("请求体过大"), { status: 413 });
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let timer: NodeJS.Timeout;
  try {
    return await Promise.race([ (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > maxBytes) throw Object.assign(new Error("请求体过大"), { status: 413 });
        chunks.push(value);
      }
      return Buffer.concat(chunks).toString("utf8");
    })(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error("请求体读取超时"), { status: 408 })), 3000); }) ]);
  } finally {
    clearTimeout(timer!);
    void reader.cancel().catch(() => {});
  }
}

export function createPluginInboundRouter() {
  const router = new Hono();
  router.all("/:pluginId/:path/:token", async (c) => {
    const token = c.req.param("token");
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return c.text("Not found", 404);
    const db = getDb();
    const row = db.prepare("SELECT * FROM plugin_inbound_webhooks WHERE pluginId=? AND tokenHash=?").get(c.req.param("pluginId"), crypto.createHash("sha256").update(token).digest("hex")) as InboundWebhookRow | undefined;
    if (!row) return c.text("Not found", 404);
    let declaration;
    try { declaration = requireInboundDeclaration(row.pluginId, row.hookId); } catch { return c.text("Not found", 404); }
    const owner = db.prepare("SELECT tokenVersion,isDisabled FROM users WHERE id=?").get(row.ownerUserId) as { tokenVersion: number; isDisabled: number } | undefined;
    if (!owner || owner.isDisabled || owner.tokenVersion !== row.tokenVersion || declaration.path !== c.req.param("path") || JSON.stringify(declaration) !== row.declarationJson) return c.text("Not found", 404);
    if (!declaration.methods.includes(c.req.method as "GET" | "POST")) return c.text("Method not allowed", 405);
    const now = Date.now();
    const count = now - row.windowStartedAt < 60000 ? row.requestsInWindow : 0;
    if (count >= 60) return c.text("Too many requests", 429);
    db.prepare("UPDATE plugin_inbound_webhooks SET requestsInWindow=?,windowStartedAt=? WHERE tokenHash=?").run(count + 1, count ? row.windowStartedAt : now, row.tokenHash);
    const executionId = crypto.randomUUID();
    let timeout: NodeJS.Timeout | undefined;
    let service: Awaited<ReturnType<typeof import("../plugins/pluginService.js")["getPluginService"]>> | undefined;
    try {
      const input = { method: c.req.method, query: c.req.query(), headers: Object.fromEntries(Object.entries(c.req.header()).filter(([name]) => HEADER_NAMES.has(name.toLowerCase()))), body: await readBody(c.req.raw, declaration.maxBodyBytes) };
      if (Buffer.byteLength(JSON.stringify(input.query)) > 8192 || Buffer.byteLength(JSON.stringify(input.headers)) > 8192 || Buffer.byteLength(JSON.stringify(input)) > 262144) return c.text("Request too large", 413);
      service = (await import("../plugins/pluginService.js")).getPluginService();
      const execution = await Promise.race([service.execute(row.pluginId, declaration.action, row.ownerUserId, null, input, executionId, { source: "system", sourceId: "plugin-inbound" }), new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(Object.assign(new Error("Inbound Action timeout"), { status: 504 })), 3500); })]);
      const result = execution.result as { status?: number; contentType?: string; body?: string; enqueue?: { input: unknown; key: string } };
      if (!result || !Number.isInteger(result.status) || result.status! < 200 || result.status! > 599 || (result.status! >= 300 && result.status! < 400) || !CONTENT_TYPES.has(result.contentType || "") || typeof result.body !== "string" || Buffer.byteLength(result.body) > 65536) throw new Error("Invalid Inbound response");
      if ([204, 205].includes(result.status!) && result.body) throw new Error("Invalid empty Inbound response");
      if (result.enqueue) {
        if (result.status! >= 300 || !declaration.backgroundAction || typeof result.enqueue.key !== "string" || !result.enqueue.key || result.enqueue.key.length > 200 || Buffer.byteLength(JSON.stringify(result.enqueue.input)) > 131072) throw new Error("Invalid Inbound background action");
        enqueueInboundAction(row, result.enqueue.input, result.enqueue.key);
      }
      logAudit(row.ownerUserId, "plugin", "inbound_request", { pluginId: row.pluginId, hookId: row.hookId, executionId, status: result.status });
      return new Response([204, 205].includes(result.status!) ? null : result.body, { status: result.status, headers: { "Content-Type": `${result.contentType}; charset=utf-8`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox" } });
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status === 504) await service?.executions.cancel(executionId);
      logAudit(row.ownerUserId, "plugin", "inbound_failed", { pluginId: row.pluginId, hookId: row.hookId, executionId, status: status || 502 });
      return c.text("Inbound request failed", (status || 502) as 408);
    } finally { if (timeout) clearTimeout(timeout); }
  });
  return router;
}

export default createPluginInboundRouter();
