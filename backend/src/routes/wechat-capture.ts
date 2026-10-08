import { Hono } from "hono";
import { getPluginService } from "../plugins/pluginService.js";
import { assistantStatus, articleLinks, collectArticles, retryArticle, WECHAT_PLUGIN_ID } from "../services/wechatAssistant.js";
import { wechatArticleUrl } from "../services/wechatAccountHistory.js";
import { readBody } from "./plugin-inbound.js";

export function createWechatCaptureRouter() {
  const app = new Hono();
  app.use("*", async (c, next) => {
    if (!c.req.header("X-User-Id")) return c.json({ error: "请先登录" }, 401);
    if (c.req.header("X-Auth-Mode") === "api-token") return c.json({ error: "微信采集需要登录会话" }, 403);
    await next();
  });
  app.onError((error, c) => c.json({ error: error.message }, (error as Error & { status?: number }).status as 400 || 400));
  app.get("/", (c) => {
    const userId = c.req.header("X-User-Id")!;
    const status = assistantStatus(userId);
    const service = getPluginService();
    const settings = service.registry.get(WECHAT_PLUGIN_ID) ? service.getSettings(WECHAT_PLUGIN_ID, userId) : {};
    return c.json({ pluginReady: status.pluginReady, clipboardAvailable: typeof settings["clipboard-prompt"] === "boolean", clipboardPrompt: settings["clipboard-prompt"] === true, items: status.items });
  });
  app.put("/preferences", async (c) => {
    const userId = c.req.header("X-User-Id")!;
    const body = JSON.parse(await readBody(c.req.raw, 1024));
    if (typeof body.clipboardPrompt !== "boolean") return c.json({ error: "剪贴板设置无效" }, 400);
    if (!assistantStatus(userId).pluginReady) return c.json({ error: "请先启用微信文章采集插件" }, 409);
    getPluginService().setSettings(WECHAT_PLUGIN_ID, userId, { "clipboard-prompt": body.clipboardPrompt });
    return c.json({ clipboardPrompt: body.clipboardPrompt });
  });
  app.post("/collect", async (c) => {
    const body = JSON.parse(await readBody(c.req.raw, 20000));
    if (typeof body.text !== "string") return c.json({ error: "请粘贴微信文章链接" }, 400);
    const urls = articleLinks(body.text).map((value) => wechatArticleUrl(value).href);
    if (!urls.length) return c.json({ error: "请粘贴指定公众号的文章链接；按名称获取全部历史文章暂不支持" }, 400);
    return c.json(await collectArticles(c.req.header("X-User-Id")!, urls.join("\n")));
  });
  app.post("/items/:id/retry", async (c) => {
    await retryArticle(c.req.header("X-User-Id")!, c.req.param("id"));
    return c.json({ success: true });
  });
  return app;
}
export default createWechatCaptureRouter();
