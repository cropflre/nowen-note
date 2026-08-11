const BRIDGE_FLAG = "__nowenDesktopNativeHttpBridgeInstalled";
const DEFAULT_NATIVE_TIMEOUT_MS = 30_000;

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];
type FetchFn = typeof fetch;

interface DesktopHttpResult {
  ok: boolean;
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  body?: string;
  url?: string;
  error?: string;
}

interface DesktopHttpBridge {
  requestJson(payload: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: string;
  }): Promise<DesktopHttpResult>;
}

function getDesktopHttpBridge(): DesktopHttpBridge | null {
  if (typeof window === "undefined") return null;
  const desktop = (window as any).nowenDesktop;
  return desktop?.isDesktop && typeof desktop.http?.requestJson === "function"
    ? desktop.http as DesktopHttpBridge
    : null;
}

function isRequest(input: FetchInput): input is Request {
  return typeof Request !== "undefined" && input instanceof Request;
}

function getRequestUrl(input: FetchInput): string {
  return isRequest(input) ? input.url : String(input);
}

function getRequestMethod(input: FetchInput, init?: FetchInit): string {
  return (init?.method || (isRequest(input) ? input.method : "GET") || "GET").toUpperCase();
}

function getRequestSignal(input: FetchInput, init?: FetchInit): AbortSignal | null {
  return init?.signal || (isRequest(input) ? input.signal : null) || null;
}

function mergeRequestHeaders(input: FetchInput, init?: FetchInit): Record<string, string> {
  const headers = new Headers(isRequest(input) ? input.headers : undefined);
  if (init?.headers) {
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  }
  const result: Record<string, string> = {};
  headers.forEach((value, key) => { result[key] = value; });
  return result;
}

function getRequestBody(input: FetchInput, init?: FetchInit): BodyInit | null | undefined {
  return init?.body ?? (isRequest(input) ? input.body : undefined);
}

function isJsonApiRequest(input: FetchInput, init?: FetchInit): boolean {
  const method = getRequestMethod(input, init);
  if (!["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(method)) return false;

  const body = getRequestBody(input, init);
  if (body !== undefined && body !== null && typeof body !== "string") return false;

  try {
    const url = new URL(getRequestUrl(input), window.location.href);
    if (!/^https?:$/.test(url.protocol) || !/(?:^|\/)api(?:\/|$)/.test(url.pathname)) return false;
    const headers = mergeRequestHeaders(input, init);
    const contentType = headers["content-type"] || "";
    const accept = headers.accept || "";
    if (/text\/event-stream/i.test(accept) || /(?:^|\/)api\/ai(?:\/|$)/.test(url.pathname)) return false;
    if (/json/i.test(contentType) || /json/i.test(accept)) return true;
    return /(?:^|\/)api\/(?:auth\/(?:login|refresh|2fa\/verify|register(?:\/config)?)|settings|health|version)\/?$/.test(url.pathname);
  } catch {
    return false;
  }
}

function createBridgeError(message: string, name = "NetworkError"): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

async function withAbortAndTimeout<T>(
  promise: Promise<T>,
  signal: AbortSignal | null,
  timeoutMs: number,
): Promise<T> {
  if (signal?.aborted) throw createBridgeError("The request was aborted", "AbortError");
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeoutId);
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(createBridgeError("The request was aborted", "AbortError")));
    const timeoutId = window.setTimeout(
      () => finish(() => reject(createBridgeError("Desktop HTTP request timed out", "TimeoutError"))),
      timeoutMs,
    );
    signal?.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

async function desktopNativeFetch(
  bridge: DesktopHttpBridge,
  input: FetchInput,
  init: FetchInit | undefined,
  timeoutMs: number,
): Promise<Response> {
  const method = getRequestMethod(input, init);
  const requestBody = getRequestBody(input, init);
  const result = await withAbortAndTimeout(
    bridge.requestJson({
      url: new URL(getRequestUrl(input), window.location.href).toString(),
      method,
      headers: mergeRequestHeaders(input, init),
      body: typeof requestBody === "string" ? requestBody : undefined,
    }),
    getRequestSignal(input, init),
    timeoutMs,
  );
  if (!result.ok || typeof result.status !== "number") {
    throw createBridgeError(result.error || "Desktop HTTP request failed");
  }
  const responseBody = method === "HEAD"
    || result.status === 204
    || result.status === 205
    || result.status === 304
    ? null
    : result.body || "";
  return new Response(responseBody, {
    status: result.status,
    statusText: result.statusText || "",
    headers: result.headers || {},
  });
}

/**
 * Electron 始终加载 file:// 本地前端。JSON API 通过主进程 session.fetch 发送，
 * 不依赖反向代理正确处理 renderer 的 CORS 预检；上传、下载和流式请求保持原路径。
 */
export function installDesktopNativeHttpBridge(): (() => void) | null {
  const bridge = getDesktopHttpBridge();
  if (!bridge) return null;

  const runtime = window as typeof window & Record<string, unknown>;
  if (runtime[BRIDGE_FLAG]) return null;
  const originalFetch: FetchFn = window.fetch.bind(window);

  const bridgedFetch: FetchFn = async (input, init) => {
    if (!isJsonApiRequest(input, init)) return originalFetch(input, init);
    try {
      return await desktopNativeFetch(bridge, input, init, DEFAULT_NATIVE_TIMEOUT_MS);
    } catch (nativeError) {
      const signal = getRequestSignal(input, init);
      if (signal?.aborted) throw nativeError;
      // 主进程请求发出后无法确认服务端是否已经处理；写请求禁止回退重发。
      const method = getRequestMethod(input, init);
      if (method !== "GET" && method !== "HEAD") throw nativeError;
      console.warn("[desktop-http] native request failed; falling back to renderer fetch", {
        method,
        url: getRequestUrl(input),
        errorName: (nativeError as { name?: string })?.name,
        errorMessage: (nativeError as { message?: string })?.message,
      });
      return originalFetch(input, init);
    }
  };

  runtime[BRIDGE_FLAG] = true;
  window.fetch = bridgedFetch;
  return () => {
    if (window.fetch === bridgedFetch) window.fetch = originalFetch;
    delete runtime[BRIDGE_FLAG];
  };
}
