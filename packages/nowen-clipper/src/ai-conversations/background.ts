import { createContentScriptBridge } from "../lib/content-script-bridge";
import { buildNoteUrl, ensurePersonalNotebook, NowenApiError, ping, requestAIArchive } from "../lib/api";
import { getConfig } from "../lib/storage";
import { acknowledgeArchive, AI_STORAGE_KEY, archiveScope, covers, emptyAIState, enqueueArchive, failPending, grantKey, NOTE_KEPT, RETRY_WINDOW_MS, type AIArchiveState } from "./queue";
import type { ArchiveReceipt, ArchiveSource, CaptureGrant, CapturePreview, ConversationSnapshot, QuickStatus } from "./types";
import { normalizePreview } from "./normalize";

const bridge = createContentScriptBridge();
const knownTabs = new Set<number>();
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
const LOGIN_REQUIRED = "AI_LOGIN_REQUIRED：请先在 Nowen 扩展里登录服务器账号（桌面配对暂不支持保存对话）。";
async function context(tabId: number) {
  const config = await getConfig();
  if (!config.serverUrl || !config.token) throw new Error(LOGIN_REQUIRED);
  const scope = archiveScope(config);
  const tab = await chrome.tabs.get(tabId);
  const identity = identify(tab.url);
  if (!identity) throw new Error("AI_PLATFORM_UNSUPPORTED：当前地址尚不支持 AI 会话归档，请使用普通剪藏。");
  return { config, scope, identity, key: grantKey(scope, identity.provider, identity.id) };
}
/** AI_GRANT_CHANGED makes tabs re-check auto-saving; AI_STATUS_CHANGED only refreshes the page button. */
function notify(type: "AI_GRANT_CHANGED" | "AI_STATUS_CHANGED" = "AI_GRANT_CHANGED") {
  for (const tabId of knownTabs) void chrome.tabs.sendMessage(tabId, { type }, { frameId: 0 }).catch(() => knownTabs.delete(tabId));
}
function describe(error: unknown) { return (error instanceof Error ? error.message : "保存失败，请稍后重试").slice(0, 400); }
/**
 * The archive of this one conversation cannot take the page as it is now. Unlike source errors
 * (revoked, paused, switched off) only this conversation pauses; the next click saves another copy.
 */
const DIVERGED = new Map([
  ["AI_MESSAGE_ORDER_CONFLICT", "这段对话前面的内容变了（比如重新生成或编辑了消息），和已存的版本对不上，已暂停自动保存。再点「存到 Nowen」会另存一份当前版本，已存的那份不会被改动。"],
  ["AI_SYNC_VERSION_CONFLICT", "这段对话的归档刚在别处更新过，已暂停自动保存。再点「存到 Nowen」会另存一份当前版本，已存的那份不会被改动。"],
  ["AI_MESSAGE_IDENTITY_AMBIGUOUS", "这个页面的消息没有稳定编号，已存的那份没法接着更新，已暂停自动保存。再点「存到 Nowen」会另存一份当前版本。"],
  ["AI_CONVERSATION_DELETED", "这段对话的归档已在 Nowen 里删除，已暂停自动保存。再点「存到 Nowen」会重新存一份。"],
]);
const PROVIDER_NAMES: Record<string, string> = { chatgpt: "ChatGPT", doubao: "豆包" };
/** The snapshot as this conversation's archive knows it: the source's scope and, for a later copy, that copy's identity and title. */
function archived(grant: CaptureGrant, snapshot: ConversationSnapshot): ConversationSnapshot {
  return { ...snapshot, accountScope: grant.source.accountScope, externalConversationId: grant.externalConversationId,
    title: grant.copy ? `${snapshot.title}（第 ${grant.copy} 份）` : snapshot.title };
}

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
        notify("AI_STATUS_CHANGED");
      } catch (error) {
        const diverged = error instanceof NowenApiError ? DIVERGED.get(error.code || "") : undefined;
        await change((data) => {
          const current = data.queue.find((entry) => entry.id === item.id);
          const currentGrant = data.grants[item.grantKey];
          if (!current) return;
          failPending(current, error instanceof NowenApiError ? error.status : undefined, describe(error));
          if (currentGrant && diverged) {
            currentGrant.error = diverged;
            currentGrant.automatic = false;
            currentGrant.diverged = true;
          } else if (currentGrant) {
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
    let reason = "AI_SOURCE_NOT_AUTHORIZED：服务端来源已暂停、撤销或无法确认授权，已停止自动采集。";
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
        // The server can have the archive switched off; say so instead of blaming the source.
        if (error instanceof NowenApiError && error.code === "AI_MEMORY_DISABLED") reason = "AI_MEMORY_DISABLED：此 Nowen 服务器未开启 AI 对话归档，已停止自动保存；管理员在「设置 → 开关」中开启后，再点「存到 Nowen」即可继续。";
      }
    } else denied = Date.now() - (local.authorizationCheckedAt || 0) >= RETRY_WINDOW_MS;
    if (denied) {
      await change((data) => {
        for (const current of Object.values(data.grants)) if (current.scope === ctx.scope && current.source.accountScope === local.source.accountScope) {
          current.automatic = false;
          current.error = reason;
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
const DEFAULT_ARCHIVE_NOTEBOOK = "AI 对话";
/**
 * One click on 「存到 Nowen」 is the person's consent: save everything the page shows now into the
 * personal 「AI 对话」 notebook and, when the page gives stable message IDs, keep saving new messages.
 * The source is created on the first click and shared by later conversations of the same site.
 */
async function quickSave(tabId: number, captured?: CapturePreview) {
  const config = await getConfig();
  if (!config.serverUrl || !config.token) {
    void chrome.runtime.openOptionsPage().catch(() => undefined);
    throw new Error(LOGIN_REQUIRED.replace("。", "，已打开登录页。"));
  }
  const ctx = await context(tabId);
  if (!captured) {
    const result = await bridge.request(tabId, { type: "AI_PREVIEW_CONTENT" }) as { ok: boolean; preview?: CapturePreview; error?: string };
    if (!result?.ok || !result.preview) throw new Error(result?.error || "AI_MESSAGE_PARSE_FAILED：没有读到这段对话。");
    captured = result.preview;
  }
  const preview = await normalizePreview(captured);
  if (preview.snapshot.externalConversationId !== ctx.identity.id || preview.snapshot.provider !== ctx.identity.provider) throw new Error("页面已切换到别的对话，请再点一次。");
  const stable = preview.snapshot.messages.filter((entry) => entry.captureState !== "streaming");
  if (!stable.length) throw new Error("AI 还在生成回复，等它写完再点一次。");
  const automatic = preview.stableIds;
  knownTabs.add(tabId);
  const reusable = (data: AIArchiveState): ArchiveSource | undefined => {
    const own = data.grants[ctx.key];
    if (own?.source.permissionState === "granted") return own.source;
    return Object.values(data.grants).find((entry) => entry.scope === ctx.scope && entry.provider === ctx.identity.provider
      && entry.source.permissionState === "granted" && (!entry.accountMarker || entry.accountMarker === preview.accountMarker))?.source;
  };
  const known = await change((data) => !!reusable(data));
  const notebookId = known ? "" : (await ensurePersonalNotebook(ctx.config, DEFAULT_ARCHIVE_NOTEBOOK)).id;
  if ((await context(tabId)).key !== ctx.key) throw new Error("Nowen 账号或页面已切换，请再点一次。");
  await change((data) => {
    let grant: CaptureGrant | undefined = data.grants[ctx.key];
    const items = data.queue.filter((entry) => entry.grantKey === ctx.key);
    if (grant?.source.permissionState === "revoked") {
      // Left by an older extension version, which could revoke a source here.
      if (items.length) throw new Error("这段对话还有旧来源没发出的内容，请先在扩展弹窗里重试或清空暂存。");
      delete data.grants[ctx.key];
      grant = undefined;
    }
    if (grant?.accountMarker && preview.accountMarker && grant.accountMarker !== preview.accountMarker) throw new Error("网站登录的账号变了，这段对话没有保存。");
    if (!grant) {
      const shared = reusable(data);
      const source: ArchiveSource | undefined = shared ? structuredClone(shared) : notebookId ? {
        id: "", provider: ctx.identity.provider as ArchiveSource["provider"], accountScope: crypto.randomUUID(), notebookId,
        displayName: PROVIDER_NAMES[ctx.identity.provider], captureEnabled: automatic, permissionState: "granted",
      } : undefined;
      if (!source) throw new Error("保存位置刚有变化，请再点一次。");
      grant = { scope: ctx.scope, provider: source.provider, externalConversationId: ctx.identity.id, sourceUrl: ctx.identity.url,
        source, accountMarker: preview.accountMarker, automatic, revision: 0, authorizationCheckedAt: Date.now() };
      data.grants[ctx.key] = grant;
    }
    if (grant.diverged) {
      // FIFO per conversation: once its first item was refused, nothing after it has been sent.
      if (items[0]?.started && !items[0].blocked) throw new Error("上一次的内容还在发送，请过几秒再点。");
      if (items.some((entry) => !covers(stable, entry.payload.snapshot.messages))) throw new Error("这段对话有没发出的旧内容和当前页面对不上，请先在扩展弹窗里重试或清空暂存。");
      // Everything still waiting is on the page now and goes into the new copy; the old archive stays as it is.
      data.queue = data.queue.filter((entry) => entry.grantKey !== ctx.key);
      grant.copy = (grant.copy || 1) + 1;
      grant.externalConversationId = `${ctx.identity.id}~${grant.copy}`;
      grant.revision = 0;
      grant.receipt = undefined;
      grant.diverged = false;
    } else {
      // A click is also the person retrying: what waits for this conversation is sent again, in order.
      for (const entry of items) if (entry.blocked) { entry.blocked = undefined; entry.nextAttemptAt = 0; entry.attempts = 0; entry.queuedAt = Date.now(); }
    }
    grant.automatic = automatic;
    grant.authorizationCheckedAt = Date.now();
    grant.error = undefined;
    enqueueArchive(data, {
      id: crypto.randomUUID(), grantKey: ctx.key, scope: ctx.scope, queuedAt: Date.now(), attempts: 0, nextAttemptAt: 0,
      payload: { sourceId: grant.source.id, operationId: crypto.randomUUID(), expectedRevision: grant.revision, mode: "manual", snapshot: archived(grant, { ...preview.snapshot, messages: stable }) },
    });
  });
  const grant = await change((data) => structuredClone(data.grants[ctx.key]));
  if (grant.source.id) {
    // The click also turns the source back on if it was paused or revoked in Nowen.
    try {
      const captureEnabled = automatic || grant.source.captureEnabled;
      await requestAIArchive(ctx.config, `/sources/${encodeURIComponent(grant.source.id)}`, { permissionState: "granted", captureEnabled }, "PATCH");
      await change((data) => { for (const entry of Object.values(data.grants)) if (entry.scope === ctx.scope && entry.source.id === grant.source.id) entry.source.captureEnabled = captureEnabled; });
    } catch { /* The manual save stays queued; automatic saves cannot bypass a paused source. */ }
  }
  await flush();
  // Only now, after the source is on, may the page start saving new messages.
  notify();
}
async function autosave(tabId: number, captured: CapturePreview) {
  const ctx = await context(tabId);
  if (!captured || !captured.stableIds || captured.snapshot.externalConversationId !== ctx.identity.id || captured.snapshot.provider !== ctx.identity.provider) throw new Error("AI_SOURCE_NOT_AUTHORIZED：会话授权不匹配。");
  captured = await normalizePreview(captured);
  await change((data) => {
    const grant = data.grants[ctx.key];
    if (!grant?.automatic || grant.source.permissionState !== "granted" || (grant.accountMarker && grant.accountMarker !== captured.accountMarker)) throw new Error("AI_SOURCE_NOT_AUTHORIZED：授权已暂停或网站账号已变化。");
    const snapshot = archived(grant, captured.snapshot);
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
async function quickStatus(tabId: number): Promise<QuickStatus> {
  const ctx = await context(tabId);
  knownTabs.add(tabId);
  return change((data) => {
    const grant = data.grants[ctx.key];
    if (!grant) return { state: "idle", automatic: false, canOpen: false };
    const items = data.queue.filter((entry) => entry.grantKey === ctx.key);
    const blocked = items.find((entry) => entry.blocked);
    const base = { automatic: grant.automatic && grant.source.permissionState === "granted", canOpen: !!grant.receipt?.noteId };
    if (blocked) return { ...base, state: "error", message: grant.error || blocked.blocked };
    if (items.length) return { ...base, state: "saving", message: items.some((entry) => entry.attempts) ? "暂存在本机，连上 Nowen 后会自动发送。" : undefined };
    if (grant.error && grant.error !== NOTE_KEPT) return { ...base, state: "error", message: grant.error };
    return { ...base, state: grant.receipt ? "saved" : "idle", message: grant.error };
  });
}
async function openNote(tabId: number) {
  const ctx = await context(tabId);
  const grant = await change((data) => structuredClone(data.grants[ctx.key]));
  if (!grant?.receipt?.noteId) throw new Error("这段对话还没存好。");
  await chrome.tabs.create({ url: buildNoteUrl(ctx.config, grant.receipt.noteId) });
  return quickStatus(tabId);
}
async function manage(tabId: number, action: string) {
  const ctx = await context(tabId);
  await change((data) => {
    if (action === "clear") { data.queue = data.queue.filter((entry) => entry.scope !== ctx.scope); return; }
    if (action === "retry") {
      for (const item of data.queue) if (item.scope === ctx.scope && !item.blocked?.includes("CONFLICT") && !item.blocked?.includes("REVOKED") && data.grants[item.grantKey]?.source.permissionState === "granted") {
        item.blocked = undefined; item.nextAttemptAt = 0; item.attempts = 0; item.queuedAt = Date.now();
      }
      return;
    }
    // "pause": stop auto-saving this conversation only; the source and other conversations go on.
    const grant = data.grants[ctx.key];
    if (grant) grant.automatic = false;
  });
  notify();
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
  // The page button. The content script sends AI_QUICK_SAVE only after a real click, with what it read then.
  if (fromContent && message.type === "AI_QUICK_SAVE" && message.preview) task = quickSave(sender.tab!.id!, message.preview).then(() => quickStatus(sender.tab!.id!));
  if (fromContent && message.type === "AI_QUICK_STATUS") task = quickStatus(sender.tab!.id!);
  if (fromContent && message.type === "AI_QUICK_STOP") task = manage(sender.tab!.id!, "pause").then(() => quickStatus(sender.tab!.id!));
  if (fromContent && message.type === "AI_QUICK_OPEN") task = openNote(sender.tab!.id!);
  if (fromPopup) {
    if (message.type === "AI_QUICK_SAVE") task = quickSave(message.tabId).then(() => status(message.tabId));
    if (message.type === "AI_STATUS") task = status(message.tabId);
    if (message.type === "AI_MANAGE" && ["pause", "retry", "clear"].includes(message.action)) task = manage(message.tabId, message.action);
  }
  if (!task) return;
  void task.then((result) => respond(message.type === "AI_CAPTURE_PERMISSION" ? result : { ok: true, ...result as object }))
    .catch((error: unknown) => respond(message.type === "AI_CAPTURE_PERMISSION" ? { allowed: false } : { ok: false, error: describe(error) }));
  return true;
});
chrome.storage.onChanged.addListener((changes) => {
  if (changes.nowenClipperConfig) { notify(); void flush(); }
});
chrome.tabs.onRemoved.addListener((tabId) => knownTabs.delete(tabId));
const RETRY_ALARM = "nowen-ai-archive-retry";
// Recreate on every worker start: alarms are not guaranteed to survive browser restarts.
void chrome.alarms.create(RETRY_ALARM, { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === RETRY_ALARM) void flush(); });
void flush();
