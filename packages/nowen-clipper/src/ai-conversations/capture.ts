import { detectConversation, extractConversation } from "./adapters";
import { createSaveButton } from "./save-button";
import type { CapturePreview, QuickStatus } from "./types";

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
    observer.observe(options.doc.documentElement, { childList: true, characterData: true, attributes: true, attributeFilter: ["data-is-streaming", "data-streaming", "data-message-id", "data-account-id", "data-talvt-turn-state", "data-response-body"], subtree: true });
    schedule();
  }
  return { refresh, stop() { stopped = true; disconnect(); } };
}

/** `trusted` only lets tests stand in for a real click; the page script never passes it. */
export function installAICaptureRuntime(doc: Document, win: Window, trusted?: (event: Event) => boolean): () => void {
  const controller = createCaptureController({
    doc, url: () => win.location.href,
    permission: (url) => chrome.runtime.sendMessage({ type: "AI_CAPTURE_PERMISSION", url }),
    submit: async (preview) => {
      const response = await chrome.runtime.sendMessage({ type: "AI_AUTOSAVE", preview });
      if (!response?.ok) throw new Error(response?.error || "AI_SYNC_RETRY_REQUIRED：无法暂存对话，自动保存已暂停。");
    },
    fail: (error) => { void chrome.runtime.sendMessage({ type: "AI_CAPTURE_ERROR", url: win.location.href, error }).catch(() => undefined); },
  });
  const ask = async (type: string, payload: object = {}): Promise<QuickStatus> => {
    const response = await chrome.runtime.sendMessage({ type, ...payload });
    if (!response?.ok) throw new Error(response?.error || "扩展暂时无法处理，请刷新页面后重试。");
    return response;
  };
  // The person can close the button with ✕ and bring it back from the popup. The popup reads and writes the same
  // key (ai-conversations/popup.ts); this script must stay one standalone file, so the two cannot share a module.
  const HIDDEN_KEY = "nowenAIPageButtonHidden";
  // Out of sight until the saved choice is read, so a button the person closed never flashes back in.
  let hidden = true;
  let watching = false;
  // Reading the conversation happens only here, inside the click on the button.
  const button = createSaveButton(doc, {
    save: async () => ask("AI_QUICK_SAVE", { preview: await extractConversation(doc, win.location.href) }),
    status: () => ask("AI_QUICK_STATUS"),
    stop: () => ask("AI_QUICK_STOP"),
    open: () => ask("AI_QUICK_OPEN"),
    dismiss: () => { hidden = true; void chrome.storage.local.set({ [HIDDEN_KEY]: true }).catch(() => undefined); },
    trusted,
  });
  const choose = (saved: unknown) => { hidden = saved === true; place(); };
  // Closing or restoring it in any tab, or from the popup, reaches every open chat page.
  const storageChanged = (changes: { [key: string]: chrome.storage.StorageChange }, area: string) => { if (area === "local" && HIDDEN_KEY in changes) choose(changes[HIDDEN_KEY].newValue); };
  const place = () => {
    const onConversation = !!detectConversation(win.location.href);
    // Each write of the archive state is delivered to every listener of this storage, and this script runs on all pages:
    // only a page that shows a conversation listens, and reads the saved choice, at all.
    if (onConversation && !watching) {
      watching = true;
      chrome.storage.onChanged.addListener(storageChanged);
      void chrome.storage.local.get(HIDDEN_KEY).then((saved) => choose(saved[HIDDEN_KEY])).catch(() => undefined);
    }
    if (onConversation && !hidden) button.show(); else button.hide();
  };
  let lastUrl = win.location.href;
  const poll = win.setInterval(() => {
    // Single-page apps switch conversations without reloading, and may also re-render the page around the button.
    if (lastUrl === win.location.href) { place(); return; }
    lastUrl = win.location.href;
    button.hide();
    place();
    void controller.refresh().catch(() => undefined);
  }, 1000);
  const listener = (message: { type?: string }, sender: chrome.runtime.MessageSender, sendResponse: (value: unknown) => void) => {
    if (sender.id !== chrome.runtime.id) return;
    if (message?.type === "AI_PREVIEW_CONTENT") {
      void extractConversation(doc, win.location.href).then((preview) => sendResponse({ ok: true, preview }))
        .catch((error: unknown) => sendResponse({ ok: false, error: error instanceof Error ? error.message : "无法读取对话" }));
      return true;
    }
    if (message?.type === "AI_GRANT_CHANGED") { void controller.refresh().catch(() => undefined); void button.refresh(); sendResponse({ ok: true }); }
    if (message?.type === "AI_STATUS_CHANGED") { void button.refresh(); sendResponse({ ok: true }); }
  };
  chrome.runtime.onMessage.addListener(listener);
  const stop = () => { controller.stop(); button.hide(); win.clearInterval(poll); chrome.runtime.onMessage.removeListener(listener); chrome.storage.onChanged.removeListener(storageChanged); };
  win.addEventListener("pagehide", stop, { once: true });
  place();
  void controller.refresh().catch(() => undefined);
  return () => { stop(); win.removeEventListener("pagehide", stop); };
}
