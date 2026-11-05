import { createContentScriptBridge } from "../lib/content-script-bridge";
import { buildNoteUrl, NowenApiError, ping, requestAIArchive } from "../lib/api";
import { getConfig } from "../lib/storage";
import { acknowledgeArchive, AI_STORAGE_KEY, archiveScope, emptyAIState, enqueueArchive, failPending, grantKey, RETRY_WINDOW_MS, type AIArchiveState, type PendingArchive } from "./queue";
import type { ArchiveReceipt, ArchiveSource, CaptureGrant, CapturePreview } from "./types";
import { normalizePreview } from "./normalize";

const bridge = createContentScriptBridge();
const knownTabs = new Set<number>();
const previews = new Map<string, { preview: CapturePreview; scope: string; tabId: number; expiresAt: number }>();
let state: AIArchiveState | undefined;
let writes = Promise.resolve();
let flushing: Promise<void> | undefined;
function change<T>(mutate: (data: AIArchiveState) => T): Promise<T> {
  const run = writes.then(async () => {
    if (!state) state = (await chrome.storage.local.get(AI_STORAGE_KEY))[AI_STORAGE_KEY] || emptyAIState();
    const next = structuredClone(state!);
    const result = mutate(next);
    await chrome.storage.local.set({ [AI_STORAGE_KEY]: next });
    state = next;
    return result;
  });
  writes = run.then(() => undefined, () => undefined);
  return run;
}
function identify(raw: string | undefined) {
  try {
    const url = new URL(raw || "");
    if (url.protocol !== "https:") return null;
    const chatgpt = ["chatgpt.com", "chat.openai.com"].includes(url.hostname) && url.pathname.match(/^\/c\/([\w-]+)\/?$/);
    const doubao = url.hostname === "www.doubao.com" && url.pathname.match(/^\/chat\/([\w-]+)\/?$/);
    const match = chatgpt || doubao;
    return match ? { provider: chatgpt ? "chatgpt" : "doubao", id: match[1], url: `${url.origin}${url.pathname}` } : null;
  } catch { return null; }
}
async function context(tabId: number) {
  const config = await getConfig();
  if (!config.serverUrl || !config.token) throw new Error("AI_PLATFORM_UNSUPPORTED：AI 归档需要登录 Nowen 服务端；桌面配对专用通道尚不支持对话归档。");
  const scope = archiveScope(config);
  const tab = await chrome.tabs.get(tabId);
  const identity = identify(tab.url);
  if (!identity) throw new Error("AI_PLATFORM_UNSUPPORTED：当前地址尚不支持 AI 会话归档，请使用普通剪藏。");
  return { config, scope, identity, key: grantKey(scope, identity.provider, identity.id) };
}
function notify() {
  for (const tabId of knownTabs) void chrome.tabs.sendMessage(tabId, { type: "AI_GRANT_CHANGED" }, { frameId: 0 }).catch(() => knownTabs.delete(tabId));
}
function describe(error: unknown) { return (error instanceof Error ? error.message : "保存失败，请稍后重试").slice(0, 400); }

async function flush(): Promise<void> {
  if (flushing) return flushing;
  flushing = (async () => {
    for (let batch = 0; batch < 10; batch += 1) {
      const config = await getConfig();
      let scope: string;
      try { scope = archiveScope(config); } catch { return; }
      if (!config.token) return;
      const selected = await change((data) => {
        const item = data.queue.find((entry, index, all) => entry.scope === scope && !entry.blocked
          && entry.nextAttemptAt <= Date.now() && !all.slice(0, index).some((prior) => prior.grantKey === entry.grantKey));
        if (!item) return;
        const grant = data.grants[item.grantKey];
        if (!grant || grant.source.permissionState !== "granted") { item.blocked = "AI_SOURCE_NOT_AUTHORIZED：来源授权已撤销，未继续发送。"; return; }
        if (Date.now() - item.queuedAt >= RETRY_WINDOW_MS) { item.blocked = "暂存超过 7 天，已停止自动重试；内容仍保留，请手动处理。"; return; }
        return structuredClone({ item, grant });
      });
      if (!selected) return;
      let { item, grant } = selected;
      try {
        // Never trust an editable config userId to establish the identity of a stored token.
        const identity = await ping(config);
        if (identity.id !== config.userId) throw new NowenApiError(403, "AI_CONTEXT_SCOPE_DENIED", "当前登录凭据与所选 Nowen 账号不一致，已停止发送暂存内容，请重新登录。");
        if (archiveScope(await getConfig()) !== scope) return;
        if (!grant.source.id) {
          const source = await requestAIArchive<ArchiveSource>(config, "/sources", {
            provider: grant.source.provider, accountScope: grant.source.accountScope, displayName: grant.source.displayName,
            notebookId: grant.source.notebookId, permissionState: "granted", captureEnabled: grant.automatic,
          });
          if (!source.id || source.accountScope !== grant.source.accountScope || source.provider !== grant.source.provider || source.notebookId !== grant.source.notebookId) throw new Error("AI_SYNC_RECEIPT_INVALID：来源绑定响应无效。");
          const attached = await change((data) => {
            let attached = false;
            for (const other of Object.values(data.grants)) {
              if (other.scope === scope && other.source.accountScope === source.accountScope && other.source.permissionState === "granted") { other.source = source; other.authorizationCheckedAt = Date.now(); attached = true; }
            }
            return attached;
          });
          if (!attached) { await requestAIArchive(config, `/sources/${encodeURIComponent(source.id)}`, { permissionState: "revoked", captureEnabled: false }, "PATCH"); continue; }
        }
        const active = await change((data) => {
          const current = data.queue.find((entry) => entry.id === item.id);
          const currentGrant = data.grants[item.grantKey];
          if (!current || current.blocked || !currentGrant || currentGrant.source.permissionState !== "granted") return;
          if (current.payload.mode === "automatic" && !currentGrant.automatic) { current.blocked = "AI_CAPTURE_PAUSED：已暂停自动保存，待发送内容保留。"; return; }
          if (!current.started) {
            current.payload.sourceId = currentGrant.source.id;
            if (current.payload.expectedRevision === -1) current.payload.expectedRevision = currentGrant.revision;
            current.started = true;
          }
          return structuredClone(current);
        });
        if (!active) continue;
        item = active;
        if (archiveScope(await getConfig()) !== scope) return;
        const receipt = await requestAIArchive<ArchiveReceipt>(config, "/conversations/ingest", item.payload);
        await change((data) => acknowledgeArchive(data, item, receipt));
      } catch (error) {
        await change((data) => {
          const current = data.queue.find((entry) => entry.id === item.id);
          const currentGrant = data.grants[item.grantKey];
          if (!current) return;
          failPending(current, error instanceof NowenApiError ? error.status : undefined, describe(error));
          if (currentGrant) {
            currentGrant.error = describe(error);
            if (current.blocked) {
              for (const other of Object.values(data.grants)) if (other.scope === item.scope && other.source.accountScope === currentGrant.source.accountScope) {
                other.automatic = false;
                other.error = describe(error);
              }
            }
          }
        });
        notify();
        return;
      }
    }
  })().finally(() => { flushing = undefined; });
  return flushing;
}

async function permission(tabId: number, rawUrl: string) {
  try {
    const ctx = await context(tabId);
    if (identify(rawUrl)?.url !== ctx.identity.url) return { allowed: false };
    knownTabs.add(tabId);
    const local = await change((data) => structuredClone(data.grants[ctx.key]));
    if (!local?.automatic || local.source.permissionState !== "granted") return { allowed: false, accountMarker: local?.accountMarker || null };
    let denied = false;
    if (local.source.id) {
      try {
        const remote = await requestAIArchive<ArchiveSource>(ctx.config, `/sources/${encodeURIComponent(local.source.id)}`);
        denied = remote.permissionState !== "granted" || !remote.captureEnabled || remote.accountScope !== local.source.accountScope
          || remote.provider !== local.provider || remote.notebookId !== local.source.notebookId;
        if (!denied) await change((data) => {
          const current = data.grants[ctx.key];
          if (current?.source.accountScope === local.source.accountScope) current.authorizationCheckedAt = Date.now();
        });
      } catch (error) {
        // Remote revocation cannot be learned while offline. Previously explicit consent has a
        // bounded offline retry window; HTTP authorization failures never use that fallback.
        denied = (error instanceof NowenApiError && error.status >= 400 && error.status < 500)
          || Date.now() - (local.authorizationCheckedAt || 0) >= RETRY_WINDOW_MS;
      }
    } else denied = Date.now() - (local.authorizationCheckedAt || 0) >= RETRY_WINDOW_MS;
    if (denied) {
      await change((data) => {
        for (const current of Object.values(data.grants)) if (current.scope === ctx.scope && current.source.accountScope === local.source.accountScope) {
          current.automatic = false;
          current.error = "AI_SOURCE_NOT_AUTHORIZED：服务端来源已暂停、撤销或无法确认授权，已停止自动采集。";
        }
      });
      notify();
      return { allowed: false };
    }
    if (archiveScope(await getConfig()) !== ctx.scope || identify((await chrome.tabs.get(tabId)).url)?.url !== ctx.identity.url) return { allowed: false };
    return change((data) => {
      const grant = data.grants[ctx.key];
      return { allowed: !!grant?.automatic && grant.source.permissionState === "granted", accountMarker: grant?.accountMarker || null };
    });
  } catch { return { allowed: false }; }
}
async function preview(tabId: number) {
  const ctx = await context(tabId);
  const result = await bridge.request(tabId, { type: "AI_PREVIEW_CONTENT" }) as { ok: boolean; preview?: CapturePreview; error?: string };
  if (!result?.ok || !result.preview) throw new Error(result?.error || "AI_MESSAGE_PARSE_FAILED：未获得可预览的对话。");
  result.preview = await normalizePreview(result.preview);
  if (result.preview.snapshot.externalConversationId !== ctx.identity.id || result.preview.snapshot.provider !== ctx.identity.provider) throw new Error("会话已切换，请重新预览。");
  if ((await context(tabId)).scope !== ctx.scope) throw new Error("Nowen 账号已切换，请重新预览。");
  const previewId = crypto.randomUUID();
  for (const [id, entry] of previews) if (entry.expiresAt < Date.now()) previews.delete(id);
  previews.set(previewId, { preview: result.preview, scope: ctx.scope, tabId, expiresAt: Date.now() + 5 * 60_000 });
  knownTabs.add(tabId);
  return { previewId, preview: result.preview };
}
async function save(message: { tabId: number; previewId: string; notebookId: string; sourceName: string; automatic: boolean }) {
  const ctx = await context(message.tabId);
  const cached = previews.get(message.previewId);
  if (!cached || cached.tabId !== message.tabId || cached.scope !== ctx.scope || cached.expiresAt < Date.now()
    || cached.preview.snapshot.externalConversationId !== ctx.identity.id) throw new Error("预览已失效或会话已切换，请重新授权预览。");
  if (!message.notebookId) throw new Error("请选择已有的个人笔记本作为归档位置。");
  if (!message.sourceName?.trim()) throw new Error("请填写来源账户名称，用来区分不同 AI 账号。");
  if (message.automatic && !cached.preview.stableIds) throw new Error("页面没有稳定消息 ID，无法安全开启自动保存。");
  const stable = cached.preview.snapshot.messages.filter((entry) => entry.captureState !== "streaming");
  if (!stable.length) throw new Error("AI 回复仍在生成，当前没有稳定消息可保存。");
  await change((data) => {
    let grant: CaptureGrant | undefined = data.grants[ctx.key];
    if (grant?.source.permissionState === "revoked") {
      if (data.queue.some((entry) => entry.grantKey === ctx.key)) throw new Error("此会话的旧来源仍有暂存内容，请先处理或明确清空暂存队列，再使用新的来源账户名称授权。");
      if (grant.source.displayName === message.sourceName.trim()) throw new Error("原来源已撤销，请填写新的来源账户名称以创建独立授权。");
      delete data.grants[ctx.key];
      grant = undefined;
    }
    if (grant && (grant.source.notebookId !== message.notebookId || grant.source.displayName !== message.sourceName.trim())) throw new Error("此会话已绑定其他来源或笔记本，请先撤销原来源。归档不会自动迁移。");
    if (grant?.accountMarker && grant.accountMarker !== cached.preview.accountMarker) throw new Error("网站账号标识已变化，请选择新的来源账户名称。");
    if (!grant) {
      const sameSource = Object.values(data.grants).find((entry) => entry.scope === ctx.scope && entry.provider === ctx.identity.provider
        && entry.source.notebookId === message.notebookId && entry.source.displayName === message.sourceName.trim() && entry.source.permissionState === "granted"
        && (!entry.accountMarker || entry.accountMarker === cached.preview.accountMarker));
      const source: ArchiveSource = sameSource?.source || {
        id: "", provider: cached.preview.snapshot.provider, accountScope: crypto.randomUUID(), notebookId: message.notebookId,
        displayName: message.sourceName.trim().slice(0, 120), captureEnabled: message.automatic, permissionState: "granted",
      };
      grant = { scope: ctx.scope, provider: source.provider, externalConversationId: ctx.identity.id, sourceUrl: ctx.identity.url,
        source, accountMarker: cached.preview.accountMarker, automatic: message.automatic, revision: 0, authorizationCheckedAt: Date.now() };
      data.grants[ctx.key] = grant;
    }
    grant.automatic = message.automatic;
    grant.authorizationCheckedAt = Date.now();
    grant.error = undefined;
    const snapshot = { ...cached.preview.snapshot, messages: stable, accountScope: grant.source.accountScope };
    enqueueArchive(data, {
      id: crypto.randomUUID(), grantKey: ctx.key, scope: ctx.scope, queuedAt: Date.now(), attempts: 0, nextAttemptAt: 0,
      payload: { sourceId: grant.source.id, operationId: crypto.randomUUID(), expectedRevision: grant.revision, mode: "manual", snapshot },
    });
  });
  previews.delete(message.previewId);
  notify();
  // Enabling an existing source is explicit; a failed PATCH leaves automatic entries blocked by the server.
  const grant = await change((data) => structuredClone(data.grants[ctx.key]));
  if (grant.source.id) {
    try {
      const enableSource = message.automatic || grant.source.captureEnabled;
      await requestAIArchive(ctx.config, `/sources/${encodeURIComponent(grant.source.id)}`, { permissionState: "granted", captureEnabled: enableSource }, "PATCH");
      await change((data) => { for (const entry of Object.values(data.grants)) if (entry.scope === ctx.scope && entry.source.id === grant.source.id) entry.source.captureEnabled = enableSource; });
    } catch { /* The manual save remains queued; automatic requests cannot bypass server pause. */ }
  }
  await flush();
  return status(message.tabId);
}
async function autosave(tabId: number, captured: CapturePreview) {
  const ctx = await context(tabId);
  if (!captured || !captured.stableIds || captured.snapshot.externalConversationId !== ctx.identity.id || captured.snapshot.provider !== ctx.identity.provider) throw new Error("AI_SOURCE_NOT_AUTHORIZED：会话授权不匹配。");
  captured = await normalizePreview(captured);
  await change((data) => {
    const grant = data.grants[ctx.key];
    if (!grant?.automatic || grant.source.permissionState !== "granted" || (grant.accountMarker && grant.accountMarker !== captured.accountMarker)) throw new Error("AI_SOURCE_NOT_AUTHORIZED：授权已暂停或网站账号已变化。");
    const snapshot = { ...captured.snapshot, accountScope: grant.source.accountScope };
    enqueueArchive(data, { id: crypto.randomUUID(), grantKey: ctx.key, scope: ctx.scope, queuedAt: Date.now(), attempts: 0, nextAttemptAt: 0,
      payload: { sourceId: grant.source.id, operationId: crypto.randomUUID(), expectedRevision: grant.revision, mode: "automatic", snapshot } });
  });
  void flush();
  return { queued: true };
}
async function status(tabId: number) {
  const ctx = await context(tabId);
  return change((data) => {
    const grant = data.grants[ctx.key];
    const pending = data.queue.filter((entry) => entry.scope === ctx.scope);
    return { provider: ctx.identity.provider, grant, pending: pending.length, blocked: pending.filter((entry) => !!entry.blocked).length,
      currentPending: pending.filter((entry) => entry.grantKey === ctx.key).length,
      noteUrl: grant?.receipt?.noteId ? buildNoteUrl(ctx.config, grant.receipt.noteId) : undefined };
  });
}
async function manage(tabId: number, action: string) {
  const ctx = await context(tabId);
  const source = await change((data) => {
    const grant = data.grants[ctx.key];
    if (action === "clear") { data.queue = data.queue.filter((entry) => entry.scope !== ctx.scope); return; }
    if (action === "retry") {
      for (const item of data.queue) if (item.scope === ctx.scope && !item.blocked?.includes("CONFLICT") && !item.blocked?.includes("REVOKED") && data.grants[item.grantKey]?.source.permissionState === "granted") {
        item.blocked = undefined; item.nextAttemptAt = 0; item.attempts = 0; item.queuedAt = Date.now();
      }
      return;
    }
    if (!grant) return;
    if (action === "pause") { grant.automatic = false; return; }
    for (const other of Object.values(data.grants)) if (other.scope === ctx.scope && other.source.accountScope === grant.source.accountScope) {
      other.automatic = false;
      other.source.captureEnabled = false;
      if (action === "revoke") other.source.permissionState = "revoked";
    }
    for (const item of data.queue) if (item.scope === ctx.scope && data.grants[item.grantKey]?.source.accountScope === grant.source.accountScope) item.blocked = "AI_SOURCE_NOT_AUTHORIZED：来源已暂停或撤销，内容仍保留。";
    return structuredClone(grant.source);
  });
  notify();
  if (source?.id) {
    try { await requestAIArchive(ctx.config, `/sources/${encodeURIComponent(source.id)}`, { captureEnabled: false, ...(action === "revoke" ? { permissionState: "revoked" } : {}) }, "PATCH"); }
    catch { return { ...await status(tabId), warning: "本机采集已停止，服务端授权更新失败；请在 Nowen AI 记忆页面检查来源状态。" }; }
  }
  if (action === "retry") await flush();
  return status(tabId);
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || !message?.type?.startsWith("AI_")) return;
  const fromPopup = sender.url === chrome.runtime.getURL("popup/index.html");
  const fromContent = !fromPopup && sender.tab?.id !== undefined && sender.frameId === 0;
  let task: Promise<unknown> | undefined;
  if (fromContent && message.type === "AI_CAPTURE_PERMISSION") task = permission(sender.tab!.id!, message.url);
  if (fromContent && message.type === "AI_AUTOSAVE") task = autosave(sender.tab!.id!, message.preview);
  if (fromContent && message.type === "AI_CAPTURE_ERROR") task = context(sender.tab!.id!).then((ctx) => change((data) => {
    const grant = data.grants[ctx.key]; if (grant) { grant.automatic = false; grant.error = String(message.error || "采集已暂停").slice(0, 400); }
  }));
  if (fromPopup) {
    if (message.type === "AI_PREVIEW") task = preview(message.tabId);
    if (message.type === "AI_SAVE") task = save(message);
    if (message.type === "AI_STATUS") task = status(message.tabId);
    if (message.type === "AI_MANAGE" && ["pause", "pause-source", "revoke", "retry", "clear"].includes(message.action)) task = manage(message.tabId, message.action);
  }
  if (!task) return;
  void task.then((result) => respond(message.type === "AI_CAPTURE_PERMISSION" ? result : { ok: true, ...result as object }))
    .catch((error: unknown) => respond(message.type === "AI_CAPTURE_PERMISSION" ? { allowed: false } : { ok: false, error: describe(error) }));
  return true;
});
chrome.storage.onChanged.addListener((changes) => {
  if (changes.nowenClipperConfig) { previews.clear(); notify(); void flush(); }
});
chrome.tabs.onRemoved.addListener((tabId) => knownTabs.delete(tabId));
const RETRY_ALARM = "nowen-ai-archive-retry";
// Recreate on every worker start: alarms are not guaranteed to survive browser restarts.
void chrome.alarms.create(RETRY_ALARM, { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === RETRY_ALARM) void flush(); });
void flush();
