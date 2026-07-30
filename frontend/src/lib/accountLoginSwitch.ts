import { setServerUrl } from "@/lib/api";
import { getDeviceId } from "@/lib/deviceId";
import { loadRememberedCredentials } from "@/lib/rememberLogin";
import type { User } from "@/types";
import {
  type AccountLoginHistoryItem,
  CURRENT_ACCOUNT_HISTORY_ID_KEY,
  loadAccountLoginToken,
  markAccountLoginRequiresReauth,
  saveAccountLoginHistory,
  setPendingAccountReauth,
} from "@/lib/accountLoginHistory";

export type AccountLoginSwitchResult =
  | { status: "switched"; token: string; user: User }
  | { status: "requires_reauth"; message?: string }
  | { status: "network_error"; message?: string }
  | { status: "storage_error" }
  | { status: "failed"; message?: string };

const AUTH_INVALID_CODES = new Set([
  "ACCOUNT_DISABLED",
  "TOKEN_REVOKED",
  "USER_NOT_FOUND",
  "TOKEN_INVALID",
  "SESSION_REVOKED",
  "UNAUTHENTICATED",
]);

async function prepareReauth(account: AccountLoginHistoryItem, message?: string): Promise<AccountLoginSwitchResult> {
  await markAccountLoginRequiresReauth(account.id);
  setPendingAccountReauth({ id: account.id, serverUrl: account.serverUrl, username: account.username });
  setServerUrl(account.serverUrl);
  localStorage.removeItem("nowen-token");
  if ((window as any).nowenDesktop?.isDesktop) {
    // 防止刷新到登录页时 Electron full 模式重新注入本地账号，覆盖目标服务器。
    localStorage.setItem("nowen-prefer-cloud", "1");
  }
  try { window.dispatchEvent(new CustomEvent("nowen:token-changed")); } catch { /* ignore */ }
  return { status: "requires_reauth", message };
}

async function commitSwitch(
  account: AccountLoginHistoryItem,
  token: string,
  user: User,
): Promise<AccountLoginSwitchResult> {
  setServerUrl(account.serverUrl);
  localStorage.setItem("nowen-token", token);
  localStorage.setItem(CURRENT_ACCOUNT_HISTORY_ID_KEY, account.id);
  await saveAccountLoginHistory({ serverUrl: account.serverUrl, token, user });
  try { window.dispatchEvent(new CustomEvent("nowen:token-changed")); } catch { /* ignore */ }
  return { status: "switched", token, user };
}

async function retryWithRememberedPassword(
  account: AccountLoginHistoryItem,
  invalidMessage?: string,
): Promise<AccountLoginSwitchResult> {
  const saved = await loadRememberedCredentials().catch(() => null);
  const sameServer = saved?.serverUrl.replace(/\/+$/, "").toLowerCase()
    === account.serverUrl.replace(/\/+$/, "").toLowerCase();
  if (!saved?.hasPassword || !saved.password || !sameServer || saved.username !== account.username) {
    return prepareReauth(account, invalidMessage);
  }

  try {
    const response = await fetch(`${account.serverUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: saved.username,
        password: saved.password,
        deviceId: getDeviceId(),
      }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body?.token || !body?.user?.id || !body?.user?.username) {
      return prepareReauth(account, body?.error || invalidMessage);
    }
    return commitSwitch(account, body.token, body.user as User);
  } catch (error: any) {
    return { status: "network_error", message: error?.message || "无法连接目标服务器" };
  }
}

export async function switchAccountLogin(account: AccountLoginHistoryItem): Promise<AccountLoginSwitchResult> {
  const loaded = await loadAccountLoginToken(account.id);
  if (!loaded.ok || !loaded.token) {
    if (loaded.error === "TOKEN_UNAVAILABLE") return retryWithRememberedPassword(account);
    return { status: "storage_error" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    // /api/me 经过全局 JWT + session 中间件，会正确拒绝已被下线的 jti。
    // /api/auth/verify 在旧服务端只校验 JWT 签名，会把已撤销会话误判为有效。
    const response = await fetch(`${account.serverUrl}/api/me`, {
      headers: { Authorization: `Bearer ${loaded.token}` },
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({}));
    const code = typeof body?.code === "string" ? body.code : "";
    if (response.status === 401 || AUTH_INVALID_CODES.has(code)) {
      return retryWithRememberedPassword(account, body?.error);
    }
    if (!response.ok) {
      return { status: "network_error", message: body?.error || `HTTP ${response.status}` };
    }
    if (!body?.id || !body?.username) {
      return { status: "failed", message: "服务器返回的账号信息不完整" };
    }
    return commitSwitch(account, loaded.token, body as User);
  } catch (error: any) {
    return { status: "network_error", message: error?.message || "无法连接目标服务器" };
  } finally {
    clearTimeout(timer);
  }
}
