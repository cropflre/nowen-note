import { Capacitor } from "@capacitor/core";
import { normalizeServerBaseUrl } from "@/lib/serverUrl";

const MOBILE_HISTORY_KEY = "nowen.accountHistory.secureRecords";
export const CURRENT_ACCOUNT_HISTORY_ID_KEY = "nowen-account-history-current-id";
export const PENDING_ACCOUNT_REAUTH_KEY = "nowen-account-history-pending-reauth";

export interface AccountLoginHistoryItem {
  id: string;
  serverUrl: string;
  userId: string;
  username: string;
  displayName: string;
  avatarUrl: string;
  lastUsedAt: number;
  requiresReauth: boolean;
}

interface SecureAccountLoginRecord extends AccountLoginHistoryItem {
  token: string;
  refreshToken: string;
}

export interface AccountLoginUser {
  id: string;
  username: string;
  displayName?: string | null;
  avatarUrl?: string | null;
}

export interface PendingAccountReauth {
  id: string;
  serverUrl: string;
  username: string;
}

interface DesktopAccountHistoryBridge {
  list(): Promise<AccountLoginHistoryItem[]>;
  save(payload: {
    serverUrl: string;
    userId: string;
    username: string;
    displayName: string;
    avatarUrl: string;
    token: string;
    refreshToken?: string;
    lastUsedAt: number;
  }): Promise<{ ok: boolean; id?: string; error?: string }>;
  loadToken(id: string): Promise<{ ok: boolean; token?: string; refreshToken?: string; error?: string }>;
  markRequiresReauth(id: string): Promise<{ ok: boolean; error?: string }>;
  remove(id: string): Promise<{ ok: boolean; error?: string }>;
}

type SecureStorageModule = typeof import("@aparajita/capacitor-secure-storage");
let secureStoragePromise: Promise<SecureStorageModule | null> | null = null;

function getDesktopBridge(): DesktopAccountHistoryBridge | null {
  if (typeof window === "undefined") return null;
  return (window as any).nowenDesktop?.accountHistory ?? null;
}

function isCapacitorNative(): boolean {
  try { return !!Capacitor?.isNativePlatform?.(); } catch { return false; }
}

async function getSecureStorage(): Promise<SecureStorageModule | null> {
  if (!isCapacitorNative()) return null;
  if (!secureStoragePromise) {
    secureStoragePromise = import("@aparajita/capacitor-secure-storage")
      .then(async (mod) => {
        try { await mod.SecureStorage.setKeyPrefix("nowen_"); } catch { /* 不影响读取 */ }
        return mod;
      })
      .catch((error) => {
        console.warn("[accountHistory] secure storage load failed:", error);
        return null;
      });
  }
  return secureStoragePromise;
}

function createHistoryId(): string {
  try { return crypto.randomUUID(); } catch { return `${Date.now()}-${Math.random().toString(36).slice(2)}`; }
}

function normalizeRecord(value: unknown): SecureAccountLoginRecord | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<SecureAccountLoginRecord>;
  const serverUrl = normalizeServerBaseUrl(raw.serverUrl);
  if (!raw.id || !serverUrl || !raw.userId || !raw.username) return null;
  return {
    id: String(raw.id),
    serverUrl,
    userId: String(raw.userId),
    username: String(raw.username),
    displayName: typeof raw.displayName === "string" ? raw.displayName : "",
    avatarUrl: typeof raw.avatarUrl === "string" ? raw.avatarUrl : "",
    token: typeof raw.token === "string" ? raw.token : "",
    refreshToken: typeof raw.refreshToken === "string" ? raw.refreshToken : "",
    lastUsedAt: Number.isFinite(raw.lastUsedAt) ? Number(raw.lastUsedAt) : 0,
    requiresReauth: !!raw.requiresReauth || !raw.token,
  };
}

async function readMobileRecords(): Promise<{
  ok: boolean;
  records: SecureAccountLoginRecord[];
  error?: string;
}> {
  const storage = await getSecureStorage();
  if (!storage) return { ok: false, records: [], error: "STORAGE_ERROR" };
  try {
    const value = await storage.SecureStorage.get(MOBILE_HISTORY_KEY);
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    const records = Array.isArray(parsed)
      ? parsed.map(normalizeRecord).filter((item): item is SecureAccountLoginRecord => !!item)
      : [];
    return { ok: true, records };
  } catch (error) {
    console.warn("[accountHistory] secure storage read failed:", error);
    return { ok: false, records: [], error: "STORAGE_ERROR" };
  }
}

async function writeMobileRecords(records: SecureAccountLoginRecord[]): Promise<boolean> {
  const storage = await getSecureStorage();
  if (!storage) return false;
  try {
    await storage.SecureStorage.set(MOBILE_HISTORY_KEY, JSON.stringify(records));
    return true;
  } catch (error) {
    console.warn("[accountHistory] secure storage write failed:", error);
    return false;
  }
}

function toPublicItem(record: SecureAccountLoginRecord): AccountLoginHistoryItem {
  const { token: _token, refreshToken: _refreshToken, ...item } = record;
  return item;
}

export function isAccountLoginHistorySupported(): boolean {
  return !!getDesktopBridge() || isCapacitorNative();
}

export async function listAccountLoginHistory(): Promise<AccountLoginHistoryItem[]> {
  const desktop = getDesktopBridge();
  if (desktop) {
    const items = await desktop.list().catch(() => []);
    return Array.isArray(items) ? items.sort((a, b) => b.lastUsedAt - a.lastUsedAt) : [];
  }
  const result = await readMobileRecords();
  return result.ok ? result.records.map(toPublicItem).sort((a, b) => b.lastUsedAt - a.lastUsedAt) : [];
}

export async function saveAccountLoginHistory(params: {
  serverUrl: string;
  token: string;
  refreshToken?: string;
  user: AccountLoginUser;
  lastUsedAt?: number;
}): Promise<{ ok: boolean; id?: string; error?: string }> {
  const serverUrl = normalizeServerBaseUrl(params.serverUrl);
  if (!serverUrl || !params.token || !params.user?.id || !params.user?.username) {
    return { ok: false, error: "INVALID_PAYLOAD" };
  }
  const payload = {
    serverUrl,
    userId: params.user.id,
    username: params.user.username,
    displayName: params.user.displayName || "",
    avatarUrl: params.user.avatarUrl || "",
    token: params.token,
    refreshToken: params.refreshToken || "",
    lastUsedAt: params.lastUsedAt ?? Date.now(),
  };
  const desktop = getDesktopBridge();
  if (desktop) {
    const result: { ok: boolean; id?: string; error?: string } = await desktop
      .save(payload)
      .catch(() => ({ ok: false, error: "STORAGE_ERROR" }));
    if (result.ok && result.id) {
      setCurrentHistoryId(result.id);
      notifyHistoryChanged();
    }
    return result;
  }
  if (!isCapacitorNative()) return { ok: false, error: "UNSUPPORTED" };

  const readResult = await readMobileRecords();
  if (!readResult.ok) return { ok: false, error: readResult.error };
  const existing = readResult.records.find((item) => item.serverUrl === serverUrl && item.userId === params.user.id);
  const id = existing?.id || createHistoryId();
  const next: SecureAccountLoginRecord = { id, ...payload, requiresReauth: false };
  const ok = await writeMobileRecords([next, ...readResult.records.filter((item) => item.id !== id)]);
  if (ok) {
    setCurrentHistoryId(id);
    notifyHistoryChanged();
  }
  return ok ? { ok: true, id } : { ok: false, error: "WRITE_FAILED" };
}

/**
 * 修改一条已保存账号的服务器地址。
 *
 * Android/iOS 原生端直接更新 SecureStorage 中的记录，保留原 history id、token
 * 与 refresh token。桌面端旧 preload 没有专用 update IPC，因此通过“读取加密令牌
 * → 保存到新地址 → 删除旧记录”完成兼容迁移；若修改的是当前账号，会同步迁移
 * CURRENT_ACCOUNT_HISTORY_ID_KEY，避免刷新后丢失“当前”标记。
 */
export async function updateAccountLoginHistoryServerUrl(
  id: string,
  nextServerUrl: string,
): Promise<{ ok: boolean; id?: string; error?: string }> {
  const serverUrl = normalizeServerBaseUrl(nextServerUrl);
  if (!id || !serverUrl) return { ok: false, error: "INVALID_PAYLOAD" };

  const desktop = getDesktopBridge();
  if (desktop) {
    try {
      const items = await desktop.list();
      const item = items.find((entry) => entry.id === id);
      if (!item) return { ok: false, error: "NOT_FOUND" };
      if (item.serverUrl === serverUrl) return { ok: true, id };

      const loaded = await desktop.loadToken(id);
      if (!loaded.ok || !loaded.token) {
        return { ok: false, error: loaded.error || "TOKEN_UNAVAILABLE" };
      }
      const saved = await desktop.save({
        serverUrl,
        userId: item.userId,
        username: item.username,
        displayName: item.displayName,
        avatarUrl: item.avatarUrl,
        token: loaded.token,
        refreshToken: loaded.refreshToken,
        lastUsedAt: item.lastUsedAt,
      });
      if (!saved.ok || !saved.id) return { ok: false, error: saved.error || "WRITE_FAILED" };

      const nextId = saved.id;
      if (nextId !== id) {
        const removed = await desktop.remove(id);
        if (!removed.ok) return { ok: false, error: removed.error || "WRITE_FAILED" };
      }
      replaceCurrentHistoryId(id, nextId);
      notifyHistoryChanged();
      return { ok: true, id: nextId };
    } catch (error) {
      console.warn("[accountHistory] desktop server update failed:", error);
      return { ok: false, error: "STORAGE_ERROR" };
    }
  }

  if (!isCapacitorNative()) return { ok: false, error: "UNSUPPORTED" };
  const readResult = await readMobileRecords();
  if (!readResult.ok) return { ok: false, error: readResult.error || "STORAGE_ERROR" };
  const current = readResult.records.find((record) => record.id === id);
  if (!current) return { ok: false, error: "NOT_FOUND" };
  if (current.serverUrl === serverUrl) return { ok: true, id };

  // 如果新地址已经存在同一用户的历史记录，合并为当前这条记录，避免 IP/域名
  // 切换后列表出现两个完全相同的账号。优先保留正在编辑记录的令牌；若它已失效，
  // 才使用冲突记录里仍可用的令牌。
  const duplicate = readResult.records.find(
    (record) => record.id !== id && record.serverUrl === serverUrl && record.userId === current.userId,
  );
  const merged: SecureAccountLoginRecord = {
    ...current,
    serverUrl,
    token: current.token || duplicate?.token || "",
    refreshToken: current.refreshToken || duplicate?.refreshToken || "",
    requiresReauth: current.token
      ? current.requiresReauth
      : duplicate
        ? duplicate.requiresReauth
        : current.requiresReauth,
    lastUsedAt: Math.max(current.lastUsedAt, duplicate?.lastUsedAt || 0),
  };
  if (!merged.token) merged.requiresReauth = true;

  const nextRecords = readResult.records.map((record) => record.id === id ? merged : record)
    .filter((record) => !duplicate || record.id !== duplicate.id);
  const ok = await writeMobileRecords(nextRecords);
  if (!ok) return { ok: false, error: "WRITE_FAILED" };
  notifyHistoryChanged();
  return { ok: true, id };
}

export async function loadAccountLoginToken(
  id: string,
): Promise<{ ok: boolean; token?: string; refreshToken?: string; error?: string }> {
  const desktop = getDesktopBridge();
  if (desktop) return desktop.loadToken(id).catch(() => ({ ok: false, error: "STORAGE_ERROR" }));
  const result = await readMobileRecords();
  if (!result.ok) return { ok: false, error: result.error || "STORAGE_ERROR" };
  const item = result.records.find((record) => record.id === id);
  return item?.token && !item.requiresReauth
    ? { ok: true, token: item.token, ...(item.refreshToken ? { refreshToken: item.refreshToken } : {}) }
    : { ok: false, error: "TOKEN_UNAVAILABLE" };
}

export async function markAccountLoginRequiresReauth(id: string): Promise<{ ok: boolean; error?: string }> {
  const desktop = getDesktopBridge();
  if (desktop) {
    const result = await desktop.markRequiresReauth(id).catch(() => ({ ok: false, error: "STORAGE_ERROR" }));
    if (result.ok) {
      clearCurrentHistoryId(id);
      notifyHistoryChanged();
    }
    return result;
  }
  const readResult = await readMobileRecords();
  if (!readResult.ok) return { ok: false, error: readResult.error };
  const item = readResult.records.find((record) => record.id === id);
  if (!item) return { ok: false, error: "NOT_FOUND" };
  item.token = "";
  item.refreshToken = "";
  item.requiresReauth = true;
  const ok = await writeMobileRecords(readResult.records);
  if (ok) {
    clearCurrentHistoryId(id);
    notifyHistoryChanged();
  }
  return { ok };
}

export async function removeAccountLoginHistory(id: string): Promise<{ ok: boolean; error?: string }> {
  const desktop = getDesktopBridge();
  if (desktop) {
    const result = await desktop.remove(id).catch(() => ({ ok: false, error: "STORAGE_ERROR" }));
    if (result.ok) {
      clearCurrentHistoryId(id);
      notifyHistoryChanged();
    }
    return result;
  }
  const readResult = await readMobileRecords();
  if (!readResult.ok) return { ok: false, error: readResult.error };
  const ok = await writeMobileRecords(readResult.records.filter((record) => record.id !== id));
  if (ok) {
    clearCurrentHistoryId(id);
    notifyHistoryChanged();
  }
  return { ok };
}

function notifyHistoryChanged(): void {
  try { window.dispatchEvent(new CustomEvent("nowen:account-history-changed")); } catch { /* ignore */ }
}

function setCurrentHistoryId(id: string): void {
  try { localStorage.setItem(CURRENT_ACCOUNT_HISTORY_ID_KEY, id); } catch { /* ignore */ }
}

function replaceCurrentHistoryId(previousId: string, nextId: string): void {
  try {
    if (localStorage.getItem(CURRENT_ACCOUNT_HISTORY_ID_KEY) === previousId) {
      localStorage.setItem(CURRENT_ACCOUNT_HISTORY_ID_KEY, nextId);
    }
  } catch { /* ignore */ }
}

function clearCurrentHistoryId(id: string): void {
  try {
    if (localStorage.getItem(CURRENT_ACCOUNT_HISTORY_ID_KEY) === id) {
      localStorage.removeItem(CURRENT_ACCOUNT_HISTORY_ID_KEY);
    }
  } catch { /* ignore */ }
}

export function setPendingAccountReauth(value: PendingAccountReauth): void {
  try { sessionStorage.setItem(PENDING_ACCOUNT_REAUTH_KEY, JSON.stringify(value)); } catch { /* ignore */ }
}

export function consumePendingAccountReauth(): PendingAccountReauth | null {
  try {
    const raw = sessionStorage.getItem(PENDING_ACCOUNT_REAUTH_KEY);
    sessionStorage.removeItem(PENDING_ACCOUNT_REAUTH_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<PendingAccountReauth>;
    const serverUrl = normalizeServerBaseUrl(value.serverUrl);
    if (!value.id || !serverUrl || !value.username) return null;
    return { id: String(value.id), serverUrl, username: String(value.username) };
  } catch {
    return null;
  }
}
