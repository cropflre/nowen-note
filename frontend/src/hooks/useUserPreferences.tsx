import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { api } from "@/lib/api";
import {
  DEFAULT_USER_PREFERENCES,
  accountPreferenceStorageKey,
  claimLegacyUserPreferences,
  decodeUserIdFromToken,
  mergePendingPreferences,
  normalizeUserPreferences,
  readAccountPreferenceCache,
  sanitizeUserPreferencePatch,
  writeAccountPreferenceCache,
  type MarkdownViewMode,
  type ReadingDensity,
  type UserPreferenceCache,
  type UserPreferencePatch,
  type UserPreferences,
} from "@/lib/userPreferenceAccountCache";

export type { MarkdownViewMode, ReadingDensity, UserPreferences } from "@/lib/userPreferenceAccountCache";

/**
 * 用户级 UI 偏好（per-user, synced）
 *
 * 账号级偏好以服务端为准，并在浏览器中使用 userId 隔离的缓存作为启动/离线兜底。
 * 窗口位置、下载目录、缓存大小等设备级配置不进入这里；API Key、Token 等敏感信息
 * 也不属于普通偏好白名单。
 */

type RemotePreferences = UserPreferences & {
  hasPreferences?: boolean;
  userId?: string;
  revision?: number;
  fieldUpdatedAt?: Partial<Record<keyof UserPreferences, string>>;
  updatedAt?: string | null;
  conflict?: boolean;
};

interface UserPreferencesContextValue {
  prefs: UserPreferences;
  setPref: <K extends keyof UserPreferences>(key: K, value: UserPreferences[K]) => void;
}

const UserPreferencesContext = createContext<UserPreferencesContextValue>({
  prefs: DEFAULT_USER_PREFERENCES,
  setPref: () => {},
});

function currentIdentity(): { token: string; userId: string } | null {
  try {
    const token = localStorage.getItem("nowen-token") || "";
    const userId = decodeUserIdFromToken(token);
    return token && userId ? { token, userId } : null;
  } catch {
    return null;
  }
}

function initialPreferences(): UserPreferences {
  const identity = currentIdentity();
  if (!identity) return DEFAULT_USER_PREFERENCES;
  return readAccountPreferenceCache(localStorage, identity.userId)?.prefs || DEFAULT_USER_PREFERENCES;
}

function samePreferenceValue<K extends keyof UserPreferences>(
  left: UserPreferences[K] | undefined,
  right: UserPreferences[K] | undefined,
): boolean {
  return left === right;
}

export function UserPreferencesProvider({ children }: { children: React.ReactNode }) {
  const [prefs, setPrefs] = useState<UserPreferences>(initialPreferences);
  const prefsRef = useRef(prefs);
  const activeUserIdRef = useRef<string | null>(currentIdentity()?.userId || null);
  const revisionRef = useRef(0);
  const pendingRef = useRef<UserPreferencePatch>({});
  const syncSequenceRef = useRef(0);

  useEffect(() => {
    prefsRef.current = prefs;
  }, [prefs]);

  // 阅读密度作用到全局：通过 body class 触发 CSS 变量切换。
  useEffect(() => {
    const cls = "density-compact";
    document.body.classList.toggle(cls, prefs.readingDensity === "compact");
  }, [prefs.readingDensity]);

  const applyCache = useCallback((cache: UserPreferenceCache) => {
    activeUserIdRef.current = cache.userId;
    revisionRef.current = cache.revision;
    pendingRef.current = cache.pending;
    prefsRef.current = cache.prefs;
    setPrefs(cache.prefs);
    writeAccountPreferenceCache(localStorage, cache);
  }, []);

  const resetForIdentity = useCallback((userId: string | null) => {
    activeUserIdRef.current = userId;
    revisionRef.current = 0;
    pendingRef.current = {};

    if (!userId) {
      prefsRef.current = DEFAULT_USER_PREFERENCES;
      setPrefs(DEFAULT_USER_PREFERENCES);
      return null;
    }

    const cached = readAccountPreferenceCache(localStorage, userId);
    const next: UserPreferenceCache = cached || {
      version: 2,
      userId,
      prefs: DEFAULT_USER_PREFERENCES,
      revision: 0,
      pending: {},
    };
    applyCache(next);
    return cached;
  }, [applyCache]);

  const persistPatch = useCallback(async (
    userId: string,
    changes: UserPreferencePatch,
    migration = false,
  ) => {
    const sanitized = sanitizeUserPreferencePatch(changes);
    const keys = Object.keys(sanitized) as Array<keyof UserPreferences>;
    if (keys.length === 0) return;

    const sentRevision = revisionRef.current;
    try {
      const remote = await api.updateUserPreferences({
        ...sanitized,
        _baseRevision: sentRevision,
        _migration: migration,
      } as any) as RemotePreferences;

      const identity = currentIdentity();
      if (!identity || identity.userId !== userId || activeUserIdRef.current !== userId) return;

      const latestCache = readAccountPreferenceCache(localStorage, userId) || {
        version: 2 as const,
        userId,
        prefs: prefsRef.current,
        revision: revisionRef.current,
        pending: pendingRef.current,
      };
      const pending = { ...latestCache.pending };
      for (const key of keys) {
        if (samePreferenceValue(pending[key], sanitized[key])) delete pending[key];
      }

      const remotePrefs = normalizeUserPreferences(remote);
      const merged = mergePendingPreferences(remotePrefs, pending);
      applyCache({
        version: 2,
        userId,
        prefs: merged,
        revision: Math.max(latestCache.revision, Number(remote.revision) || 0),
        pending,
      });
    } catch {
      // 网络失败不回滚 UI；pending 会保存在账号隔离缓存中，下次聚焦/登录时重试。
    }
  }, [applyCache]);

  const syncFromServer = useCallback(async () => {
    const sequence = ++syncSequenceRef.current;
    const identity = currentIdentity();
    if (!identity) {
      resetForIdentity(null);
      return;
    }

    const { userId } = identity;
    const cachedAtStart = resetForIdentity(userId);

    try {
      const remote = await api.getUserPreferences() as RemotePreferences;
      const latestIdentity = currentIdentity();
      if (
        sequence !== syncSequenceRef.current ||
        !latestIdentity ||
        latestIdentity.userId !== userId ||
        (remote.userId && remote.userId !== userId)
      ) return;

      const latestCache = readAccountPreferenceCache(localStorage, userId) || cachedAtStart;
      const latestPending = latestCache?.pending || pendingRef.current;

      if (remote.hasPreferences) {
        const remotePrefs = normalizeUserPreferences(remote);
        const merged = mergePendingPreferences(remotePrefs, latestPending);
        applyCache({
          version: 2,
          userId,
          prefs: merged,
          revision: Number(remote.revision) || 0,
          pending: latestPending,
        });
        if (Object.keys(latestPending).length > 0) {
          void persistPatch(userId, latestPending);
        }
        return;
      }

      // 首次升级：优先使用当前账号自己的 v2 缓存；没有时才认领一次旧版全局缓存。
      // 认领标记确保同一浏览器切换到第二个账号时不会重复迁移上一账号的偏好。
      const legacy = cachedAtStart ? null : claimLegacyUserPreferences(localStorage, userId);
      const seed = latestCache?.prefs || legacy || DEFAULT_USER_PREFERENCES;
      const pending = sanitizeUserPreferencePatch({ ...seed, ...latestPending });
      applyCache({
        version: 2,
        userId,
        prefs: normalizeUserPreferences({ ...seed, ...latestPending }),
        revision: 0,
        pending,
      });
      void persistPatch(userId, pending, true);
    } catch {
      // 未登录、离线或旧后端时继续使用当前账号自己的缓存，绝不回退到其它账号缓存。
    }
  }, [applyCache, persistPatch, resetForIdentity]);

  // 多标签页/多窗口同步：只监听当前账号自己的缓存 key。
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      const identity = currentIdentity();
      if (!identity || event.key !== accountPreferenceStorageKey(identity.userId)) return;
      const cache = readAccountPreferenceCache(localStorage, identity.userId);
      if (cache) applyCache(cache);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [applyCache]);

  useEffect(() => {
    void syncFromServer();
    window.addEventListener("nowen:token-changed", syncFromServer);
    window.addEventListener("focus", syncFromServer);
    return () => {
      window.removeEventListener("nowen:token-changed", syncFromServer);
      window.removeEventListener("focus", syncFromServer);
    };
  }, [syncFromServer]);

  const setPref = useCallback(<K extends keyof UserPreferences>(key: K, value: UserPreferences[K]) => {
    setPrefs((previous) => {
      if (previous[key] === value) return previous;
      const next = { ...previous, [key]: value };
      prefsRef.current = next;

      const identity = currentIdentity();
      if (!identity) return next;

      const existing = readAccountPreferenceCache(localStorage, identity.userId);
      const pending: UserPreferencePatch = {
        ...(existing?.pending || pendingRef.current),
        [key]: value,
      };
      const cache: UserPreferenceCache = {
        version: 2,
        userId: identity.userId,
        prefs: next,
        revision: existing?.revision ?? revisionRef.current,
        pending,
      };
      writeAccountPreferenceCache(localStorage, cache);
      activeUserIdRef.current = identity.userId;
      revisionRef.current = cache.revision;
      pendingRef.current = pending;
      void persistPatch(identity.userId, { [key]: value } as UserPreferencePatch);
      return next;
    });
  }, [persistPatch]);

  const value = useMemo(() => ({ prefs, setPref }), [prefs, setPref]);

  return (
    <UserPreferencesContext.Provider value={value}>
      {children}
    </UserPreferencesContext.Provider>
  );
}

export function useUserPreferences(): UserPreferencesContextValue {
  return useContext(UserPreferencesContext);
}
