import crypto from "node:crypto";
import { Hono } from "hono";
import { getDb } from "../db/schema.js";
import { getPluginService } from "../plugins/pluginService.js";
import { readBody } from "./plugin-inbound.js";
import { adminConfiguration, assistantStatus, bindConnection, collectArticles, configureAssistant, createConnection, disconnectAssistant, requireAssistantConfig, retryArticle, WECHAT_PLUGIN_ID } from "../services/wechatAssistant.js";

function errorResponse(c: any, error: unknown) {
  return c.json({ error: (error as Error).message || "采集操作失败" }, (error as { status?: number }).status || 400);
}
export function createWechatAssistantRouter() {
  const router = new Hono();
  router.get("/", (c) => { try { return c.json(assistantStatus(c.req.header("X-User-Id") || "")); } catch (error) { return errorResponse(c, error); } });
  router.get("/configuration", (c) => { try { return c.json(adminConfiguration(c.req.header("X-User-Id") || "")); } catch (error) { return errorResponse(c, error); } });
  router.put("/configuration", async (c) => { try { return c.json(configureAssistant(c.req.header("X-User-Id") || "", JSON.parse(await readBody(c.req.raw, 8192)))); } catch (error) { return errorResponse(c, error); } });
  router.post("/connection", async (c) => { try { return c.json(await createConnection(c.req.header("X-User-Id") || "")); } catch (error) { return errorResponse(c, error); } });
  router.delete("/connection", (c) => { try { disconnectAssistant(c.req.header("X-User-Id") || ""); return c.json({ success: true }); } catch (error) { return errorResponse(c, error); } });
  router.post("/collect", async (c) => {
    try {
      const input = JSON.parse(await readBody(c.req.raw, 20000));
      if (typeof input.text !== "string") return c.json({ error: "请填写文章链接" }, 400);
      return c.json(await collectArticles(c.req.header("X-User-Id") || "", input.text));
    } catch (error) { return errorResponse(c, error); }
  });
  router.post("/items/:id/retry", async (c) => { try { await retryArticle(c.req.header("X-User-Id") || "", c.req.param("id")); return c.json({ success: true }); } catch (error) { return errorResponse(c, error); } });
  return router;
}

export function createWechatAssistantCallbackRouter() {
  const router = new Hono();
  let requests = 0; let windowStart = 0;
  router.all("/callback", async (c) => {
    if (!["GET", "POST"].includes(c.req.method)) return c.text("Method not allowed", 405);
    if (Date.now() - windowStart > 60000) { requests = 0; windowStart = Date.now(); }
    if (++requests > 240) return c.text("Too many requests", 429);
    const service = getPluginService();
    let executionId = crypto.randomUUID();
    let timer: NodeJS.Timeout | undefined;
    try {
      const config = requireAssistantConfig();
      const query = c.req.query();
      if (Buffer.byteLength(JSON.stringify(query)) > 8192) return c.text("Request too large", 413);
      const execute = async (action: string, input: unknown) => {
        executionId = crypto.randomUUID();
        try {
          const result = await Promise.race([service.execute(WECHAT_PLUGIN_ID, action, config.ownerUserId, null, input, executionId, { source: "system", sourceId: "wechat-assistant" }), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error("Callback timeout"), { status: 504 })), 3500); })]);
          return result.result as any;
        } finally { if (timer) clearTimeout(timer); }
      };
      let result = await execute("verify-message", { method: c.req.method, query, body: await readBody(c.req.raw, 131072), headers: {} });
      if (result.message) {
        const { sender, event, scene, type, text, id, encrypted } = result.message;
        let reply = "请发送公众号文章链接，可一次发送多篇。采集结果和失败重试可在 Nowen 的微信收件箱查看。";
        if (type === "event" && ["SCAN", "subscribe"].includes(event) && scene) {
          reply = bindConnection(scene, sender) ? "连接成功！发送公众号文章链接即可自动保存到微信收件箱。" : "二维码已失效或此微信已连接其他账号，请回到 Nowen 重新连接。";
        } else if (type === "event" && event === "unsubscribe") {
          const profile = getDb().prepare("SELECT userId FROM wechat_assistant_profiles WHERE openId=?").get(sender) as { userId: string } | undefined;
          if (profile) disconnectAssistant(profile.userId);
          return c.text("success");
        } else if (text) {
          const profile = getDb().prepare("SELECT userId FROM wechat_assistant_profiles WHERE openId=?").get(sender) as { userId: string } | undefined;
          if (!profile) reply = "请先打开 Nowen 的微信收件箱，点击连接微信并扫码。";
          else if (!/^\d{1,30}$/.test(id)) return c.text("Missing MsgId", 400);
          else {
            try {
              const accepted = await collectArticles(profile.userId, text, sender, id);
              reply = `已接收 ${accepted.accepted} 篇文章，${accepted.duplicates} 篇已在收件箱。请在 Nowen 微信收件箱查看进度。`;
            } catch (error) { reply = (error as Error).message; }
          }
        } else return c.text("success");
        result = await execute("reply-message", { message: { sender, receiver: result.message.receiver }, text: reply, encrypted });
      }
      if (!result || !Number.isInteger(result.status) || result.status < 200 || result.status > 599 || (result.status >= 300 && result.status < 400) || !["text/plain", "text/xml"].includes(result.contentType) || typeof result.body !== "string" || Buffer.byteLength(result.body) > 65536) throw new Error("Invalid callback response");
      return new Response(result.body, { status: result.status, headers: { "Content-Type": `${result.contentType}; charset=utf-8`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox" } });
    } catch (error) {
      const status = (error as { status?: number }).status || 502;
      if (status === 504) await service.executions.cancel(executionId);
      return c.text("Wechat callback unavailable", status as 503);
    } finally { if (timer) clearTimeout(timer); }
  });
  return router;
}
export default createWechatAssistantRouter();
