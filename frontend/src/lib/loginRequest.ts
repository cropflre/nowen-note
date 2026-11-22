import { discoverNowenApiPath } from "@/lib/api";
import { safeLoginRequestTarget } from "@/lib/loginRequestDiagnostics";
import { getResolvedApiBaseUrl } from "@/lib/serverUrl";
import type { User } from "@/types";

type JsonObject = Record<string, unknown>;

export const LOGIN_RETRY_DELAY_MS = 300;
export const LOGIN_ATTEMPT_TIMEOUT_MS = 15_000;

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs?: number): Promise<Response> {
  if (!timeoutMs) return fetch(url, init);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 登录、两步验证这类请求没有拿到任何 HTTP 响应时，自动补发一次。
 *
 * Android 客户端经原生 HTTP 发 POST，偶尔第一次就直接失败、没有任何响应（例如复用了
 * 已被网络中途断开的连接），用户再点一次就能登录。登录可以安全重放，所以这里替用户
 * 补发一次。服务端返回的任何 HTTP 状态（含 4xx/5xx）都原样交给调用方，不会重试。
 * init.body 必须可重复发送（字符串）。timeoutMs 对每次发送单独计时。
 */
export async function fetchLoginRequest(url: string, init: RequestInit, options: { timeoutMs?: number } = {}): Promise<Response> {
  try {
    return await fetchWithTimeout(url, init, options.timeoutMs);
  } catch (error) {
    console.warn("[login] no HTTP response, retrying once:", error instanceof Error ? error.name : "unknown");
    await new Promise((resolve) => setTimeout(resolve, LOGIN_RETRY_DELAY_MS));
    return fetchWithTimeout(url, init, options.timeoutMs);
  }
}

export type PasswordLoginResult =
  | { kind: "success"; token: string; refreshToken?: string; user: User }
  | { kind: "twoFactor"; ticket: string; username?: string }
  /** Nowen 明确返回用户名或密码错误。 */
  | { kind: "invalidCredentials" }
  /** Nowen 明确拒绝（锁定、限流、禁用等），message 为服务端提示。 */
  | { kind: "refused"; code?: string; message?: string }
  /** 入口前的代理网关要求交互验证（跳转、401/403 登录页等）。 */
  | { kind: "gateway" }
  /** 超时、无响应、5xx，或该入口下找不到 Nowen 接口。 */
  | { kind: "unavailable" };

type Inspection =
  | { type: "nowen"; status: number; body: JsonObject }
  | { type: "noResponse" }
  | { type: "gateway" }
  | { type: "notNowen"; gatewayPage: boolean };

function parseJsonObject(text: string): JsonObject | null {
  if (!/^\s*\{/.test(text)) return null;
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function leftRequestOrigin(res: Response, requestUrl: string): boolean {
  if (res.redirected) return true;
  if (!res.url) return false;
  try {
    return new URL(res.url).origin !== new URL(requestUrl, window.location.href).origin;
  } catch {
    return true;
  }
}

async function inspectLoginResponse(res: Response, requestUrl: string): Promise<Inspection> {
  // Nowen 登录接口从不跳转。跳转、代理认证头都说明请求被入口前的网关接管；
  // 不读取也不跟随其内容，避免把凭据交给其他主机。
  if (
    res.type === "opaqueredirect"
    || (res.status >= 300 && res.status < 400)
    || res.status === 407
    || res.headers.has("www-authenticate")
    || leftRequestOrigin(res, requestUrl)
  ) {
    return { type: "gateway" };
  }
  const text = await res.text().catch(() => "");
  const body = parseJsonObject(text);
  if (body) {
    const twoFactor = !!(body.requires2FA || body.requiresTwoFactor || body.twoFactorRequired) && typeof body.ticket === "string";
    const session = typeof body.token === "string" && !!body.user && typeof body.user === "object";
    if (res.ok ? twoFactor || session : typeof body.error === "string") {
      return { type: "nowen", status: res.status, body };
    }
  }
  return {
    type: "notNowen",
    gatewayPage: res.status === 401 || res.status === 403 || /<input[^>]*type\s*=\s*["']?password/i.test(text),
  };
}

function toResult(status: number, body: JsonObject): PasswordLoginResult {
  if (status >= 200 && status < 300) {
    if (typeof body.ticket === "string" && (body.requires2FA || body.requiresTwoFactor || body.twoFactorRequired)) {
      return { kind: "twoFactor", ticket: body.ticket, username: typeof body.username === "string" ? body.username : undefined };
    }
    return {
      kind: "success",
      token: body.token as string,
      refreshToken: typeof body.refreshToken === "string" ? body.refreshToken : undefined,
      user: body.user as User,
    };
  }
  if (status === 401) return { kind: "invalidCredentials" };
  if (status >= 500) return { kind: "unavailable" };
  return {
    kind: "refused",
    code: typeof body.code === "string" ? body.code : undefined,
    message: typeof body.error === "string" ? body.error : undefined,
  };
}

/**
 * 用户名密码登录，以实际登录响应决定结果，不先做健康检查或 WebSocket 探测。
 *
 * 1. 先用已缓存的可用 API 路径（没有则为标准 /api）提交；
 * 2. 只有拿到非 Nowen 的响应（404、代理页面、跳转）时，才在同一入口下做无凭据探测，
 *    找到 /public/api、/publicapi 等兼容路径后再提交一次；
 * 3. 已识别的 Nowen 响应（成功、两步验证、密码错误、锁定、限流）直接返回，不重复提交密码。
 */
export async function submitPasswordLogin(options: {
  serverUrl: string;
  credentials: { username: string; password: string; deviceId: string };
  /** 客户端在未收到 HTTP 响应时补发一次；网页端同源请求不补发。 */
  retryWithoutResponse: boolean;
}): Promise<PasswordLoginResult> {
  const init: RequestInit = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(options.credentials),
    redirect: "manual",
  };

  const post = async (apiBaseUrl: string): Promise<Inspection> => {
    const url = `${apiBaseUrl}/auth/login`;
    let res: Response;
    try {
      res = options.retryWithoutResponse
        ? await fetchLoginRequest(url, init, { timeoutMs: LOGIN_ATTEMPT_TIMEOUT_MS })
        : await fetchWithTimeout(url, init, LOGIN_ATTEMPT_TIMEOUT_MS);
    } catch (error) {
      console.warn("[login] no HTTP response", { target: safeLoginRequestTarget(url), error: error instanceof Error ? error.name : "unknown" });
      return { type: "noResponse" };
    }
    const inspection = await inspectLoginResponse(res, url);
    if (inspection.type !== "nowen") {
      console.warn("[login] response is not from Nowen", { target: safeLoginRequestTarget(url), status: res.status, type: inspection.type });
    }
    return inspection;
  };

  const firstApiBaseUrl = getResolvedApiBaseUrl(options.serverUrl);
  const first = await post(firstApiBaseUrl);
  if (first.type === "nowen") return toResult(first.status, first.body);
  if (first.type === "noResponse") return { kind: "unavailable" };

  const discovered = await discoverNowenApiPath(options.serverUrl, firstApiBaseUrl).catch(() => null);
  if (discovered) {
    const second = await post(discovered.apiBaseUrl);
    if (second.type === "nowen") return toResult(second.status, second.body);
  }
  const gateway = first.type === "gateway" || first.gatewayPage;
  return gateway ? { kind: "gateway" } : { kind: "unavailable" };
}
