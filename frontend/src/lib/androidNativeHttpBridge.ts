import { Capacitor, CapacitorHttp } from "@capacitor/core";

const BRIDGE_FLAG = "__nowenAndroidNativeHttpBridgeInstalled";
const DEFAULT_NATIVE_TIMEOUT_MS = 30_000;

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];
type FetchFn = typeof fetch;

export interface AndroidNativeHttpBridgeOptions {
  nativeTimeoutMs?: number;
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
  headers.forEach((value, key) => {
    result[key] = value;
  });
  return result;
}

function getRequestBody(input: FetchInput, init?: FetchInit): BodyInit | null | undefined {
  return init?.body ?? (isRequest(input) ? input.body : undefined);
}

function bodyToNativeData(body: BodyInit | null | undefined): unknown {
  if (body === undefined || body === null) return undefined;
  if (typeof body !== "string") return body;
  if (!body) return body;
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

function normalizeResponseHeaders(headers: unknown): Headers {
  const result = new Headers();
  if (!headers || typeof headers !== "object") return result;

  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (value === undefined || value === null) continue;
    result.set(key, Array.isArray(value) ? value.join(", ") : String(value));
  }
  return result;
}

function nativeResponseBody(data: unknown): string {
  if (data === undefined || data === null) return "";
  return typeof data === "string" ? data : JSON.stringify(data);
}

function createBridgeError(message: string, name: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

async function withAbortAndTimeout<T>(
  promise: Promise<T>,
  signal: AbortSignal | null,
  timeoutMs: number,
): Promise<T> {
  if (signal?.aborted) {
    throw createBridgeError("The request was aborted", "AbortError");
  }

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
      () => finish(() => reject(createBridgeError("Native HTTP request timed out", "TimeoutError"))),
      timeoutMs,
    );

    signal?.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

export function isAndroidNativeRuntime(): boolean {
  try {
    return Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android";
  } catch {
    return false;
  }
}

function isNativeCapacitorRuntime(): boolean {
  try {
    return Capacitor.isNativePlatform() && Capacitor.getPlatform() !== "web";
  } catch {
    return false;
  }
}

function isJsonApiRequest(input: FetchInput, init: FetchInit | undefined, url: URL): boolean {
  if (!/(?:^|\/)api(?:\/|$)/.test(url.pathname)) return false;

  const headers = mergeRequestHeaders(input, init);
  const contentType = headers["content-type"] || "";
  const accept = headers.accept || "";
  if (/text\/event-stream/i.test(accept) || /(?:^|\/)api\/ai(?:\/|$)/.test(url.pathname)) {
    return false;
  }
  if (/json/i.test(contentType) || /json/i.test(accept)) return true;

  // 这些启动阶段请求直接通过 fetch 发出，不一定携带 JSON header。
  return /(?:^|\/)api\/(?:auth\/(?:login|refresh|2fa\/verify|register(?:\/config)?)|settings|health|version)\/?$/.test(url.pathname);
}

/**
 * JSON API requests are routed through CapacitorHttp.
 *
 * 上传、二进制附件、下载和流式响应继续使用现有 fetch，避免改变 body/stream
 * 语义。普通 JSON 写请求仍由原有 API 层负责离线队列；这里只替换实际传输通道。
 */
export function shouldUseAndroidNativeHttp(input: FetchInput, init?: FetchInit): boolean {
  if (!isNativeCapacitorRuntime()) return false;

  const method = getRequestMethod(input, init);
  if (!["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(method)) return false;

  const body = getRequestBody(input, init);
  if (body !== undefined && body !== null && typeof body !== "string") {
    return false;
  }

  try {
    const url = new URL(getRequestUrl(input), window.location.href);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    return isJsonApiRequest(input, init, url);
  } catch {
    return false;
  }
}

async function androidNativeFetch(
  input: FetchInput,
  init: FetchInit | undefined,
  timeoutMs: number,
): Promise<Response> {
  const method = getRequestMethod(input, init);
  const signal = getRequestSignal(input, init);
  const url = new URL(getRequestUrl(input), window.location.href).toString();
  const nativeResponse = await withAbortAndTimeout(
    CapacitorHttp.request({
      url,
      method,
      headers: mergeRequestHeaders(input, init),
      data: bodyToNativeData(getRequestBody(input, init)),
      responseType: "text",
    }),
    signal,
    timeoutMs,
  );

  if (nativeResponse.status < 200 || nativeResponse.status > 599) {
    throw new Error(`Native HTTP returned invalid status: ${nativeResponse.status}`);
  }

  const headers = normalizeResponseHeaders(nativeResponse.headers);
  const body = method === "HEAD"
    || nativeResponse.status === 204
    || nativeResponse.status === 205
    || nativeResponse.status === 304
    ? null
    : nativeResponseBody(nativeResponse.data);

  if (body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  return new Response(body, {
    status: nativeResponse.status,
    headers,
  });
}

/**
 * Installs a narrow fetch bridge before React mounts.
 *
 * Native WebView requests can remain pending on cellular networks when CORS,
 * DNS or IPv6 negotiation is unhealthy. JSON API requests therefore
 * use CapacitorHttp first (which is not constrained by WebView CORS). Read
 * requests may fall back to the original fetch; writes never retry through a
 * second transport, preventing duplicate mutations after an ambiguous timeout.
 */
export function installAndroidNativeHttpBridge(
  options: AndroidNativeHttpBridgeOptions = {},
): (() => void) | null {
  if (typeof window === "undefined" || !isNativeCapacitorRuntime()) return null;

  const runtime = window as typeof window & Record<string, unknown>;
  if (runtime[BRIDGE_FLAG]) return null;

  const originalFetch: FetchFn = window.fetch.bind(window);
  const nativeTimeoutMs = Math.max(1000, options.nativeTimeoutMs ?? DEFAULT_NATIVE_TIMEOUT_MS);

  const bridgedFetch: FetchFn = async (input, init) => {
    if (!shouldUseAndroidNativeHttp(input, init)) {
      return originalFetch(input, init);
    }

    try {
      return await androidNativeFetch(input, init, nativeTimeoutMs);
    } catch (nativeError) {
      const signal = getRequestSignal(input, init);
      if (signal?.aborted) throw nativeError;

      // 写请求发出后无法判断服务端是否已经处理，不能再回退重发，避免重复创建/修改。
      const method = getRequestMethod(input, init);
      if (method !== "GET" && method !== "HEAD") throw nativeError;

      console.warn("[native-http] native request failed; falling back to WebView fetch", {
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
