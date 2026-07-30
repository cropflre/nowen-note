/**
 * 记住密码 / 自动登录 —— 跨端凭据持久化。
 * ============================================================================
 *
 * 与快速登录（@/lib/quickLogin）的差异
 * ----------------------------------------------------------------------------
 * quickLogin：生物识别 + token 持久化（Capacitor 独占；用 token verify）
 * rememberLogin：用户名 + 密码 + serverUrl（本模块；PC & 手机都可用；直接走登录接口）
 *
 * 两者并不冲突：
 *   - 若设备已启用快速登录，AuthGate 会先走快速登录；
 *   - 快速登录不可用 / 失败时，LoginPage 会根据本模块的"自动登录"配置决定
 *     是否自动填入并提交。
 *
 * 存储后端（按平台自动选择）
 * ----------------------------------------------------------------------------
 * - Capacitor Native (Android/iOS)：@aparajita/capacitor-secure-storage（Keystore/Keychain）
 * - Electron Desktop：走 IPC 走主进程 safeStorage（DPAPI / Keychain / libsecret）
 * - Web：localStorage（仅保存用户名 + serverUrl，不保存密码；autoLogin 失效）
 *
 * 数据结构
 * ----------------------------------------------------------------------------
 * {
 *   serverUrl: string,
 *   username: string,
 *   password: string,   // 可能为空（未支持加密 / 用户只勾"记住用户名"）
 *   autoLogin: boolean,
 * }
 *
 * 失效清理
 * ----------------------------------------------------------------------------
 * - 用户取消“记住账号和密码”或主动清除配置 → 调 clearRememberedCredentials()
 * - Electron 端"清除服务器"也会触发主进程级 clear
 */

import { Capacitor } from "@capacitor/core";

// ============================================================================
// 类型
// ============================================================================

export interface RememberedCredentials {
  serverUrl: string;
  username: string;
  password: string;
  /** 是否自动登录（开关态，独立于 hasPassword） */
  autoLogin: boolean;
  /** 仅表示"本次读取拿到了真实密码"，Web 端永远 false */
  hasPassword: boolean;
}

export interface SaveRememberedParams {
  /** 勾选了"记住密码"时传 true；false = 等同 clear */
  remember: boolean;
  /** 勾选了"自动登录" */
  autoLogin: boolean;
  serverUrl: string;
  username: string;
  password: string;
}

// ============================================================================
// 平台探测
// ============================================================================

function isCapacitorNative(): boolean {
  try {
    return !!Capacitor?.isNativePlatform?.();
  } catch {
    return false;
  }
}

function getDesktopApi(): any {
  try {
    const nd = (window as any).nowenDesktop;
    if (nd && nd.credentials && typeof nd.credentials.load === "function") {
      return nd.credentials;
    }
  } catch {
    /* ignore */
  }
  return null;
}

// ============================================================================
// Capacitor SecureStorage 加载（dynamic import，Web/Electron 不会打进首屏）
// ============================================================================

type SecureStorageModule =
  typeof import("@aparajita/capacitor-secure-storage");

let ssModPromise: Promise<SecureStorageModule | null> | null = null;
async function loadSecureStorage(): Promise<SecureStorageModule | null> {
  if (!isCapacitorNative()) return null;
  if (ssModPromise) return ssModPromise;
  ssModPromise = (async () => {
    try {
      const mod = await import(
        /* @vite-ignore */ "@aparajita/capacitor-secure-storage"
      );
      // 使用独立的前缀，避免与 quickLogin 共用命名空间
      try {
        await mod.SecureStorage.setKeyPrefix("nowen_");
      } catch {
        /* ignore */
      }
      return mod;
    } catch (e) {
      console.warn("[rememberLogin] secure-storage load failed:", e);
      return null;
    }
  })();
  return ssModPromise;
}

const SS_KEY = "rememberLogin.v1";
const LS_KEY = "nowen-remember-login-v1";

// ============================================================================
// 对外 API
// ============================================================================

/**
 * 当前环境是否能"安全保存密码"（需要加密）。
 * - Capacitor 原生：true
 * - Electron：看主进程 safeStorage.isEncryptionAvailable()
 * - Web：false（不落密码）
 */
export async function canPersistPassword(): Promise<boolean> {
  if (isCapacitorNative()) return true;
  const desktop = getDesktopApi();
  if (desktop) {
    try {
      return !!(await desktop.isEncryptionAvailable());
    } catch {
      return false;
    }
  }
  return false;
}

/** 读取已保存的凭据。永远不抛。 */
export async function loadRememberedCredentials(): Promise<RememberedCredentials | null> {
  try {
    // ---- Electron ----
    const desktop = getDesktopApi();
    if (desktop) {
      const r = await desktop.load();
      if (!r) return null;
      return {
        serverUrl: r.serverUrl || "",
        username: r.username || "",
        password: r.password || "",
        autoLogin: !!r.autoLogin,
        hasPassword: !!r.hasPassword,
      };
    }

    // ---- Capacitor ----
    if (isCapacitorNative()) {
      const mod = await loadSecureStorage();
      if (!mod) return null;
      const raw = await mod.SecureStorage.get(SS_KEY);
      if (typeof raw !== "string" || !raw) return null;
      let obj: any;
      try {
        obj = JSON.parse(raw);
      } catch {
        return null;
      }
      const pwd = typeof obj.password === "string" ? obj.password : "";
      return {
        serverUrl: String(obj.serverUrl || ""),
        username: String(obj.username || ""),
        password: pwd,
        autoLogin: !!obj.autoLogin,
        hasPassword: !!pwd,
      };
    }

    // ---- Web（只保存非敏感字段） ----
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    return {
      serverUrl: String(obj.serverUrl || ""),
      username: String(obj.username || ""),
      password: "",
      autoLogin: false,
      hasPassword: false,
    };
  } catch (e) {
    console.warn("[rememberLogin] load failed:", e);
    return null;
  }
}

/**
 * 保存 / 更新凭据。
 * remember=false 视同 clear。
 */
export async function saveRememberedCredentials(
  params: SaveRememberedParams,
): Promise<{ ok: boolean; encrypted: boolean; error?: string }> {
  if (!params.remember) {
    await clearRememberedCredentials();
    return { ok: true, encrypted: false };
  }
  try {
    // ---- Electron ----
    const desktop = getDesktopApi();
    if (desktop) {
      const r = await desktop.save({
        remember: true,
        autoLogin: !!params.autoLogin,
        serverUrl: params.serverUrl || "",
        username: params.username || "",
        password: params.password || "",
      });
      return {
        ok: !!r?.ok,
        encrypted: !!r?.encrypted,
        error: r?.error,
      };
    }

    // ---- Capacitor ----
    if (isCapacitorNative()) {
      const mod = await loadSecureStorage();
      if (!mod) return { ok: false, encrypted: false, error: "SecureStorage 不可用" };
      const payload = {
        serverUrl: params.serverUrl || "",
        username: params.username || "",
        password: params.password || "",
        autoLogin: !!params.autoLogin,
        savedAt: Date.now(),
      };
      await mod.SecureStorage.set(SS_KEY, JSON.stringify(payload));
      return { ok: true, encrypted: true };
    }

    // ---- Web：只存用户名+serverUrl；密码不落盘；autoLogin 强制 false ----
    const payload = {
      serverUrl: params.serverUrl || "",
      username: params.username || "",
      // 故意不存 password
      autoLogin: false,
    };
    localStorage.setItem(LS_KEY, JSON.stringify(payload));
    return { ok: true, encrypted: false };
  } catch (e: any) {
    console.warn("[rememberLogin] save failed:", e);
    return { ok: false, encrypted: false, error: e?.message || String(e) };
  }
}

/** 清空所有保存的凭据。 */
export async function clearRememberedCredentials(): Promise<void> {
  try {
    const desktop = getDesktopApi();
    if (desktop) {
      try { await desktop.clear(); } catch { /* ignore */ }
    }
    if (isCapacitorNative()) {
      const mod = await loadSecureStorage();
      if (mod) {
        try { await mod.SecureStorage.remove(SS_KEY); } catch { /* ignore */ }
      }
    }
    try { localStorage.removeItem(LS_KEY); } catch { /* ignore */ }
  } catch (e) {
    console.warn("[rememberLogin] clear failed:", e);
  }
}
