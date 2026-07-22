import { Capacitor } from "@capacitor/core";
import {
  bootstrapServerProfiles,
  getActiveServerProfile,
  getLegacyServerProfileCredentials,
  listServerProfiles,
  markServerProfileActive,
  removeLegacyServerProfileStorage,
  updateServerProfileCredentialState,
  updateServerProfileStatus,
  type ServerProfile,
} from "@/lib/serverProfiles";

export interface ProfileCredential {
  profileId: string;
  serverUrl: string;
  username: string;
  token: string;
  password: string;
  autoLogin: boolean;
  hasToken: boolean;
  hasPassword: boolean;
  savedAt?: number;
}

export interface SaveProfileCredentialParams {
  profileId: string;
  serverUrl: string;
  username: string;
  token?: string;
  password?: string;
  autoLogin?: boolean;
}

export interface CredentialSaveResult {
  ok: boolean;
  encrypted: boolean;
  persisted: boolean;
  error?: string;
}

export interface PendingProfileReauthentication {
  profileId: string;
  serverUrl: string;
  username: string;
}

const NATIVE_KEY_PREFIX = "serverAccount.";
const NATIVE_INDEX_KEY = "nowen-profile-credential-index-v1";
const PENDING_REAUTH_KEY = "nowen-pending-profile-reauth-v1";

function isCapacitorNative(): boolean {
  try {
    return !!Capacitor?.isNativePlatform?.();
  } catch {
    return false;
  }
}

function getDesktopProfileApi(): any {
  try {
    const credentials = (window as any).nowenDesktop?.credentials;
    if (credentials && typeof credentials.loadProfile === "function") return credentials;
  } catch { /* ignore */ }
  return null;
}

type SecureStorageModule = typeof import("@aparajita/capacitor-secure-storage");
let secureStoragePromise: Promise<SecureStorageModule | null> | null = null;
async function loadSecureStorage(): Promise<SecureStorageModule | null> {
  if (!isCapacitorNative()) return null;
  if (secureStoragePromise) return secureStoragePromise;
  secureStoragePromise = (async () => {
    try {
      const mod = await import(/* @vite-ignore */ "@aparajita/capacitor-secure-storage");
      try { await mod.SecureStorage.setKeyPrefix("nowen_"); } catch { /* ignore */ }
      return mod;
    } catch (error) {
      console.warn("[profileCredentialVault] secure storage unavailable:", error);
      return null;
    }
  })();
  return secureStoragePromise;
}

function nativeKey(profileId: string): string {
  return `${NATIVE_KEY_PREFIX}${profileId}.v1`;
}

function readNativeIndex(): string[] {
  try {
    const raw = localStorage.getItem(NATIVE_INDEX_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function writeNativeIndex(ids: string[]): void {
  try {
    if (ids.length === 0) localStorage.removeItem(NATIVE_INDEX_KEY);
    else localStorage.setItem(NATIVE_INDEX_KEY, JSON.stringify(Array.from(new Set(ids))));
  } catch { /* ignore */ }
}

function normalizeCredential(value: any, profileId: string): ProfileCredential | null {
  if (!value || typeof value !== "object") return null;
  const token = typeof value.token === "string" ? value.token : "";
  const password = typeof value.password === "string" ? value.password : "";
  const serverUrl = typeof value.serverUrl === "string" ? value.serverUrl : "";
  const username = typeof value.username === "string" ? value.username : "";
  if (!token && !password && !serverUrl && !username) return null;
  return {
    profileId,
    serverUrl,
    username,
    token,
    password,
    autoLogin: !!value.autoLogin,
    hasToken: !!token,
    hasPassword: !!password,
    savedAt: Number.isFinite(value.savedAt) ? Number(value.savedAt) : undefined,
  };
}

export async function canPersistProfileSecrets(): Promise<boolean> {
  const desktop = getDesktopProfileApi();
  if (desktop) {
    try { return !!(await desktop.isEncryptionAvailable()); } catch { return false; }
  }
  if (isCapacitorNative()) return !!(await loadSecureStorage());
  return false;
}

export async function loadProfileCredential(profileId: string): Promise<ProfileCredential | null> {
  if (!profileId) return null;
  try {
    const desktop = getDesktopProfileApi();
    if (desktop) return normalizeCredential(await desktop.loadProfile(profileId), profileId);
    if (isCapacitorNative()) {
      const mod = await loadSecureStorage();
      if (!mod) return null;
      const raw = await mod.SecureStorage.get(nativeKey(profileId));
      if (typeof raw !== "string" || !raw) return null;
      return normalizeCredential(JSON.parse(raw), profileId);
    }
    return null;
  } catch (error) {
    console.warn("[profileCredentialVault] load failed:", error);
    return null;
  }
}

export async function saveProfileCredential(params: SaveProfileCredentialParams): Promise<CredentialSaveResult> {
  if (!params.profileId) return { ok: false, encrypted: false, persisted: false, error: "INVALID_PROFILE_ID" };
  try {
    const desktop = getDesktopProfileApi();
    if (desktop) {
      const result = await desktop.saveProfile({
        profileId: params.profileId,
        serverUrl: params.serverUrl || "",
        username: params.username || "",
        token: params.token || "",
        password: params.password || "",
        autoLogin: !!params.autoLogin,
      });
      return {
        ok: !!result?.ok,
        encrypted: !!result?.encrypted,
        persisted: !!result?.persisted,
        error: result?.error,
      };
    }
    if (isCapacitorNative()) {
      const mod = await loadSecureStorage();
      if (!mod) return { ok: false, encrypted: false, persisted: false, error: "SecureStorage 不可用" };
      const payload = {
        serverUrl: params.serverUrl || "",
        username: params.username || "",
        token: params.token || "",
        password: params.password || "",
        autoLogin: !!params.autoLogin,
        savedAt: Date.now(),
      };
      await mod.SecureStorage.set(nativeKey(params.profileId), JSON.stringify(payload));
      writeNativeIndex([...readNativeIndex(), params.profileId]);
      return { ok: true, encrypted: true, persisted: !!(payload.token || payload.password) };
    }
    // Web intentionally persists no secret. Profile metadata already retains server + username.
    return { ok: true, encrypted: false, persisted: false };
  } catch (error: any) {
    console.warn("[profileCredentialVault] save failed:", error);
    return { ok: false, encrypted: false, persisted: false, error: error?.message || String(error) };
  }
}

export async function removeProfileCredential(profileId: string): Promise<void> {
  if (!profileId) return;
  try {
    const desktop = getDesktopProfileApi();
    if (desktop) await desktop.removeProfile(profileId);
    if (isCapacitorNative()) {
      const mod = await loadSecureStorage();
      if (mod) await mod.SecureStorage.remove(nativeKey(profileId));
      writeNativeIndex(readNativeIndex().filter((id) => id !== profileId));
    }
  } catch (error) {
    console.warn("[profileCredentialVault] remove failed:", error);
  }
}

export async function listProfileCredentialSummaries(): Promise<Array<{ profileId: string; hasToken: boolean; hasPassword: boolean; autoLogin: boolean }>> {
  try {
    const desktop = getDesktopProfileApi();
    if (desktop) return await desktop.listProfiles();
    if (isCapacitorNative()) {
      const rows = await Promise.all(readNativeIndex().map(async (profileId) => {
        const credential = await loadProfileCredential(profileId);
        return credential ? {
          profileId,
          hasToken: credential.hasToken,
          hasPassword: credential.hasPassword,
          autoLogin: credential.autoLogin,
        } : null;
      }));
      return rows.filter(Boolean) as Array<{ profileId: string; hasToken: boolean; hasPassword: boolean; autoLogin: boolean }>;
    }
  } catch { /* ignore */ }
  return [];
}

let migrationPromise: Promise<{ migrated: number; requiresLogin: number }> | null = null;
export function migrateLegacyServerProfileCredentials(): Promise<{ migrated: number; requiresLogin: number }> {
  if (migrationPromise) return migrationPromise;
  migrationPromise = (async () => {
    bootstrapServerProfiles();
    const candidates = getLegacyServerProfileCredentials();
    const activeId = getActiveServerProfile()?.id || "";
    let migrated = 0;
    let requiresLogin = 0;
    for (const candidate of candidates) {
      const result = await saveProfileCredential({
        profileId: candidate.id,
        serverUrl: candidate.serverUrl,
        username: candidate.username,
        token: candidate.token,
        autoLogin: false,
      });
      if (result.ok && result.persisted) {
        migrated += 1;
        updateServerProfileCredentialState(candidate.id, { rememberCredential: true });
      } else if (candidate.id !== activeId) {
        requiresLogin += 1;
        updateServerProfileCredentialState(candidate.id, {
          rememberCredential: false,
          autoLogin: false,
          status: "auth-expired",
        });
      }
    }
    removeLegacyServerProfileStorage();
    return { migrated, requiresLogin };
  })();
  return migrationPromise;
}

export function stagePendingProfileReauthentication(profile: ServerProfile): void {
  try {
    sessionStorage.setItem(PENDING_REAUTH_KEY, JSON.stringify({
      profileId: profile.id,
      serverUrl: profile.serverUrl,
      username: profile.username,
    } satisfies PendingProfileReauthentication));
  } catch { /* ignore */ }
}

export function getPendingProfileReauthentication(): PendingProfileReauthentication | null {
  try {
    const raw = sessionStorage.getItem(PENDING_REAUTH_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PendingProfileReauthentication;
    return parsed?.profileId && parsed?.serverUrl ? parsed : null;
  } catch {
    return null;
  }
}

export function clearPendingProfileReauthentication(): void {
  try { sessionStorage.removeItem(PENDING_REAUTH_KEY); } catch { /* ignore */ }
}

export async function finalizePendingProfileLogin(args: {
  token: string;
  password?: string;
  user?: { id?: string; username?: string; displayName?: string | null; avatarUrl?: string | null };
}): Promise<void> {
  const pending = getPendingProfileReauthentication();
  if (!pending) return;
  const profile = listServerProfiles().find((item) => item.id === pending.profileId);
  if (!profile) {
    clearPendingProfileReauthentication();
    return;
  }
  if (profile.rememberCredential) {
    const saved = await saveProfileCredential({
      profileId: profile.id,
      serverUrl: profile.serverUrl,
      username: args.user?.username || profile.username,
      token: args.token,
      password: args.password || "",
      autoLogin: profile.autoLogin,
    });
    if (!saved.persisted) {
      updateServerProfileCredentialState(profile.id, { rememberCredential: false, autoLogin: false });
    }
  }
  updateServerProfileStatus(profile.id, {
    status: "online",
    username: args.user?.username || profile.username,
    userId: args.user?.id,
    displayName: args.user?.displayName || args.user?.username || profile.displayName || undefined,
    avatarUrl: args.user?.avatarUrl || undefined,
  });
  markServerProfileActive(profile.id);
  clearPendingProfileReauthentication();
}
