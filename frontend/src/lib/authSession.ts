import { getOfflineQueueStorageKey } from "./offlineScope";
import { shouldRetainNativeOfflineSession, MOBILE_SYNC_AUTH_REQUIRED_EVENT } from './nativeOfflineSession';

const ACCESS_TOKEN_KEY = "nowen-token";
const REFRESH_TOKEN_KEY = "nowen-refresh-token";

const refreshInFlight = new Map<string, Promise<string>>();

export function getAccessToken(): string | null {
  try { return localStorage.getItem(ACCESS_TOKEN_KEY); } catch { return null; }
}

export function getRefreshToken(): string | null {
  try { return localStorage.getItem(REFRESH_TOKEN_KEY); } catch { return null; }
}

export function storeAuthTokens(tokens: { token: string; refreshToken?: string | null }): void {
  try {
    localStorage.setItem(ACCESS_TOKEN_KEY, tokens.token);
    if (tokens.refreshToken) localStorage.setItem(REFRESH_TOKEN_KEY, tokens.refreshToken);
    else if (tokens.refreshToken === null) localStorage.removeItem(REFRESH_TOKEN_KEY);
    window.dispatchEvent(new CustomEvent("nowen:token-changed", {
      detail: { authenticated: true },
    }));
  } catch {
    // localStorage 不可用时沿用调用方现有的登录失败处理。
  }
}

export function clearAuthTokens(): void {
  try {
    localStorage.removeItem(ACCESS_TOKEN_KEY);
    localStorage.removeItem(REFRESH_TOKEN_KEY);
  } catch {
    // ignore
  }
  try {
    window.dispatchEvent(new CustomEvent("nowen:token-changed", {
      detail: { authenticated: false },
    }));
  } catch {
    // 非浏览器运行时无需派发。
  }
}

class RefreshUnavailableError extends Error {
  constructor() {
    super("暂时无法续期登录状态");
    this.name = "RefreshUnavailableError";
  }
}

async function requestNewAccessToken(apiBaseUrl: string, refreshToken: string): Promise<string> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new RefreshUnavailableError());
    }, 8000);
  });
  // Bound both headers and body reads, even if a remote WebView ignores abort.
  // Only the race result may reach token persistence; a late response is discarded.
  try {
    return await Promise.race([readNewAccessToken(apiBaseUrl, refreshToken, controller.signal), timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

async function readNewAccessToken(apiBaseUrl: string, refreshToken: string, signal: AbortSignal): Promise<string> {
  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl}/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
      signal,
    });
  } catch {
    throw new RefreshUnavailableError();
  }

  if (!response.ok) {
    if (response.status >= 500 || response.status === 408 || response.status === 429) {
      throw new RefreshUnavailableError();
    }
    const body = await response.json().catch(() => ({})) as {code?: string};
    const error = new Error("登录续期失败") as Error & { terminal?: boolean; code?: string };
    error.terminal = true;
    error.code = body.code;
    throw error;
  }

  const payload = await response.json().catch(() => ({})) as { token?: string };
  if (!payload.token) throw new RefreshUnavailableError();
  return payload.token;
}

export async function refreshAccessToken(
  apiBaseUrl: string,
  options?: { refreshToken?: string | null; persist?: boolean },
): Promise<string | null> {
  const accountScope = getOfflineQueueStorageKey();
  const refreshToken = options?.refreshToken ?? getRefreshToken();
  if (!refreshToken) return null;
  const refreshKey = `${apiBaseUrl}\n${refreshToken}`;

  let pending = refreshInFlight.get(refreshKey);
  if (!pending) {
    pending = requestNewAccessToken(apiBaseUrl, refreshToken)
      .finally(() => {
        refreshInFlight.delete(refreshKey);
      });
    refreshInFlight.set(refreshKey, pending);
  }

  try {
    const token = await pending;
    if (options?.persist !== false && getOfflineQueueStorageKey() === accountScope && getRefreshToken() === refreshToken) storeAuthTokens({ token });
    return token;
  } catch (error) {
    if ((error as { terminal?: boolean })?.terminal && options?.persist !== false
      && getOfflineQueueStorageKey() === accountScope && getRefreshToken() === refreshToken) {
      if (shouldRetainNativeOfflineSession((error as {code?: string}).code, getAccessToken())) {
        window.dispatchEvent(new Event(MOBILE_SYNC_AUTH_REQUIRED_EVENT));
      } else clearAuthTokens();
    }
    throw error;
  }
}

function withBearer(init: RequestInit | undefined, token: string): RequestInit {
  const headers = new Headers(init?.headers || {});
  headers.set("Authorization", `Bearer ${token}`);
  return { ...init, headers };
}

export async function fetchWithAuthRefresh(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  apiBaseUrl: string,
  fetchImpl: typeof globalThis.fetch = fetch,
): Promise<Response> {
  const accountScope = getOfflineQueueStorageKey();
  const initialHeaders = new Headers(init?.headers || {});
  const usesLoginToken = initialHeaders.has("Authorization");
  const requestToken = getAccessToken();
  const first = await fetchImpl(input, usesLoginToken && requestToken ? withBearer(init, requestToken) : init);
  if (first.status !== 401 || !usesLoginToken || !requestToken) return first;

  // A response belonging to the previous account must never replay its body
  // under a newly signed-in account (including note creation and AI requests).
  if (getOfflineQueueStorageKey() !== accountScope) return first;
  const latestToken = getAccessToken();
  if (latestToken && latestToken !== requestToken) {
    return fetchImpl(input, withBearer(init, latestToken));
  }

  let refreshed: string | null;
  try {
    refreshed = await refreshAccessToken(apiBaseUrl);
  } catch (error) {
    if (error instanceof RefreshUnavailableError) throw error;
    return first;
  }
  if (!refreshed || getOfflineQueueStorageKey() !== accountScope) return first;
  return fetchImpl(input, withBearer(init, refreshed));
}
