/**
 * 认证层（Lite 自己实现）
 *
 * 为什么不用 @nowen/sdk 的登录：SDK 的 login() 是 private 且只吃 username/password，
 * 不支持 2FA；而本服务端账号普遍开着 2FA。
 *
 * ⚠️ 双 Token 机制（这是「老是提示会话失效」的根因）：
 *    服务端的 Access Token **只有 15 分钟**，长期登录态靠 30 天的 Refresh Token。
 *    最初 Lite 只存了 Access Token、从不续期 → 每 15 分钟必掉线。
 *    现在两个都存，并在过期前主动续期（见 authedFetch.ts）。
 *
 * ⚠️ 为什么不用 @aparajita/capacitor-secure-storage：
 *    主项目的 #798 就是「从 async 函数返回插件 Proxy 被当作 thenable」导致启动挂起。
 *    Lite 这里只用 localStorage，简单、可预期、没有原生依赖。
 *
 * 登录两步（契约来自 backend/src/routes/auth.ts）：
 *   1. POST /api/auth/login        → { token, refreshToken } | { requires2FA, ticket, username }
 *   2. POST /api/auth/2fa/verify   → { token, refreshToken }      （ticket 只活 5 分钟）
 */

/**
 * 「记住我」关闭时 → 会话放 sessionStorage，关掉浏览器即退出登录；
 * 打开时 → 放 localStorage，长期有效（配合 30 天 refresh token）。
 *
 * 读取时**两个都查**（localStorage 优先），这样：
 *   · 老会话（一直是 localStorage）不会因为加了这个开关而失效；
 *   · 用户在两种模式间切换也不会互相看不见。
 */
import { ensureScheme } from "../lib/serverAddress";

const SESSION_ONLY_KEY = "nowen-lite.session-only";

const TOKEN_KEY = "nowen-lite.token";
const REFRESH_KEY = "nowen-lite.refresh";
const SERVER_KEY = "nowen-lite.server";
const USER_KEY = "nowen-lite.username";

/** 服务端地址。空字符串 = 与页面同源（开发时由 vite 代理转发到 3002） */
export function getServerUrl(): string {
  try {
    return localStorage.getItem(SERVER_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setServerUrl(url: string): void {
  // ⚠️ 必须补协议：用户手打 `192.168.8.9:3002` 时，浏览器会当相对路径，
  //    解析成 https://localhost/192.168.8.9:3002/api/... → 全部 404。
  const normalized = ensureScheme(url);
  try {
    if (normalized) localStorage.setItem(SERVER_KEY, normalized);
    else localStorage.removeItem(SERVER_KEY);
  } catch {
    /* 隐私模式下忽略 */
  }
}

/** 会话该放哪个 Storage */
function sessionStore(): Storage {
  try {
    return localStorage.getItem(SESSION_ONLY_KEY) === "1" ? sessionStorage : localStorage;
  } catch {
    return localStorage;
  }
}

/** 两个 Storage 都查一遍（localStorage 优先） */
function readSession(key: string): string | null {
  try {
    return localStorage.getItem(key) ?? sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeSession(key: string, value: string | null): void {
  const store = sessionStore();
  const other = store === localStorage ? sessionStorage : localStorage;
  try {
    if (value) store.setItem(key, value);
    else store.removeItem(key);
    // 另一个 Storage 里的同名值必须清掉，否则切换模式后读到的还是旧的
    other.removeItem(key);
  } catch {
    /* 隐私模式 */
  }
}

/** 设置本次会话是否「仅本次浏览器会话」；登录时由「记住我」决定 */
export function setSessionOnly(only: boolean): void {
  try {
    if (only) localStorage.setItem(SESSION_ONLY_KEY, "1");
    else localStorage.removeItem(SESSION_ONLY_KEY);
  } catch {
    /* 隐私模式 */
  }
}

export function isSessionOnly(): boolean {
  try {
    return localStorage.getItem(SESSION_ONLY_KEY) === "1";
  } catch {
    return false;
  }
}

export function getToken(): string | null {
  try {
    return readSession(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function getRefreshToken(): string | null {
  try {
    return readSession(REFRESH_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  writeSession(TOKEN_KEY, token);
}

export function setRefreshToken(token: string | null): void {
  writeSession(REFRESH_KEY, token);
}

/** 一次性写入两个 token（登录/续期都用它，避免只更新一半） */
export function storeTokens(token: string, refreshToken?: string | null): void {
  setToken(token);
  if (refreshToken) setRefreshToken(refreshToken);
}

export function getSavedUsername(): string {
  try {
    return localStorage.getItem(USER_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setSavedUsername(name: string): void {
  try {
    localStorage.setItem(USER_KEY, name);
  } catch {
    /* ignore */
  }
}

export function clearSession(): void {
  setToken(null);
  setRefreshToken(null);
}

// ============================================================
// Access Token 过期判断
// ============================================================

/**
 * 解析 JWT 的 exp（本地解码 payload，不校验签名 —— 只用来判断「该续期了」）。
 * 返回秒级时间戳；解析不出来返回 null。
 */
export function getTokenExpiry(token: string | null): number | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
    const payload = JSON.parse(atob(padded)) as { exp?: number };
    return typeof payload.exp === "number" ? payload.exp : null;
  } catch {
    return null;
  }
}

/** 距离过期还有多少秒；未知返回 null */
export function secondsUntilExpiry(token: string | null = getToken()): number | null {
  const exp = getTokenExpiry(token);
  if (exp === null) return null;
  return exp - Math.floor(Date.now() / 1000);
}

// ============================================================
// 登录 / 续期
// ============================================================

export type LoginOutcome =
  | { kind: "ok"; token: string; refreshToken: string | null }
  | { kind: "2fa"; ticket: string; username: string };

export async function login(
  baseUrl: string,
  username: string,
  password: string,
): Promise<LoginOutcome> {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
    signal: AbortSignal.timeout(20_000),
  });

  if (!res.ok) throw new Error(await readError(res, "登录失败"));

  const data = (await res.json()) as {
    token?: string;
    refreshToken?: string;
    requires2FA?: boolean;
    ticket?: string;
    username?: string;
  };

  if (data.requires2FA) {
    if (!data.ticket) throw new Error("服务端要求两步验证，但未返回票据");
    return { kind: "2fa", ticket: data.ticket, username: data.username || username };
  }
  if (!data.token) throw new Error("服务端未返回登录令牌");
  return { kind: "ok", token: data.token, refreshToken: data.refreshToken ?? null };
}

export async function verify2fa(
  baseUrl: string,
  ticket: string,
  code: string,
): Promise<{ token: string; refreshToken: string | null }> {
  const res = await fetch(`${baseUrl}/api/auth/2fa/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ticket, code }),
    signal: AbortSignal.timeout(20_000),
  });

  if (!res.ok) throw new Error(await readError(res, "验证码校验失败"));

  const data = (await res.json()) as { token?: string; refreshToken?: string };
  if (!data.token) throw new Error("验证通过但未返回登录令牌");
  return { token: data.token, refreshToken: data.refreshToken ?? null };
}

/**
 * 用 Refresh Token 换新的 Access Token。
 *
 * 单飞（single-flight）：并发的多个请求同时发现过期时，只发一次 refresh，
 * 其余等同一个 Promise —— 否则会打出一串 refresh 请求，还可能互相覆盖 token。
 */
let refreshInFlight: Promise<boolean> | null = null;

export function refreshSession(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    const refreshToken = getRefreshToken();
    if (!refreshToken) return false;
    try {
      const res = await fetch(`${getServerUrl()}/api/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) {
        // Refresh Token 也过期/失效了 → 清干净，让用户重新登录
        if (res.status === 401 || res.status === 403) clearSession();
        return false;
      }
      const data = (await res.json()) as { token?: string; refreshToken?: string };
      if (!data.token) return false;
      storeTokens(data.token, data.refreshToken ?? null);
      return true;
    } catch {
      // 网络问题：不清 session（可能只是暂时断网），下次再试
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

/** 校验当前 token 是否还有效 */
export async function verifyToken(
  baseUrl: string,
  token: string,
): Promise<{ valid: boolean; username?: string }> {
  try {
    const res = await fetch(`${baseUrl}/api/auth/verify`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { valid: false };
    const data = (await res.json()) as { valid?: boolean; username?: string };
    return { valid: data.valid !== false, username: data.username };
  } catch {
    return { valid: false };
  }
}

async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const text = await res.text();
    if (!text) return `${fallback}（HTTP ${res.status}）`;
    try {
      const parsed = JSON.parse(text) as { error?: string; message?: string };
      return parsed.error || parsed.message || `${fallback}（HTTP ${res.status}）`;
    } catch {
      return `${fallback}（HTTP ${res.status}）`;
    }
  } catch {
    return `${fallback}（HTTP ${res.status}）`;
  }
}
