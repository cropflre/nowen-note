import crypto from "node:crypto";
import { getDb } from "../db/schema.js";
import { getPluginService } from "../plugins/pluginService.js";
import { compatibilityInputFromRecord } from "../plugins/extensionCompatibility.js";
import { secureExternalFetch, type ExternalFetchRequest } from "../plugins/secureExternalFetch.js";
import { articleKey, collectArticles, WECHAT_PLUGIN_ID } from "./wechatAssistant.js";
import { extractWeixinAuthor, extractWeixinContent, isWeixinVerificationPage, stripTags } from "./wechat-article-extractor.js";

// Experimental reader-session path. A successful live page is required before collection.
const lifetime = 10 * 60 * 1000;
interface Article { url: string; title: string; publishedAt: number }
interface Target {
  userId: string; tokenVersion: number; biz: string; name: string; expiresAt: number;
  credentials?: Record<string, string>; articles: Map<string, Article>;
  nextOffset: number; hasMore: boolean; verified: boolean; loading: boolean; requestedAt: number;
}
const targets = new Map<string, Target>();
function discard(id: string) { const value = targets.get(id); if (value) value.credentials = undefined; targets.delete(id); }
function fail(message: string, code: string, status = 400): never { throw Object.assign(new Error(message), { code, status }); }
function access(userId: string): number {
  const user = getDb().prepare("SELECT tokenVersion,isDisabled FROM users WHERE id=?").get(userId) as { tokenVersion: number; isDisabled: number } | undefined;
  if (!user || user.isDisabled) fail("账号不可用", "ACCOUNT_DISABLED", 403);
  const service = getPluginService(), plugin = service.registry.get(WECHAT_PLUGIN_ID);
  if (plugin?.status !== "enabled") fail("请先启用微信采集插件", "PLUGIN_DISABLED", 409);
  service.policy.assertAllowed(compatibilityInputFromRecord(plugin));
  service.permissions.require(WECHAT_PLUGIN_ID, "capture:write");
  return user.tokenVersion;
}
function target(userId: string, id: string): Target {
  const version = access(userId), value = targets.get(id);
  if (!value || value.userId !== userId) fail("公众号会话不存在，请重新识别", "TARGET_NOT_FOUND", 404);
  if (value.expiresAt < Date.now() || value.tokenVersion !== version) { discard(id); fail("阅读会话已过期，请重新识别公众号", "READ_SESSION_EXPIRED", 401); }
  return value;
}
export function wechatArticleUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value.replace(/&amp;/g, "&")); } catch { return fail("请填写公众号文章链接", "INVALID_ARTICLE_URL"); }
  if (url.protocol !== "https:" || url.hostname !== "mp.weixin.qq.com" || url.port || url.username || url.password || !/^\/s(?:\/[A-Za-z0-9_-]+)?$/.test(url.pathname)) fail("请填写 mp.weixin.qq.com 的 HTTPS 文章链接", "INVALID_ARTICLE_URL");
  if (url.pathname === "/s" && !["__biz", "mid", "idx"].every((key) => url.searchParams.get(key))) fail("文章链接不完整", "INVALID_ARTICLE_URL");
  const cleaned = new URL(url.origin + url.pathname);
  for (const key of ["__biz", "mid", "idx", "sn", "chksm"]) if (url.searchParams.has(key)) cleaned.searchParams.set(key, url.searchParams.get(key)!);
  return cleaned;
}
export function accountMetadata(html: string, articleUrl: string): { biz: string; name: string } {
  if (isWeixinVerificationPage(html, articleUrl)) fail("微信要求完成访问验证，当前请求未取得文章正文。请在本人微信内打开文章并完成验证", "WECHAT_VERIFICATION_REQUIRED", 409);
  const match = html.match(/\b(?:var\s+)?(?:biz|__biz)\s*=\s*["']([A-Za-z0-9+/=]+)["']/);
  const biz = match?.[1] || wechatArticleUrl(articleUrl).searchParams.get("__biz") || "";
  const name = extractWeixinAuthor(html) || stripTags(html.match(/<(?:span|strong)[^>]*id=["']js_name["'][^>]*>([\s\S]*?)<\/(?:span|strong)>/i)?.[1] || "");
  if (!/^[A-Za-z0-9+/=]{8,128}$/.test(biz) || !name || name.length > 100 || !extractWeixinContent(html).trim()) fail("微信未返回可识别的公众号文章，请在微信内确认链接可打开", "ACCOUNT_UNAVAILABLE", 502);
  return { biz, name };
}
export type HistoryTransport = (request: ExternalFetchRequest) => Promise<string>;
const transport: HistoryTransport = async (request) => {
  try {
    const publicArticle = /^\/s(?:\/|$)/.test(new URL(request.url).pathname);
    const response = await secureExternalFetch(request, { allowedHosts: ["mp.weixin.qq.com"], timeoutMs: 8000, maxRedirects: publicArticle ? 2 : 0, maxResponseBytes: 2 * 1024 * 1024 });
    if (!response.ok) fail("微信阅读接口请求失败", "HISTORY_UNAVAILABLE", 502);
    return response.body;
  } catch (error) {
    if ((error as { status?: number }).status) throw error;
    // Do not echo the authenticated URL, response or transport errors.
    fail("无法访问微信阅读接口，请检查网络及阅读会话", "HISTORY_UNAVAILABLE", 502);
  }
};
function view(id: string, value: Target) {
  return { id, name: value.name, homeUrl: `https://mp.weixin.qq.com/mp/profile_ext?${new URLSearchParams({ action: "home", __biz: value.biz, scene: "124" })}#wechat_redirect`, verified: value.verified, articles: [...value.articles.values()], hasMore: value.hasMore, expiresAt: value.expiresAt };
}
export async function identifyWechatAccount(userId: string, article: string, fetch = transport) {
  const tokenVersion = access(userId), url = wechatArticleUrl(article);
  const account = accountMetadata(await fetch({ url: url.href }), url.href);
  access(userId);
  for (const [id, value] of targets) if (value.expiresAt < Date.now()) discard(id);
  if (targets.size >= 128) fail("阅读验证会话过多，请稍后再试", "HISTORY_BUSY", 429);
  for (const [id, value] of targets) if (value.userId === userId) discard(id);
  const id = crypto.randomUUID(), value: Target = { userId, tokenVersion, ...account, expiresAt: Date.now() + lifetime, articles: new Map(), nextOffset: 0, hasMore: true, verified: false, loading: false, requestedAt: 0 };
  targets.set(id, value); setTimeout(() => discard(id), lifetime).unref(); return view(id, value);
}
export function readingCredentials(value: string, biz: string, cookie = ""): Record<string, string> {
  let url: URL;
  try { url = new URL(value); } catch { return fail("请输入微信内打开的公众号历史请求地址", "INVALID_READ_SESSION"); }
  if (url.protocol !== "https:" || url.hostname !== "mp.weixin.qq.com" || url.port || url.username || url.password || url.pathname !== "/mp/profile_ext" || !["home", "getmsg"].includes(url.searchParams.get("action") || "") || url.searchParams.get("__biz") !== biz) fail("阅读会话必须属于当前目标公众号", "INVALID_READ_SESSION");
  const result: Record<string, string> = {};
  for (const key of ["uin", "key", "pass_ticket", "poc_sid", "poc_token", "appmsg_token", "wxtoken", "wap_sid2"]) {
    const item = url.searchParams.get(key);
    if (item) { if (item.length > 2048 || /[\r\n\0]/.test(item)) fail("阅读会话字段无效", "INVALID_READ_SESSION"); result[key] = item; }
  }
  if (!(result.uin && result.key) && !(result.pass_ticket && result.appmsg_token)) fail("该地址缺少微信阅读会话，普通分享链接无法获取历史列表", "READ_SESSION_REQUIRED", 401);
  if (cookie.length > 8192 || /[\r\n\0]/.test(cookie)) fail("阅读会话 Cookie 无效", "INVALID_READ_SESSION");
  if (cookie) result.cookie = cookie;
  return result;
}
export function parseHistoryPage(body: string, biz: string, offset: number) {
  let response: any, messages: any;
  try { response = JSON.parse(body); } catch { return fail("微信未返回历史列表，可能需要在微信内完成验证", "HISTORY_UNAVAILABLE", 502); }
  const ret = response.ret ?? response.base_resp?.ret;
  if (ret === 200013) fail("微信已限制访问频率，请稍后重新验证", "HISTORY_RATE_LIMITED", 429);
  if (ret !== 0) fail(`微信历史列表不可用（返回码 ${Number.isSafeInteger(ret) ? ret : "unknown"}），请更新本人阅读会话`, "READ_SESSION_REJECTED", 401);
  try { messages = typeof response.general_msg_list === "string" ? JSON.parse(response.general_msg_list) : response.general_msg_list; } catch { return fail("微信历史列表格式已变化", "HISTORY_INVALID_RESPONSE", 502); }
  if (!Array.isArray(messages?.list) || messages.list.length > 100 || ![0, 1].includes(response.can_msg_continue)) fail("微信未返回有效分页列表", "HISTORY_INVALID_RESPONSE", 502);
  const hasMore = response.can_msg_continue === 1, nextOffset = response.next_offset;
  if (hasMore && (!Number.isSafeInteger(nextOffset) || nextOffset <= offset)) fail("微信历史列表分页未向前推进", "HISTORY_INVALID_RESPONSE", 502);
  const articles: Article[] = [];
  for (const message of messages.list) {
    const first = message.app_msg_ext_info;
    if (!first) continue;
    const extra = first.multi_app_msg_item_list || [];
    if (!Array.isArray(extra) || extra.length > 20) fail("微信文章列表格式无效", "HISTORY_INVALID_RESPONSE", 502);
    for (const item of [first, ...extra]) {
      if (item.del_flag || !item.content_url) continue;
      const url = wechatArticleUrl(item.content_url);
      if (url.searchParams.has("__biz") && url.searchParams.get("__biz") !== biz) fail("历史列表包含其他公众号文章", "HISTORY_INVALID_RESPONSE", 502);
      articles.push({ url: url.href, title: stripTags(String(item.title || "")).slice(0, 300), publishedAt: Number(message.comm_msg_info?.datetime) || 0 });
    }
  }
  return { articles, hasMore, nextOffset: hasMore ? nextOffset : offset };
}
async function readPage(userId: string, id: string, credentials: Record<string, string>, fetch: HistoryTransport) {
  const value = target(userId, id);
  if (value.loading || Date.now() - value.requestedAt < 1500) fail("请稍后再读取下一页", "HISTORY_BUSY", 429);
  if (value.articles.size >= 2000) fail("本次已读取 2000 篇，尚未证明全部历史读取完成", "HISTORY_LIMIT", 409);
  value.loading = true; value.requestedAt = Date.now();
  try {
    const { cookie, poc_sid, wap_sid2, ...params } = credentials;
    const query = new URLSearchParams({ action: "getmsg", __biz: value.biz, offset: String(value.nextOffset), count: "10", f: "json", is_ok: "1", scene: "124", x5: "0", ...params });
    const cookies = cookie || [poc_sid && `poc_sid=${encodeURIComponent(poc_sid)}`, wap_sid2 && `wap_sid2=${encodeURIComponent(wap_sid2)}`].filter(Boolean).join("; ");
    const page = parseHistoryPage(await fetch({ url: `https://mp.weixin.qq.com/mp/profile_ext?${query}`, headers: { referer: `https://mp.weixin.qq.com/mp/profile_ext?${new URLSearchParams({ action: "home", __biz: value.biz })}` }, ...(cookies ? { trustedHeaders: { Cookie: cookies } } : {}) }), value.biz, value.nextOffset);
    if (target(userId, id) !== value) fail("公众号会话已变更", "READ_SESSION_EXPIRED", 401);
    for (const article of page.articles) value.articles.set(articleKey(article.url), article);
    value.nextOffset = page.nextOffset; value.hasMore = page.hasMore; value.verified = true;
    // Credentials stay in process memory for at most ten minutes, never in queue inputs or logs.
    value.credentials = credentials;
    return view(id, value);
  } finally { value.loading = false; }
}
export async function verifyWechatHistory(userId: string, id: string, readingUrl: string, fetch = transport, cookie = "") {
  const value = target(userId, id);
  if (value.verified) fail("阅读会话已验证，请继续读取或重新识别", "READ_SESSION_ALREADY_VERIFIED", 409);
  return readPage(userId, id, readingCredentials(readingUrl, value.biz, cookie), fetch);
}
export async function nextWechatHistoryPage(userId: string, id: string, fetch = transport) {
  const value = target(userId, id);
  if (!value.verified || !value.credentials) fail("请先验证本人微信阅读会话", "READ_SESSION_REQUIRED", 401);
  if (!value.hasMore) return view(id, value);
  return readPage(userId, id, value.credentials, fetch);
}
export async function collectWechatHistory(userId: string, id: string, selected?: string[]) {
  const value = target(userId, id);
  if (!value.verified) fail("尚未取得真实文章列表，不能采集", "READ_SESSION_REQUIRED", 401);
  if (!selected && value.hasMore) fail("历史列表尚未读取完，请继续读取或选取已加载文章", "HISTORY_INCOMPLETE", 409);
  const selection = selected || [...value.articles.values()].map((item) => item.url);
  if (!selection.length || selection.length > 2000 || selection.some((url) => !value.articles.has(articleKey(url)))) fail("只能采集当前公众号已读取的文章", "INVALID_SELECTION");
  const urls = [...new Set(selection.map((url) => value.articles.get(articleKey(url))!.url))];
  // A bounded batch produces one durable queue result; no half-enqueued HTTP request.
  if (urls.length > 20) fail("每批最多采集 20 篇，请分批提交", "BATCH_LIMIT");
  const result = await collectArticles(userId, urls.join("\n"));
  return { accepted: result.accepted, duplicates: result.duplicates };
}
export function forgetWechatHistory(userId: string, id: string) {
  access(userId);
  const value = targets.get(id);
  if (value && value.userId !== userId) fail("公众号会话不存在", "TARGET_NOT_FOUND", 404);
  discard(id);
}
