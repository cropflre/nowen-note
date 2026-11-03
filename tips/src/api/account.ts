/**
 * 账号 / 连接状态检查。
 *
 * ⚠️ 为什么不用 `@nowen/sdk` 的 `verifyToken()`：
 *    SDK 把返回类型声明成 `{ valid, userId, username }`，
 *    但真实服务端返回的是 **`{ user: { id, username, displayName, ... } }`**。
 *    → `info.valid` 恒为 undefined → 恒判「会话已失效」（实际会话好好的）。
 *    这是 SDK 的第 5 个缺陷；这里直接调接口并做归一化，不依赖它。
 *
 * 三种状态必须分开，它们的处置完全不同：
 *   ok      已登录
 *   expired 服务端明确说 token 不认（401）→ 需要重新登录
 *   offline 请求发不出去 / 超时 → **不能**断言会话失效，是网络或服务端的事
 */
import { getServerUrl, getToken } from "../auth/auth";

export type LoginState = "ok" | "expired" | "offline";
export type ServerState = "ok" | "fail";

export interface AccountStatus {
  login: LoginState;
  username?: string;
  displayName?: string;
  server: ServerState;
  /** 服务端返回的版本号（/api/health），有就显示出来 */
  version?: string;
  checkedAt: number;
}

function baseUrl(): string {
  return getServerUrl().replace(/\/+$/, "");
}

/** 单独探服务端可达性（不需要鉴权） */
async function checkServer(): Promise<{ state: ServerState; version?: string }> {
  try {
    const res = await fetch(`${baseUrl()}/api/health`, {
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return { state: "fail" };
    const data = (await res.json()) as { version?: string };
    return { state: "ok", version: data.version };
  } catch {
    return { state: "fail" };
  }
}

/** 查当前登录状态（会顺带探一次服务端可达性） */
export async function checkAccount(): Promise<AccountStatus> {
  const token = getToken();
  const checkedAt = Date.now();

  const [server, login] = await Promise.all([
    checkServer(),
    (async (): Promise<{ state: LoginState; username?: string; displayName?: string }> => {
      if (!token) return { state: "expired" };
      try {
        const res = await fetch(`${baseUrl()}/api/auth/verify`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(10_000),
        });
        if (res.status === 401 || res.status === 403) return { state: "expired" };
        if (!res.ok) return { state: "offline" };
        // 真实结构：{ user: { id, username, displayName } }
        const data = (await res.json()) as {
          user?: { username?: string; displayName?: string | null };
        };
        const user = data.user;
        if (!user) return { state: "offline" };
        return {
          state: "ok",
          username: user.username,
          displayName: user.displayName || undefined,
        };
      } catch {
        return { state: "offline" };
      }
    })(),
  ]);

  return {
    login: login.state,
    username: login.username,
    displayName: login.displayName,
    server: server.state,
    version: server.version,
    checkedAt,
  };
}

/** 给人看的服务端地址（去掉协议头） */
export function displayServer(): string {
  const url = baseUrl();
  return url ? url.replace(/^https?:\/\//, "") : "(当前站点)";
}
