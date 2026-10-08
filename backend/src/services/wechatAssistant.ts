import crypto from "node:crypto";
import { getDb } from "../db/schema.js";
import { compatibilityInputFromRecord } from "../plugins/extensionCompatibility.js";
import { getPluginService } from "../plugins/pluginService.js";
import { WorkflowRepository } from "../automation/workflowRepository.js";
import { eventPublisher } from "../automation/eventPublisher.js";
import { ApplicationCommandGateway } from "./applicationCommandGateway.js";
import { secureExternalFetch } from "../plugins/secureExternalFetch.js";

export const WECHAT_PLUGIN_ID = "nowenlab.wechat-capture";
const CONFIG_KEY = "wechat-assistant";
const digest = (value: string) => crypto.createHash("sha256").update(value).digest("hex");
function fail(message: string, status = 400): never { throw Object.assign(new Error(message), { status }); }
interface Config { ownerUserId: string; tokenVersion: number; appId: string; publicUrl: string; mode: string }
interface Profile { userId: string; tokenVersion: number; openId: string | null; notebookId: string | null; workflowId: string | null }
interface Item { id: string; userId: string; url: string; urlKey: string; runId: string; openId: string | null; createdAt: string; tokenVersion: number; status: string; errorMessage: string | null; outputPreview: string | null }

function activeUser(userId: string) {
  const user = getDb().prepare("SELECT tokenVersion,isDisabled,role FROM users WHERE id=?").get(userId) as { tokenVersion: number; isDisabled: number; role: string } | undefined;
  if (!user || user.isDisabled) fail("账号不可用", 403);
  return user;
}
function requirePlugin() {
  const plugin = getPluginService().registry.get(WECHAT_PLUGIN_ID);
  const actions = plugin ? JSON.parse(plugin.manifestJson).actions : [];
  if (plugin?.status !== "enabled" || !actions?.some((action: { id: string }) => action.id === "capture-article")) fail("请先安装并启用微信文章采集插件", 409);
  getPluginService().policy.assertAllowed(compatibilityInputFromRecord(plugin));
  getPluginService().permissions.require(WECHAT_PLUGIN_ID, "capture:write");
  if (!getPluginService().permissions.allDeclaredGranted(WECHAT_PLUGIN_ID)) fail("插件权限已撤销，请重新授权", 403);
}
export function assistantConfig(): Config | null {
  const row = getDb().prepare("SELECT value FROM system_settings WHERE key=?").get(CONFIG_KEY) as { value: string } | undefined;
  return row ? JSON.parse(row.value) : null;
}
export function requireAssistantConfig(): Config {
  requirePlugin();
  const config = assistantConfig();
  if (!config) fail("管理员尚未配置微信接入", 503);
  const user = activeUser(config.ownerUserId);
  if (user.role !== "admin" || user.tokenVersion !== config.tokenVersion) fail("微信接入授权已失效，请管理员重新配置", 503);
  const settings = getPluginService().getSettings(WECHAT_PLUGIN_ID, config.ownerUserId);
  if (settings["app-id"] !== config.appId || settings.mode !== config.mode) fail("公众号配置已变更，请管理员重新保存接入配置", 503);
  return config;
}
export function configureAssistant(userId: string, input: Record<string, unknown>) {
  const user = activeUser(userId);
  if (user.role !== "admin") fail("仅管理员可配置接入", 403);
  requirePlugin();
  if (typeof input.appId !== "string" || !/^wx[A-Za-z0-9_-]{3,80}$/.test(input.appId)) fail("AppID 无效");
  let publicUrl: URL;
  try { publicUrl = new URL(String(input.publicUrl)); } catch { return fail("请填写公网 HTTPS 地址"); }
  if (publicUrl.protocol !== "https:" || publicUrl.username || publicUrl.password || publicUrl.search || publicUrl.hash || publicUrl.pathname !== "/") fail("请填写公网 HTTPS 根地址");
  const mode = input.mode === "plain" ? "plain" : "encrypted";
  const service = getPluginService();
  const prior = assistantConfig();
  const sameAccount = prior?.appId === input.appId && prior.ownerUserId === userId;
  const configuredSecrets = new Set(service.secrets.list(WECHAT_PLUGIN_ID, userId).map((item) => item.name));
  for (const [field, name] of [["token", "callback-token"], ["appSecret", "app-secret"], ["encodingKey", "encoding-key"]]) {
    const value = input[field];
    if (value !== undefined && value !== "" && (typeof value !== "string" || value.length > 256)) fail("接入凭据无效");
    if ((field !== "encodingKey" || mode === "encrypted") && !value && (!sameAccount || !configuredSecrets.has(name))) fail(`请填写 ${field}`);
    if (field === "encodingKey" && value && !/^[A-Za-z0-9+/]{43}$/.test(String(value))) fail("EncodingAESKey 必须为 43 位");
  }
  getDb().transaction(() => {
    for (const [field, name] of [["token", "callback-token"], ["appSecret", "app-secret"], ["encodingKey", "encoding-key"]]) if (input[field]) service.secrets.set(WECHAT_PLUGIN_ID, userId, name, String(input[field]));
    service.setSettings(WECHAT_PLUGIN_ID, userId, { "app-id": input.appId, mode });
    if (!sameAccount) {
      getDb().prepare("UPDATE wechat_assistant_profiles SET openId=NULL").run();
      getDb().prepare("DELETE FROM wechat_assistant_sessions").run();
    }
    const config: Config = { ownerUserId: userId, tokenVersion: user.tokenVersion, appId: input.appId as string, publicUrl: publicUrl.origin, mode };
    getDb().prepare("INSERT INTO system_settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updatedAt=datetime('now')").run(CONFIG_KEY, JSON.stringify(config));
  })();
  accessToken = null;
  return adminConfiguration(userId);
}
export function adminConfiguration(userId: string) {
  if (activeUser(userId).role !== "admin") fail("仅管理员可查看接入配置", 403);
  const config = assistantConfig();
  return { appId: config?.appId || "", publicUrl: config?.publicUrl || "", mode: config?.mode || "encrypted", callbackUrl: config ? `${config.publicUrl}/api/wechat-assistant/callback` : "", configured: Boolean(config) };
}

// Fixed public host, pinned DNS, bounded response and no redirects. Credentials never leave this backend.
export type WechatTransport = (url: string, body?: unknown) => Promise<Record<string, any>>;
const transport: WechatTransport = async (url, body) => {
  try {
    const response = await secureExternalFetch({ url, method: body ? "POST" : "GET", ...(body ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}) }, { allowedHosts: ["api.weixin.qq.com"], timeoutMs: 5000, maxRedirects: 0, maxResponseBytes: 65536 });
    if (!response.ok) fail("微信接入请求失败", 502);
    const result = JSON.parse(response.body);
    if (result.errcode) fail(`微信接入返回错误码 ${Number(result.errcode) || "unknown"}，请管理员检查接口权限、凭据和服务器 IP 白名单`, 502);
    return result;
  } catch (error) {
    if ((error as { status?: number }).status) throw error;
    fail("无法连接微信接入服务", 502);
  }
};
let accessToken: { key: string; value: string; expires: number } | null = null;
const pendingTokens = new Map<string, Promise<string>>();
async function getAccessToken(config: Config, request: WechatTransport) {
  const key = `${config.ownerUserId}:${config.appId}`;
  if (accessToken?.key === key && accessToken.expires > Date.now()) return accessToken.value;
  const pending = pendingTokens.get(key);
  if (pending) return pending;
  const operation = (async () => {
    const secret = getPluginService().secrets.get(WECHAT_PLUGIN_ID, config.ownerUserId, "app-secret");
    if (!secret) fail("管理员尚未配置 AppSecret", 503);
    const result = await request(`https://api.weixin.qq.com/cgi-bin/token?${new URLSearchParams({ grant_type: "client_credential", appid: config.appId, secret })}`);
    if (typeof result.access_token !== "string" || !Number.isFinite(result.expires_in) || result.expires_in <= 120) fail("微信接入凭据响应无效", 502);
    accessToken = { key, value: result.access_token, expires: Date.now() + Math.min(result.expires_in - 120, 7200) * 1000 };
    return result.access_token as string;
  })();
  pendingTokens.set(key, operation);
  try { return await operation; } finally { pendingTokens.delete(key); }
}
export async function createConnection(userId: string, request: WechatTransport = transport) {
  const config = requireAssistantConfig();
  const user = activeUser(userId);
  const scene = crypto.randomBytes(16).toString("hex");
  const token = await getAccessToken(config, request);
  const result = await request(`https://api.weixin.qq.com/cgi-bin/qrcode/create?access_token=${encodeURIComponent(token)}`, { expire_seconds: 600, action_name: "QR_STR_SCENE", action_info: { scene: { scene_str: scene } } });
  if (typeof result.ticket !== "string" || !result.ticket || result.ticket.length > 2048) fail("微信二维码响应无效", 502);
  if (!Number.isFinite(result.expire_seconds) || result.expire_seconds <= 0) fail("微信二维码有效期无效", 502);
  const expiresAt = Date.now() + Math.min(result.expire_seconds, 600) * 1000;
  const db = getDb();
  db.transaction(() => {
    db.prepare("DELETE FROM wechat_assistant_sessions WHERE userId=? OR expiresAt<?").run(userId, Date.now());
    db.prepare("INSERT INTO wechat_assistant_sessions(sceneHash,userId,tokenVersion,expiresAt) VALUES (?,?,?,?)").run(digest(scene), userId, user.tokenVersion, expiresAt);
  })();
  return { qrUrl: `https://mp.weixin.qq.com/cgi-bin/showqrcode?ticket=${encodeURIComponent(result.ticket)}`, expiresAt };
}
export function bindConnection(scene: string, openId: string): boolean {
  if (!/^[a-f0-9]{32}$/.test(scene) || !/^[A-Za-z0-9_-]{1,128}$/.test(openId)) return false;
  const db = getDb();
  return db.transaction(() => {
    const session = db.prepare("SELECT * FROM wechat_assistant_sessions WHERE sceneHash=? AND consumed=0 AND expiresAt>?").get(digest(scene), Date.now()) as { userId: string; tokenVersion: number } | undefined;
    if (!session) return false;
    const user = activeUser(session.userId);
    if (user.tokenVersion !== session.tokenVersion) return false;
    const prior = db.prepare("SELECT userId FROM wechat_assistant_profiles WHERE openId=?").get(openId) as { userId: string } | undefined;
    if (prior && prior.userId !== session.userId) return false;
    db.prepare("INSERT INTO wechat_assistant_profiles(userId,tokenVersion,openId) VALUES (?,?,?) ON CONFLICT(userId) DO UPDATE SET tokenVersion=excluded.tokenVersion,openId=excluded.openId").run(session.userId, user.tokenVersion, openId);
    db.prepare("UPDATE wechat_assistant_sessions SET consumed=1 WHERE sceneHash=?").run(digest(scene));
    return true;
  })();
}
export function disconnectAssistant(userId: string) {
  getDb().transaction(() => {
    getDb().prepare("UPDATE wechat_assistant_profiles SET openId=NULL WHERE userId=?").run(userId);
    getDb().prepare("DELETE FROM wechat_assistant_sessions WHERE userId=?").run(userId);
    getDb().prepare("UPDATE automation_workflow_runs SET status='cancelled' WHERE status='queued' AND id IN (SELECT runId FROM wechat_assistant_items WHERE userId=? AND openId IS NOT NULL)").run(userId);
  })();
}

const creatingProfiles = new Map<string, Promise<Profile>>();
async function prepareProfile(userId: string): Promise<Profile> {
  const pending = creatingProfiles.get(userId);
  if (pending) return pending;
  const operation = (async () => {
    requirePlugin();
    const user = activeUser(userId);
    const db = getDb();
    const profile = db.prepare("SELECT * FROM wechat_assistant_profiles WHERE userId=?").get(userId) as Profile | undefined;
    const existing = profile?.notebookId ? db.prepare("SELECT id FROM notebooks WHERE id=? AND userId=? AND workspaceId IS NULL AND isDeleted=0").get(profile.notebookId, userId) as { id: string } | undefined : undefined;
    const notebook = existing || await new ApplicationCommandGateway().createNotebook(userId, { name: "微信收件箱", workspaceId: null });
    if (activeUser(userId).tokenVersion !== user.tokenVersion) fail("账号授权已变更", 403);
    db.transaction(() => {
      let workflowId = profile?.workflowId;
      const repository = new WorkflowRepository();
      if (!workflowId || !repository.get(workflowId)) {
        workflowId = repository.create(userId, { name: "微信收件箱", definition: { version: 1, trigger: { type: "manual" }, steps: [{ id: "capture", type: "action", pluginId: WECHAT_PLUGIN_ID, actionId: "capture-article", input: "{{event.data.input}}", maxAttempts: 1 }] } }).workflow.id;
      }
      repository.setEnabled(workflowId, true);
      db.prepare("INSERT INTO wechat_assistant_profiles(userId,tokenVersion,notebookId,workflowId) VALUES (?,?,?,?) ON CONFLICT(userId) DO UPDATE SET tokenVersion=excluded.tokenVersion,notebookId=excluded.notebookId,workflowId=excluded.workflowId,openId=CASE WHEN wechat_assistant_profiles.tokenVersion=excluded.tokenVersion THEN openId ELSE NULL END").run(userId, user.tokenVersion, notebook.id, workflowId);
    })();
    return db.prepare("SELECT * FROM wechat_assistant_profiles WHERE userId=?").get(userId) as Profile;
  })();
  creatingProfiles.set(userId, operation);
  try { return await operation; } finally { creatingProfiles.delete(userId); }
}
export function articleLinks(text: string): string[] {
  if (text.length > 16384) fail("一次最多发送 16KB 文本");
  const urls = [...text.matchAll(/https:\/\/[^\s<>"'，。；！？）】]+/gi)].map((match) => match[0].replace(/[),.;!?]+$/, ""));
  if (urls.length > 20) fail("一次最多发送 20 个文章链接");
  const unique = new Map<string, string>();
  for (const url of urls) unique.set(articleKey(url), url);
  return [...unique.values()];
}
export function articleKey(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password) fail("请发送 HTTPS 文章链接");
  url.hash = "";
  if (url.hostname === "mp.weixin.qq.com" && ["__biz", "mid", "idx"].every((key) => url.searchParams.has(key))) {
    return digest(JSON.stringify([url.hostname, ...["__biz", "mid", "idx"].map((key) => url.searchParams.get(key))]));
  }
  url.searchParams.sort();
  return digest(url.href);
}
function items(userId: string, urlKey?: string): Item[] {
  return getDb().prepare(`SELECT i.*,r.status,r.errorMessage,s.outputPreview FROM wechat_assistant_items i
    LEFT JOIN automation_workflow_runs r ON r.id=i.runId
    LEFT JOIN automation_workflow_steps s ON s.runId=i.runId AND s.stepId='capture'
    WHERE i.userId=? ${urlKey ? "AND i.urlKey=?" : ""} ORDER BY i.createdAt DESC,i.rowid DESC LIMIT 100`).all(...(urlKey ? [userId, urlKey] : [userId])) as Item[];
}
function noteResult(item: Item) {
  try {
    const result = JSON.parse(item.outputPreview || "null");
    const output = result?.success === true ? result.data : result;
    if (!output?.id) return null;
    const note = getDb().prepare("SELECT id,title FROM notes WHERE id=? AND userId=? AND workspaceId IS NULL AND isTrashed=0").get(output.id, item.userId) as { id: string; title: string } | undefined;
    return note || null;
  } catch { return null; }
}
function queue(profile: Profile, item: { id: string; url: string; openId: string | null }): string {
  const repository = new WorkflowRepository();
  const workflow = repository.get(profile.workflowId!);
  if (!workflow?.enabled) fail("采集队列不可用", 409);
  const event = eventPublisher.publish({ type: "webhook.triggered", userId: profile.userId, source: "system", sourceId: "wechat-assistant", resourceType: "workflow", resourceId: workflow.id, data: { input: { url: item.url, itemId: item.id, notebookId: profile.notebookId } } });
  // This is a private input for this manual workflow, not a broadcast trigger.
  getDb().prepare("UPDATE automation_events SET dispatchState='dispatched',dispatchedAt=? WHERE id=?").run(new Date().toISOString(), event.id);
  return repository.createRun(workflow, event.id, event.metadata.correlationId).id;
}
export async function collectArticles(userId: string, text: string, openId: string | null = null, deliveryId?: string) {
  const urls = articleLinks(text);
  if (!urls.length) fail("请发送文章链接；公众号名称采集尚未接入文章目录服务");
  const profile = await prepareProfile(userId);
  if (openId && profile.openId !== openId) fail("微信连接已变更", 403);
  const db = getDb();
  return db.transaction(() => {
    const result: Array<{ id: string; duplicate: boolean }> = [];
    for (const url of urls) {
      const key = articleKey(url);
      const deliveryKey = deliveryId ? digest(`${userId}:${openId}:${deliveryId}:${key}`) : null;
      if (deliveryKey && db.prepare("SELECT id FROM wechat_assistant_items WHERE id=? AND userId=?").get(deliveryKey, userId)) { result.push({ id: deliveryKey, duplicate: true }); continue; }
      const prior = items(userId, key).find((item) => ["queued", "running", "waiting"].includes(item.status) || (item.status === "completed" && noteResult(item)));
      if (prior) { result.push({ id: prior.id, duplicate: true }); continue; }
      const id = deliveryKey || crypto.randomUUID();
      const runId = queue(profile, { id, url, openId });
      db.prepare("INSERT INTO wechat_assistant_items(id,userId,url,urlKey,runId,openId,tokenVersion,createdAt) VALUES (?,?,?,?,?,?,?,?)").run(id, userId, url, key, runId, openId, profile.tokenVersion, new Date().toISOString());
      result.push({ id, duplicate: false });
    }
    return { accepted: result.filter((item) => !item.duplicate).length, duplicates: result.filter((item) => item.duplicate).length, items: result };
  })();
}
export function assertAssistantWorkflowOwner(workflowId: string, runId: string) {
  const profile = getDb().prepare("SELECT * FROM wechat_assistant_profiles WHERE workflowId=?").get(workflowId) as Profile | undefined;
  if (!profile) return;
  const user = activeUser(profile.userId);
  const item = getDb().prepare("SELECT openId,tokenVersion FROM wechat_assistant_items WHERE runId=? AND userId=?").get(runId, profile.userId) as { openId: string | null; tokenVersion: number } | undefined;
  if (!item || user.tokenVersion !== item.tokenVersion || user.tokenVersion !== profile.tokenVersion || (item.openId && item.openId !== profile.openId)) fail("采集授权已失效", 403);
  if (item.openId) requireAssistantConfig();
}
export async function retryArticle(userId: string, id: string) {
  const item = items(userId).find((candidate) => candidate.id === id);
  if (!item) fail("采集记录不存在", 404);
  if (item.status !== "failed") fail("只能重试失败记录", 409);
  const profile = await prepareProfile(userId);
  if (item.openId && item.openId !== profile.openId) fail("请重新连接微信后重试", 409);
  getDb().transaction(() => {
    const current = new WorkflowRepository().getRun(item.runId);
    if (current?.status !== "failed") fail("采集记录已在重试", 409);
    getDb().prepare("UPDATE wechat_assistant_items SET runId=?,tokenVersion=? WHERE id=? AND userId=?").run(queue(profile, item), profile.tokenVersion, id, userId);
  })();
}
export function assistantStatus(userId: string) {
  const user = activeUser(userId);
  const profile = getDb().prepare("SELECT * FROM wechat_assistant_profiles WHERE userId=?").get(userId) as Profile | undefined;
  let ready = false; let pluginReady = false;
  try { requirePlugin(); pluginReady = true; requireAssistantConfig(); ready = true; } catch { /* Configuration is optional for local collection. */ }
  return { ready, pluginReady, connected: ready && Boolean(profile?.openId && profile.tokenVersion === user.tokenVersion), notebookId: profile?.notebookId || null,
    items: items(userId).map((item) => ({ id: item.id, url: item.url, status: item.status || "cancelled", note: item.status === "completed" ? noteResult(item) : null, createdAt: item.createdAt, error: item.errorMessage })) };
}
