import type { User } from "@/types";

const LOGIN_REQUESTED_KEY = "nowen-mobile-account-login-requested";

export const MOBILE_LOCAL_ACCOUNT_ID = "android-device-local";
export const MOBILE_LOCAL_USER_ID = "android-local-user";
export const MOBILE_LOCAL_MODE_CHANGED_EVENT = "nowen:mobile-local-mode-changed";

export function isAndroidNativeRuntime(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const capacitor = (window as any).Capacitor;
    const native = !!capacitor?.isNativePlatform?.()
      || (!!capacitor?.platform && capacitor.platform !== "web");
    const platform = capacitor?.getPlatform?.() || capacitor?.platform;
    return native && platform === "android";
  } catch {
    return false;
  }
}

function hasAccessToken(): boolean {
  try {
    return !!localStorage.getItem("nowen-token");
  } catch {
    return false;
  }
}

export function isMobileLocalMode(): boolean {
  if (!isAndroidNativeRuntime() || hasAccessToken()) return false;
  try {
    return localStorage.getItem(LOGIN_REQUESTED_KEY) !== "1";
  } catch {
    return true;
  }
}

function notifyModeChanged(): void {
  try { window.dispatchEvent(new Event(MOBILE_LOCAL_MODE_CHANGED_EVENT)); } catch { /* ignore */ }
}

export function requestMobileAccountLogin(): void {
  try { localStorage.setItem(LOGIN_REQUESTED_KEY, "1"); } catch { /* ignore */ }
  notifyModeChanged();
}

export function continueMobileLocalMode(): void {
  try { localStorage.removeItem(LOGIN_REQUESTED_KEY); } catch { /* ignore */ }
  notifyModeChanged();
}

export function completeMobileAccountLogin(): void {
  try { localStorage.removeItem(LOGIN_REQUESTED_KEY); } catch { /* ignore */ }
}

export function getMobileLocalUser(): User {
  return {
    id: MOBILE_LOCAL_USER_ID,
    username: "local",
    displayName: "本地用户",
    email: null,
    avatarUrl: null,
    role: "user",
    createdAt: new Date(0).toISOString(),
  };
}

export class MobileLocalModeRemoteRequestError extends Error {
  readonly code = "MOBILE_LOCAL_ONLY";

  constructor(path: string) {
    super(`Android 本地模式不会访问服务器：${path}`);
    this.name = "MobileLocalModeRemoteRequestError";
  }
}
