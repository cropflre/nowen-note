/**
 * 会自动续期的 fetch —— 所有出网请求都必须走它。
 *
 * 背景：服务端 Access Token **只有 15 分钟**，长期登录靠 30 天的 Refresh Token。
 *      @nowen/sdk 在 401 时的处理是「清空 token 再 login()」，
 *      而 Lite 的 SDK 实例没有真实账号密码（占位 `__lite__`）→ 必然失败。
 *      所以必须**在 SDK 看到 401 之前**就把 token 换好。
 *
 * 两道防线：
 *   1. **主动**：请求前看 JWT 的 exp，快过期（< 60s）就先续期 —— 用户完全无感
 *   2. **被动**：真收到 401 时续期并**重放这次请求**（只重放一次，避免死循环）
 *
 * 不处理鉴权类端点（login / 2fa / refresh），否则会自己套自己。
 */
import { getToken, refreshSession, secondsUntilExpiry } from "./auth";

/** 提前多久续期（秒）。留一点余量，避免请求在途时刚好过期。 */
const REFRESH_AHEAD_SECONDS = 60;

const AUTH_PATHS = ["/api/auth/login", "/api/auth/2fa/", "/api/auth/refresh"];

function isAuthPath(input: RequestInfo | URL): boolean {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  return AUTH_PATHS.some((p) => url.includes(p));
}

function withAuthHeader(input: RequestInfo | URL, init: RequestInit | undefined, token: string): RequestInit {
  const headers = new Headers(
    init?.headers ?? (typeof input === "object" && "headers" in input ? input.headers : undefined),
  );
  headers.set("Authorization", `Bearer ${token}`);
  return { ...init, headers };
}

export async function authedFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const authPath = isAuthPath(input);

  // ---- 防线 1：主动续期 ----
  if (!authPath) {
    const left = secondsUntilExpiry();
    if (left !== null && left <= REFRESH_AHEAD_SECONDS) {
      await refreshSession();
    }
  }

  const token = getToken();
  let res = await fetch(input, token && !authPath ? withAuthHeader(input, init, token) : init);

  // ---- 防线 2：401 时续期并重放一次 ----
  if (res.status === 401 && !authPath) {
    const ok = await refreshSession();
    if (ok) {
      const fresh = getToken();
      if (fresh) res = await fetch(input, withAuthHeader(input, init, fresh));
    }
  }

  return res;
}
