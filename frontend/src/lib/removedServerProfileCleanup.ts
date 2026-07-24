import { Capacitor } from "@capacitor/core";

const PROFILE_INDEX_KEY = "nowen-profile-credential-index-v1";
const PROFILE_STORAGE_KEYS = [
  "nowen-server-profiles-v2",
  "nowen-active-server-profile-v2",
  "nowen-server-profiles-v1",
  "nowen-active-server-profile-v1",
  "nowen-cloud-login-records-v1",
];
const PENDING_REAUTH_KEY = "nowen-pending-profile-reauth-v1";

interface CleanupDependencies {
  isNativePlatform?: () => boolean;
  removeSecureItem?: (key: string) => Promise<void>;
}

function readProfileIds(): string[] {
  try {
    const raw = localStorage.getItem(PROFILE_INDEX_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string" && !!id) : [];
  } catch {
    return [];
  }
}

async function removeNativeSecureItem(key: string): Promise<void> {
  const { SecureStorage } = await import("@aparajita/capacitor-secure-storage");
  try {
    await SecureStorage.setKeyPrefix("nowen_");
  } catch {
    // 已有安装可能已经设置相同前缀，可以继续删除。
  }
  await SecureStorage.remove(key);
}

export async function cleanupRemovedServerProfiles(dependencies: CleanupDependencies = {}): Promise<void> {
  const isNativePlatform = dependencies.isNativePlatform ?? (() => !!Capacitor?.isNativePlatform?.());
  const profileIds = readProfileIds();
  let canRemoveIndex = true;

  if (isNativePlatform() && profileIds.length > 0) {
    const removeSecureItem = dependencies.removeSecureItem ?? removeNativeSecureItem;
    for (const profileId of profileIds) {
      try {
        await removeSecureItem(`serverAccount.${profileId}.v1`);
      } catch (error) {
        canRemoveIndex = false;
        console.warn("[removedServerProfileCleanup] 删除旧服务器凭据失败:", error);
      }
    }
  }

  try {
    for (const key of PROFILE_STORAGE_KEYS) localStorage.removeItem(key);
    if (canRemoveIndex) localStorage.removeItem(PROFILE_INDEX_KEY);
  } catch {
    // 存储不可用时不阻止应用启动。
  }

  try {
    sessionStorage.removeItem(PENDING_REAUTH_KEY);
  } catch {
    // 存储不可用时不阻止应用启动。
  }
}
