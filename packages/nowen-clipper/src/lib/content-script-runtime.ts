export type ContentScriptMessageListener = (...args: any[]) => boolean | void;

export interface ContentScriptRuntimeLike {
  onMessage: {
    addListener(listener: ContentScriptMessageListener): void;
    removeListener(listener: ContentScriptMessageListener): void;
  };
}

export interface ContentScriptRuntimeState {
  version: string;
  listener: ContentScriptMessageListener;
}

const STATE_KEY = "__nowenClipperState";
const LEGACY_LISTENER_KEY = "__nowenClipperListener";
const LEGACY_LOADED_KEY = "__nowenClipperLoaded";

function removeListener(runtime: ContentScriptRuntimeLike, listener: unknown): void {
  if (typeof listener !== "function") return;
  try {
    runtime.onMessage.removeListener(listener as ContentScriptMessageListener);
  } catch {
    // 旧扩展上下文失效时 removeListener 可能失败；继续注册新 listener 即可。
  }
}

/**
 * 每次注入都替换旧 listener，而不是只看一个永久布尔标记后直接退出。
 * 这样扩展安装、更新或重新加载后，旧标签页也能恢复消息通信。
 */
export function installContentScriptListener(
  host: Record<string, unknown>,
  runtime: ContentScriptRuntimeLike,
  version: string,
  listener: ContentScriptMessageListener,
): ContentScriptRuntimeState {
  const previous = host[STATE_KEY] as Partial<ContentScriptRuntimeState> | undefined;
  removeListener(runtime, previous?.listener);

  const legacyListener = host[LEGACY_LISTENER_KEY];
  if (legacyListener !== previous?.listener) removeListener(runtime, legacyListener);

  runtime.onMessage.addListener(listener);
  const state: ContentScriptRuntimeState = { version, listener };
  host[STATE_KEY] = state;
  host[LEGACY_LISTENER_KEY] = listener;
  host[LEGACY_LOADED_KEY] = true;
  return state;
}
