import { extractConversation } from "./adapters";
import type { CapturePreview } from "./types";

export interface AutoPermission {
  allowed: boolean;
  accountMarker?: string | null;
}
export interface CaptureRuntimeOptions {
  doc: Document;
  url(): string;
  permission(url: string): Promise<AutoPermission>;
  submit(preview: CapturePreview): Promise<void>;
  fail(message: string): void;
  extract?: typeof extractConversation;
  debounceMs?: number;
}

/** No DOM access occurs until permission() grants this exact conversation. */
export function createCaptureController(options: CaptureRuntimeOptions) {
  let stopped = false;
  let generation = 0;
  let observer: MutationObserver | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let currentUrl = "";
  let lastHash = "";
  let running = false;
  const extract = options.extract || extractConversation;
  function disconnect() {
    generation += 1;
    observer?.disconnect();
    observer = undefined;
    clearTimeout(timer);
    timer = undefined;
    lastHash = "";
  }
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(() => { void capture(); }, options.debounceMs ?? 3000);
  }
  async function capture() {
    if (stopped || running || !observer) return;
    running = true;
    const pendingGeneration = generation;
    try {
      const permission = await options.permission(currentUrl);
      if (stopped || pendingGeneration !== generation) return;
      if (!permission.allowed || options.url() !== currentUrl) { disconnect(); return; }
      const preview = await extract(options.doc, currentUrl);
      if (stopped || pendingGeneration !== generation) return;
      if (!preview.stableIds) throw new Error("AI_MESSAGE_IDENTITY_AMBIGUOUS：页面缺少稳定消息 ID，已暂停自动保存，请改用手动预览。");
      if (permission.accountMarker && preview.accountMarker !== permission.accountMarker) throw new Error("AI_SOURCE_NOT_AUTHORIZED：网站账号发生变化，已停止自动保存。请重新选择来源并授权。");
      const messages = preview.snapshot.messages.filter((message) => message.captureState === "stable");
      // Never mark a generated reply stable merely because the DOM was quiet for a while.
      if (!messages.length) return;
      preview.snapshot.messages = messages;
      const hash = JSON.stringify(messages.map((message) => [message.externalMessageId, message.contentHash]));
      if (hash === lastHash) return;
      if (stopped || options.url() !== currentUrl || pendingGeneration !== generation) return;
      await options.submit(preview);
      if (pendingGeneration === generation) lastHash = hash;
    } catch (error) {
      if (stopped || pendingGeneration !== generation || options.url() !== currentUrl) return;
      options.fail(error instanceof Error ? error.message : "AI_MESSAGE_PARSE_FAILED：采集失败，已暂停自动保存。");
      disconnect();
    } finally { running = false; }
  }
  async function refresh() {
    disconnect();
    if (stopped) return;
    currentUrl = options.url();
    const pendingGeneration = generation;
    const permission = await options.permission(currentUrl);
    if (stopped || pendingGeneration !== generation || options.url() !== currentUrl || !permission.allowed) return;
    const Observer = options.doc.defaultView?.MutationObserver;
    if (!Observer) return;
    observer = new Observer(schedule);
    observer.observe(options.doc.documentElement, { childList: true, characterData: true, attributes: true, attributeFilter: ["data-is-streaming", "data-streaming", "data-message-id", "data-account-id"], subtree: true });
    schedule();
  }
  return { refresh, stop() { stopped = true; disconnect(); } };
}

export function installAICaptureRuntime(doc: Document, win: Window): () => void {
  const controller = createCaptureController({
    doc, url: () => win.location.href,
    permission: (url) => chrome.runtime.sendMessage({ type: "AI_CAPTURE_PERMISSION", url }),
    submit: async (preview) => {
      const response = await chrome.runtime.sendMessage({ type: "AI_AUTOSAVE", preview });
      if (!response?.ok) throw new Error(response?.error || "AI_SYNC_RETRY_REQUIRED：无法暂存对话，自动保存已暂停。");
    },
    fail: (error) => { void chrome.runtime.sendMessage({ type: "AI_CAPTURE_ERROR", url: win.location.href, error }).catch(() => undefined); },
  });
  let lastUrl = win.location.href;
  const poll = win.setInterval(() => {
    if (lastUrl === win.location.href) return;
    lastUrl = win.location.href;
    void controller.refresh().catch(() => undefined);
  }, 1000);
  const listener = (message: { type?: string }, sender: chrome.runtime.MessageSender, sendResponse: (value: unknown) => void) => {
    if (sender.id !== chrome.runtime.id) return;
    if (message?.type === "AI_PREVIEW_CONTENT") {
      void extractConversation(doc, win.location.href).then((preview) => sendResponse({ ok: true, preview }))
        .catch((error: unknown) => sendResponse({ ok: false, error: error instanceof Error ? error.message : "无法读取对话" }));
      return true;
    }
    if (message?.type === "AI_GRANT_CHANGED") { void controller.refresh().catch(() => undefined); sendResponse({ ok: true }); }
  };
  chrome.runtime.onMessage.addListener(listener);
  const stop = () => { controller.stop(); win.clearInterval(poll); chrome.runtime.onMessage.removeListener(listener); };
  win.addEventListener("pagehide", stop, { once: true });
  void controller.refresh().catch(() => undefined);
  return () => { stop(); win.removeEventListener("pagehide", stop); };
}
