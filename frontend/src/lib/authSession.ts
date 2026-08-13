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
  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl}/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    });
  } catch {
    throw new RefreshUnavailableError();
  }

  if (!response.ok) {
    if (response.status >= 500 || response.status === 408 || response.status === 429) {
      throw new RefreshUnavailableError();
    }
    const error = new Error("登录续期失败") as Error & { terminal?: boolean };
    error.terminal = true;
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
    if (options?.persist !== false) storeAuthTokens({ token });
    return token;
  } catch (error) {
    if ((error as { terminal?: boolean })?.terminal && options?.persist !== false) {
      clearAuthTokens();
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
): Promise<Response> {
  const initialHeaders = new Headers(init?.headers || {});
  const usesLoginToken = initialHeaders.has("Authorization");
  const requestToken = getAccessToken();
  const first = await fetch(input, usesLoginToken && requestToken ? withBearer(init, requestToken) : init);
  if (first.status !== 401 || !usesLoginToken || !requestToken) return first;

  const latestToken = getAccessToken();
  if (latestToken && latestToken !== requestToken) {
    return fetch(input, withBearer(init, latestToken));
  }

  let refreshed: string | null;
  try {
    refreshed = await refreshAccessToken(apiBaseUrl);
  } catch (error) {
    if (error instanceof RefreshUnavailableError) throw error;
    return first;
  }
  if (!refreshed) return first;
  return fetch(input, withBearer(init, refreshed));
}
