/**
 * 快速登录（生物识别 + Keystore 持久化 token）
 * ============================================================================
 *
 * 设计目标
 * ----------------------------------------------------------------------------
 * 1. 用户在客户端模式（Capacitor / Electron）首次密码登录后，可一键启用
 *    "快速登录"——下次开 app 时通过指纹 / 人脸 / 设备 PIN 即可解锁本地保存
 *    的 token，跳过用户名密码输入。
 * 2. token 存放在 Android Keystore / iOS Keychain（@aparajita/capacitor-secure-storage），
 *    Web / Electron 端降级为不可用（不在 localStorage 落第二份）。
 * 3. 启动时 token 取出后仍走 /me 校验，过期 / 改密 / 被踢都能正确
 *    回退到密码登录。
 *
 * 与现有体系的关系
 * ----------------------------------------------------------------------------
 * - 普通 token 仍存 localStorage["nowen-token"]（项目其它地方依赖它）。
 *   "快速登录"做的是把同一份 token 镜像保存到 Keystore，并加一道生物识别门。
 * - 启用前提：必须能拿到一个有效的 token（即用户刚密码登录成功）。
 * - 不启用 / 启用后又被关闭：完全等同于现状，零回归风险。
 *
 * Web / Electron / Capacitor 三态
 * ----------------------------------------------------------------------------
 * - Capacitor 原生（Android / iOS）：完整可用。
 * - Web / Electron：isAvailable()=false，UI 不显示开关，启动时也不会唤起。
 *   secure-storage 在 Web 下会降级到 localStorage（明文），我们不让它发生
 *   ——直接用 isNativePlatform() 拒绝即可。
 *
 * 失效与吊销
 * ----------------------------------------------------------------------------
 * - 用户主动登出 / 多 tab 广播登出：disable() 一并清掉 Keystore 镜像。
 * - 启动唤起后 verify 失败：disable() 清掉 Keystore，回登录页。
 * - 用户在系统里删除了所有指纹 / 关掉锁屏：authenticate 会抛
 *   biometryNotEnrolled / passcodeNotSet，UI 提示并回退到密码登录。
 */

import { Capacitor } from "@capacitor/core";

// 用 dynamic import 加载插件，避免 Web 构建时把原生插件硬塞进首屏 chunk。
// 但同时插件包必须列在 dependencies，否则 Vite 解析不到模块。
type SecureStorageModule =
  typeof import("@aparajita/capacitor-secure-storage");
type BiometricModule = typeof import("@aparajita/capacitor-biometric-auth");

// ============================================================================
// 常量
// ============================================================================

/** Secure storage 中保存 token 的 key（用专属前缀避免与其他业务冲突） */
const SS_TOKEN_KEY = "nowen.quickLogin.token";
const SS_REFRESH_TOKEN_KEY = "nowen.quickLogin.refreshToken";
/** Secure storage 中保存"开关已开"标记的 key */
const SS_ENABLED_KEY = "nowen.quickLogin.enabled";
/** Secure storage 中保存关联的服务器 URL（防止换服务器后用旧 token 串台） */
const SS_SERVER_URL_KEY = "nowen.quickLogin.serverUrl";
/** Secure storage 中保存关联的用户名（仅展示用） */
const SS_USERNAME_KEY = "nowen.quickLogin.username";
/** localStorage 中保存"已询问过用户是否启用"的标记，避免反复打扰 */
const LS_ENROLL_ASKED_KEY = "nowen-quickLogin-asked";

// ============================================================================
// 平台 / 插件加载
// ============================================================================

let secureStorageModPromise: Promise<SecureStorageModule | null> | null = null;
let biometricModPromise: Promise<BiometricModule | null> | null = null;

function isCapacitorNative(): boolean {
  try {
    return !!Capacitor?.isNativePlatform?.();
  } catch {
    return false;
  }
}

async function loadSecureStorage(): Promise<SecureStorageModule | null> {
  if (!isCapacitorNative()) return null;
  if (secureStorageModPromise) return secureStorageModPromise;
  secureStorageModPromise = (async () => {
    try {
      // @vite-ignore：包真实存在于 node_modules，但 Vite 不需要做依赖预构建优化
      const mod = await import(
        /* @vite-ignore */ "@aparajita/capacitor-secure-storage"
      );
      // 设置一个项目专属 prefix，避免和其它库冲突
      try {
        await mod.SecureStorage.setKeyPrefix("nowen_");
      } catch {
        /* 不致命 */
      }
      return mod;
    } catch (e) {
      console.warn("[quickLogin] secure-storage load failed:", e);
      return null;
    }
  })();
  return secureStorageModPromise;
}

async function loadBiometric(): Promise<BiometricModule | null> {
  if (!isCapacitorNative()) return null;
  if (biometricModPromise) return biometricModPromise;
  biometricModPromise = (async () => {
    try {
      const mod = await import(
        /* @vite-ignore */ "@aparajita/capacitor-biometric-auth"
      );
      return mod;
    } catch (e) {
      console.warn("[quickLogin] biometric-auth load failed:", e);
      return null;
    }
  })();
  return biometricModPromise;
}

// ============================================================================
// 公共 API
// ============================================================================

export interface BiometryStatus {
  /** 系统是否可用生物识别（已录入指纹 / 人脸） */
  available: boolean;
  /** 设备是否设置了锁屏 PIN / 密码（用于"用设备凭据兜底"判断） */
  deviceSecure: boolean;
  /** 主要生物识别类型，仅用于 UI 文案 */
  type?: string;
  /** 不可用时系统给出的原因 */
  reason?: string;
}

/** 当前运行环境是否能用快速登录（先决条件）。Web / Electron 永远 false。 */
export function isQuickLoginPlatformSupported(): boolean {
  return isCapacitorNative();
}

/** 探测设备的生物识别状态。不抛错，失败返回 available=false。 */
export async function checkBiometry(): Promise<BiometryStatus> {
  const mod = await loadBiometric();
  if (!mod) return { available: false, deviceSecure: false };
  try {
    const r = await mod.BiometricAuth.checkBiometry();
    return {
      available: !!r.isAvailable,
      deviceSecure: !!r.deviceIsSecure,
      type: String(r.biometryType ?? ""),
      reason: r.reason,
    };
  } catch (e) {
    console.warn("[quickLogin] checkBiometry failed:", e);
    return { available: false, deviceSecure: false };
  }
}

/** 当前账号是否已开启快速登录（持久态，跨启动有效） */
export async function isQuickLoginEnabled(): Promise<boolean> {
  const mod = await loadSecureStorage();
  if (!mod) return false;
  try {
    const flag = await mod.SecureStorage.get(SS_ENABLED_KEY);
    return flag === true || flag === "true" || flag === 1 || flag === "1";
  } catch {
    return false;
  }
}

/** 已启用快速登录时所绑定的服务器地址（用于 UI 展示 / 启动校验是否换了服务器） */
export async function getQuickLoginServerUrl(): Promise<string | null> {
  const mod = await loadSecureStorage();
  if (!mod) return null;
  try {
    const v = await mod.SecureStorage.get(SS_SERVER_URL_KEY);
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

/** 已启用快速登录时所绑定的用户名（仅展示） */
export async function getQuickLoginUsername(): Promise<string | null> {
  const mod = await loadSecureStorage();
  if (!mod) return null;
  try {
    const v = await mod.SecureStorage.get(SS_USERNAME_KEY);
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

/**
 * 启用快速登录：把当前 token + 服务器 URL + 用户名一并写入 secure storage。
 *
 * 调用方应在用户密码登录成功并明确同意后调用。
 * 调用前会发起一次生物识别认证，确保:
 *  1) 当前持有手机的人就是账号本人；
 *  2) 设备硬件 / 系统设置真的支持生物识别（提早暴露问题）。
 *
 * 返回：true=启用成功；false=用户取消或不可用。
 */
export async function enableQuickLogin(params: {
  token: string;
  refreshToken?: string;
  serverUrl: string; // 允许空字符串（Web 端同源），但客户端模式下应非空
  username: string;
}): Promise<{ ok: boolean; error?: string }> {
  if (!isCapacitorNative()) {
    return { ok: false, error: "当前环境不支持快速登录" };
  }
  if (!params.token) {
    return { ok: false, error: "缺少登录凭证" };
  }

  const bio = await loadBiometric();
  const ss = await loadSecureStorage();
  if (!bio || !ss) {
    return { ok: false, error: "生物识别组件不可用" };
  }

  // 先确认设备真支持生物识别
  const status = await checkBiometry();
  if (!status.available && !status.deviceSecure) {
    return {
      ok: false,
      error: "设备未启用指纹 / 人脸或锁屏密码，请先在系统设置中启用",
    };
  }

  // 启用流程也要求一次认证（防止"借用别人的手机偷偷开"），允许设备 PIN 兜底
  try {
    await bio.BiometricAuth.authenticate({
      reason: "启用快速登录",
      cancelTitle: "取消",
      androidTitle: "启用快速登录",
      androidSubtitle: "请验证你的指纹 / 人脸 / 锁屏密码",
      androidConfirmationRequired: false,
      allowDeviceCredential: true,
    });
  } catch (e: any) {
    return {
      ok: false,
      error: e?.message || "已取消",
    };
  }

  // 写入安全存储。任意一项失败都视为整体失败并回滚。
  try {
    await ss.SecureStorage.set(SS_TOKEN_KEY, params.token);
    await ss.SecureStorage.set(SS_REFRESH_TOKEN_KEY, params.refreshToken || "");
    await ss.SecureStorage.set(SS_SERVER_URL_KEY, params.serverUrl || "");
    await ss.SecureStorage.set(SS_USERNAME_KEY, params.username || "");
    await ss.SecureStorage.set(SS_ENABLED_KEY, true);
    return { ok: true };
  } catch (e: any) {
    // 回滚
    try {
      await ss.SecureStorage.remove(SS_TOKEN_KEY);
      await ss.SecureStorage.remove(SS_REFRESH_TOKEN_KEY);
      await ss.SecureStorage.remove(SS_SERVER_URL_KEY);
      await ss.SecureStorage.remove(SS_USERNAME_KEY);
      await ss.SecureStorage.remove(SS_ENABLED_KEY);
    } catch {
      /* ignore */
    }
    return { ok: false, error: e?.message || "保存失败" };
  }
}

/** 关闭快速登录并清空 secure storage 中的相关项 */
export async function disableQuickLogin(): Promise<void> {
  const ss = await loadSecureStorage();
  if (!ss) return;
  try {
    await ss.SecureStorage.remove(SS_TOKEN_KEY);
    await ss.SecureStorage.remove(SS_REFRESH_TOKEN_KEY);
    await ss.SecureStorage.remove(SS_SERVER_URL_KEY);
    await ss.SecureStorage.remove(SS_USERNAME_KEY);
    await ss.SecureStorage.remove(SS_ENABLED_KEY);
  } catch (e) {
    console.warn("[quickLogin] disable cleanup failed:", e);
  }
}

/**
 * 启动时尝试快速登录：
 *   1) 校验开关已开 + 生物识别可用；
 *   2) 弹生物识别认证；
 *   3) 取出 token + serverUrl + username；
 *   4) 由调用方拿去走 /me。
 *
 * 函数本身不会调 verify，也不会写 localStorage——这两步都交给 AuthGate /
 * QuickLoginGate 处理，使得本模块零依赖业务路由。
 *
 * 返回值：
 *   - { ok: true, ... }：用户认证通过，token 已就位
 *   - { ok: false, reason: "unsupported" }：环境不支持，UI 应当完全不出现
 *   - { ok: false, reason: "not_enabled" }：未开启快速登录，UI 走密码登录
 *   - { ok: false, reason: "user_cancel" }：用户取消
 *   - { ok: false, reason: "biometry_unavailable" }：硬件 / 系统状态不允许
 *   - { ok: false, reason: "error", message }：其它错误
 */
export type QuickLoginAttemptResult =
  | {
      ok: true;
      token: string;
      refreshToken?: string;
      serverUrl: string;
      username: string;
    }
  | {
      ok: false;
      reason:
        | "unsupported"
        | "not_enabled"
        | "user_cancel"
        | "biometry_unavailable"
        | "error";
      message?: string;
    };

export async function attemptQuickLogin(): Promise<QuickLoginAttemptResult> {
  if (!isCapacitorNative()) {
    return { ok: false, reason: "unsupported" };
  }

  const ss = await loadSecureStorage();
  const bio = await loadBiometric();
  if (!ss || !bio) {
    return { ok: false, reason: "unsupported" };
  }

  let enabled = false;
  try {
    const flag = await ss.SecureStorage.get(SS_ENABLED_KEY);
    enabled = flag === true || flag === "true" || flag === 1 || flag === "1";
  } catch {
    enabled = false;
  }
  if (!enabled) return { ok: false, reason: "not_enabled" };

  const status = await checkBiometry();
  if (!status.available && !status.deviceSecure) {
    return { ok: false, reason: "biometry_unavailable" };
  }

  try {
    await bio.BiometricAuth.authenticate({
      reason: "解锁 Nowen Note",
      cancelTitle: "改用密码登录",
      androidTitle: "Nowen Note 快速登录",
      androidSubtitle: "请验证你的指纹 / 人脸 / 锁屏密码",
      androidConfirmationRequired: false,
      allowDeviceCredential: true,
    });
  } catch (e: any) {
    // 错误码归一化
    const code = String(e?.code || "");
    if (code === "userCancel" || code === "appCancel" || code === "systemCancel") {
      return { ok: false, reason: "user_cancel" };
    }
    if (
      code === "biometryNotAvailable" ||
      code === "biometryNotEnrolled" ||
      code === "passcodeNotSet" ||
      code === "noDeviceCredential" ||
      code === "biometryLockout"
    ) {
      return { ok: false, reason: "biometry_unavailable", message: e?.message };
    }
    return { ok: false, reason: "error", message: e?.message };
  }

  // 认证通过 → 取出凭据
  let token: string | null = null;
  let refreshToken: string | undefined;
  let serverUrl = "";
  let username = "";
  try {
    const t = await ss.SecureStorage.get(SS_TOKEN_KEY);
    if (typeof t === "string" && t) token = t;
    const r = await ss.SecureStorage.get(SS_REFRESH_TOKEN_KEY);
    if (typeof r === "string" && r) refreshToken = r;
    const s = await ss.SecureStorage.get(SS_SERVER_URL_KEY);
    if (typeof s === "string") serverUrl = s;
    const u = await ss.SecureStorage.get(SS_USERNAME_KEY);
    if (typeof u === "string") username = u;
  } catch (e: any) {
    return { ok: false, reason: "error", message: e?.message };
  }

  if (!token) {
    // 数据丢失（卸载部分残留？）→ 关闭开关并降级
    await disableQuickLogin();
    return { ok: false, reason: "not_enabled" };
  }

  return { ok: true, token, refreshToken, serverUrl, username };
}

// ============================================================================
// "是否已问过用户启用引导"（避免每次登录都弹）
// ============================================================================

export function hasAskedEnroll(): boolean {
  try {
    return !!localStorage.getItem(LS_ENROLL_ASKED_KEY);
  } catch {
    return false;
  }
}

export function markEnrollAsked(): void {
  try {
    localStorage.setItem(LS_ENROLL_ASKED_KEY, String(Date.now()));
  } catch {
    /* ignore */
  }
}

/** 测试 / 用户主动取消时清除"已问过"标记，让下次登录再次提示 */
export function resetEnrollAsked(): void {
  try {
    localStorage.removeItem(LS_ENROLL_ASKED_KEY);
  } catch {
    /* ignore */
  }
}
