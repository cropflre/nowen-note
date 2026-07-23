import {
  CONTENT_SCRIPT_PROTOCOL_VERSION,
  type ClipperConnectionErrorCode,
  type ContentScriptPingRequest,
  type ContentScriptPingResponse,
  type ExtractRequest,
  type ExtractResponse,
} from "./protocol";

export interface ContentScriptBridgeTab {
  url?: string;
}

export interface ContentScriptBridgeAdapter {
  getTab(tabId: number): Promise<ContentScriptBridgeTab>;
  sendMessage(tabId: number, message: unknown): Promise<unknown>;
  injectContentScript(tabId: number): Promise<void>;
  delay(ms: number): Promise<void>;
}

export interface TabInjectionCapability {
  injectable: boolean;
  code?: ClipperConnectionErrorCode;
  message?: string;
}

export class ContentScriptBridgeError extends Error {
  constructor(
    public readonly code: ClipperConnectionErrorCode,
    message: string,
    public readonly internalMessage = "",
  ) {
    super(message);
    this.name = "ContentScriptBridgeError";
  }
}

const RESTRICTED_SCHEMES = new Set([
  "about:",
  "chrome:",
  "chrome-extension:",
  "devtools:",
  "edge:",
  "javascript:",
  "moz-extension:",
  "opera:",
  "view-source:",
  "vivaldi:",
]);

const RESTRICTED_STORE_HOSTS = new Set([
  "chrome.google.com",
  "chromewebstore.google.com",
  "microsoftedge.microsoft.com",
  "addons.mozilla.org",
]);

const RECEIVER_MISSING_RE = /could not establish connection|receiving end does not exist|message port closed|no receiving end/i;
const TAB_MISSING_RE = /no tab with id|invalid tab id|tab (?:was )?closed|the tab was closed/i;
const ACCESS_DENIED_RE = /cannot access|not allowed|missing host permission|extensions gallery cannot be scripted|cannot be scripted/i;

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error || "");
}

export function classifyTabUrl(rawUrl: string | undefined): TabInjectionCapability {
  if (!rawUrl) {
    return {
      injectable: false,
      code: "TAB_UNAVAILABLE",
      message: "当前标签页地址不可用，请重新打开页面后重试。",
    };
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return {
      injectable: false,
      code: "PAGE_NOT_INJECTABLE",
      message: "当前页面地址无法识别，插件不能读取其内容。",
    };
  }

  if (RESTRICTED_SCHEMES.has(url.protocol)) {
    return {
      injectable: false,
      code: "PAGE_NOT_INJECTABLE",
      message: "当前页面受浏览器保护，插件无法读取内容。请在普通网页中使用剪藏。",
    };
  }

  if ((url.protocol === "http:" || url.protocol === "https:") && RESTRICTED_STORE_HOSTS.has(url.hostname.toLowerCase())) {
    return {
      injectable: false,
      code: "PAGE_NOT_INJECTABLE",
      message: "浏览器扩展商店禁止其他扩展读取页面内容，请在普通网页中使用剪藏。",
    };
  }

  if (url.protocol === "http:" || url.protocol === "https:" || url.protocol === "file:") {
    return { injectable: true };
  }

  return {
    injectable: false,
    code: "PAGE_NOT_INJECTABLE",
    message: "当前页面类型不支持剪藏，请在 HTTP、HTTPS 或已授权的本地文件页面中使用。",
  };
}

function normalizeBridgeError(error: unknown): ContentScriptBridgeError {
  if (error instanceof ContentScriptBridgeError) return error;
  const detail = errorMessage(error);
  if (TAB_MISSING_RE.test(detail)) {
    return new ContentScriptBridgeError(
      "TAB_UNAVAILABLE",
      "当前标签页已关闭或正在跳转，请重新打开页面后重试。",
      detail,
    );
  }
  return new ContentScriptBridgeError(
    "CONTENT_SCRIPT_UNAVAILABLE",
    "页面剪藏组件未能启动。请刷新当前网页后重试；若刚更新插件，请重新加载页面。",
    detail,
  );
}

function mapInjectionError(url: string | undefined, error: unknown): ContentScriptBridgeError {
  const detail = errorMessage(error);
  if (TAB_MISSING_RE.test(detail)) {
    return new ContentScriptBridgeError(
      "TAB_UNAVAILABLE",
      "当前标签页已关闭或正在跳转，请重新打开页面后重试。",
      detail,
    );
  }
  if (url?.startsWith("file:")) {
    return new ContentScriptBridgeError(
      "FILE_ACCESS_REQUIRED",
      "当前是本地文件。请在扩展管理页为 Nowen Note Web Clipper 开启“允许访问文件网址”后重试。",
      detail,
    );
  }
  if (ACCESS_DENIED_RE.test(detail)) {
    return new ContentScriptBridgeError(
      "PAGE_NOT_INJECTABLE",
      "当前页面受浏览器保护，插件无法读取内容。请在普通网页中使用剪藏。",
      detail,
    );
  }
  return new ContentScriptBridgeError(
    "CONTENT_SCRIPT_UNAVAILABLE",
    "无法启动页面剪藏组件。请刷新网页，或在扩展管理页重新加载插件后重试。",
    detail,
  );
}

function isExpectedPong(value: unknown): value is ContentScriptPingResponse {
  if (!value || typeof value !== "object") return false;
  const response = value as Partial<ContentScriptPingResponse>;
  return response.type === "CONTENT_SCRIPT_PONG"
    && response.protocolVersion === CONTENT_SCRIPT_PROTOCOL_VERSION;
}

const defaultAdapter: ContentScriptBridgeAdapter = {
  async getTab(tabId) {
    const tab = await chrome.tabs.get(tabId);
    return { url: tab.url };
  },
  async sendMessage(tabId, message) {
    return chrome.tabs.sendMessage(tabId, message);
  },
  async injectContentScript(tabId) {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });
  },
  delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  },
};

export function createContentScriptBridge(adapter: ContentScriptBridgeAdapter = defaultAdapter) {
  const pingRequest: ContentScriptPingRequest = {
    type: "CONTENT_SCRIPT_PING",
    protocolVersion: CONTENT_SCRIPT_PROTOCOL_VERSION,
  };

  async function ping(tabId: number): Promise<boolean> {
    try {
      return isExpectedPong(await adapter.sendMessage(tabId, pingRequest));
    } catch {
      return false;
    }
  }

  async function ensure(tabId: number): Promise<void> {
    if (await ping(tabId)) return;

    let tab: ContentScriptBridgeTab;
    try {
      tab = await adapter.getTab(tabId);
    } catch (error) {
      throw normalizeBridgeError(error);
    }

    const capability = classifyTabUrl(tab.url);
    if (!capability.injectable) {
      throw new ContentScriptBridgeError(
        capability.code || "PAGE_NOT_INJECTABLE",
        capability.message || "当前页面不支持剪藏。",
      );
    }

    try {
      await adapter.injectContentScript(tabId);
    } catch (error) {
      throw mapInjectionError(tab.url, error);
    }

    for (const delayMs of [0, 60, 140, 260]) {
      if (delayMs > 0) await adapter.delay(delayMs);
      if (await ping(tabId)) return;
    }

    throw new ContentScriptBridgeError(
      "CONTENT_SCRIPT_UNAVAILABLE",
      "页面剪藏组件已尝试重新加载，但仍未响应。请刷新当前网页后重试。",
    );
  }

  async function request(tabId: number, message: unknown): Promise<unknown> {
    await ensure(tabId);
    try {
      return await adapter.sendMessage(tabId, message);
    } catch (error) {
      const detail = errorMessage(error);
      if (!RECEIVER_MISSING_RE.test(detail)) throw normalizeBridgeError(error);

      // 页面可能在 Ping 与正式请求之间发生了导航；重新执行一次健康检查与补注入。
      await ensure(tabId);
      try {
        return await adapter.sendMessage(tabId, message);
      } catch (retryError) {
        throw normalizeBridgeError(retryError);
      }
    }
  }

  return { ensure, request };
}

const defaultBridge = createContentScriptBridge();

export async function requestExtractFromTab(
  tabId: number,
  mode: ExtractRequest["mode"],
): Promise<ExtractResponse> {
  const message: ExtractRequest = { type: "EXTRACT_REQUEST", mode };
  try {
    const response = await defaultBridge.request(tabId, message);
    if (!response || typeof response !== "object" || (response as ExtractResponse).type !== "EXTRACT_RESPONSE") {
      throw new ContentScriptBridgeError(
        "CONTENT_SCRIPT_RESPONSE_INVALID",
        "页面剪藏组件返回了无效响应，请刷新网页后重试。",
      );
    }
    return response as ExtractResponse;
  } catch (error) {
    const bridgeError = normalizeBridgeError(error);
    return {
      type: "EXTRACT_RESPONSE",
      ok: false,
      error: bridgeError.message,
      errorCode: bridgeError.code,
    };
  }
}
