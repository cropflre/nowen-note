import { setServerUrl } from "@/lib/api";
import {
  type AccountLoginHistoryItem,
  CURRENT_ACCOUNT_HISTORY_ID_KEY,
  loadAccountLoginToken,
  markAccountLoginRequiresReauth,
  saveAccountLoginHistory,
  setPendingAccountReauth,
} from "@/lib/accountLoginHistory";

export type AccountLoginSwitchResult =
  | { status: "switched" }
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

export async function switchAccountLogin(account: AccountLoginHistoryItem): Promise<AccountLoginSwitchResult> {
  const loaded = await loadAccountLoginToken(account.id);
  if (!loaded.ok || !loaded.token) {
    if (loaded.error === "TOKEN_UNAVAILABLE") return prepareReauth(account);
    return { status: "storage_error" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(`${account.serverUrl}/api/auth/verify`, {
      headers: { Authorization: `Bearer ${loaded.token}` },
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({}));
    const code = typeof body?.code === "string" ? body.code : "";
    if (response.status === 401 || AUTH_INVALID_CODES.has(code)) {
      return prepareReauth(account, body?.error);
    }
    if (!response.ok) {
      return { status: "network_error", message: body?.error || `HTTP ${response.status}` };
    }
    if (!body?.user?.id || !body?.user?.username) {
      return { status: "failed", message: "服务器返回的账号信息不完整" };
    }

    setServerUrl(account.serverUrl);
    localStorage.setItem("nowen-token", loaded.token);
    localStorage.setItem(CURRENT_ACCOUNT_HISTORY_ID_KEY, account.id);
    await saveAccountLoginHistory({
      serverUrl: account.serverUrl,
      token: loaded.token,
      user: body.user,
    });
    try { window.dispatchEvent(new CustomEvent("nowen:token-changed")); } catch { /* ignore */ }
    return { status: "switched" };
  } catch (error: any) {
    return { status: "network_error", message: error?.message || "无法连接目标服务器" };
  } finally {
    clearTimeout(timer);
  }
}
