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
  LEGACY_CODE_BLOCK_THEME_KEY,
  LEGACY_EDITOR_MODE_KEY,
  LEGACY_NOTE_LIST_TITLE_ONLY_KEY,
  accountPreferenceStorageKey,
  claimLegacyUserPreferences,
  decodeUserIdFromToken,
  mergePendingPreferences,
  normalizeUserPreferences,
  readAccountPreferenceCache,
  sanitizeUserPreferencePatch,
  writeAccountPreferenceCache,
  type CodeBlockThemeId,
  type EditorMode,
  type UserPreferenceCache,
  type UserPreferencePatch,
  type UserPreferences,
} from "@/lib/userPreferenceAccountCache";

export type {
  CodeBlockThemeId,
  EditorMode,
  MarkdownViewMode,
  ReadingDensity,
  UserPreferences,
} from "@/lib/userPreferenceAccountCache";

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

function applyLegacyPreferenceBridges(prefs: UserPreferences, notify = true): void {
  try {
    localStorage.setItem(LEGACY_EDITOR_MODE_KEY, prefs.defaultEditorMode);
    localStorage.setItem(LEGACY_CODE_BLOCK_THEME_KEY, prefs.codeBlockTheme);
    localStorage.setItem(LEGACY_NOTE_LIST_TITLE_ONLY_KEY, String(prefs.noteListTitleOnly));
    document.documentElement.setAttribute("data-code-theme", prefs.codeBlockTheme);
    if (!notify) return;
    window.dispatchEvent(new CustomEvent<EditorMode>("nowen:editor-mode-change", {
      detail: prefs.defaultEditorMode,
    }));
    window.dispatchEvent(new CustomEvent<CodeBlockThemeId>("nowen:codeblock-theme-change", {
      detail: prefs.codeBlockTheme,
    }));
    window.dispatchEvent(new CustomEvent<boolean>("nowen:note-list-title-only-change", {
      detail: prefs.noteListTitleOnly,
    }));
  } catch {
    // localStorage / document 在隐私模式或测试环境不可用时，账号偏好内存态仍然有效。
  }
}

function initialPreferences(): UserPreferences {
  const identity = currentIdentity();
  if (!identity) return DEFAULT_USER_PREFERENCES;
  const prefs = readAccountPreferenceCache(localStorage, identity.userId)?.prefs || DEFAULT_USER_PREFERENCES;
  applyLegacyPreferenceBridges(prefs, false);
  return prefs;
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

  // 兼容已经存在的编辑器模式、代码块主题和标题列表模块。它们继续使用原来的
  // localStorage key，但值由账号偏好回填；用户在旧入口修改时由下方事件监听反向同步。
  useEffect(() => {
    applyLegacyPreferenceBridges(prefs);
  }, [prefs.defaultEditorMode, prefs.codeBlockTheme, prefs.noteListTitleOnly]);

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
      applyLegacyPreferenceBridges(DEFAULT_USER_PREFERENCES);
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

      const remoteRevision = Number(remote.revision) || 0;
      // 并发保存可能乱序返回。旧 revision 只能确认对应 pending 已送达，不能再用
      // 旧响应的整包值覆盖较新的本地缓存。
      const responseIsStale = remoteRevision < latestCache.revision;
      const basePrefs = responseIsStale
        ? latestCache.prefs
        : normalizeUserPreferences(remote);
      const merged = mergePendingPreferences(basePrefs, pending);
      applyCache({
        version: 2,
        userId,
        prefs: merged,
        revision: Math.max(latestCache.revision, remoteRevision),
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
          revision: Math.max(latestCache?.revision || 0, Number(remote.revision) || 0),
          pending: latestPending,
        });
        if (Object.keys(latestPending).length > 0) {
          void persistPatch(userId, latestPending);
        }
        return;
      }

      // 首次升级：优先使用启动时已经存在的当前账号 v2 缓存；没有时才认领一次
      // 旧版全局缓存。resetForIdentity 创建的默认空缓存不能抢占旧缓存迁移来源。
      const legacy = cachedAtStart ? null : claimLegacyUserPreferences(localStorage, userId);
      const seed = cachedAtStart?.prefs || legacy || latestCache?.prefs || DEFAULT_USER_PREFERENCES;
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
      if (cache && cache.revision >= revisionRef.current) applyCache(cache);
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

  // 旧入口反向桥接：不改它们的 UI 结构，只把用户操作转换成账号级偏好字段。
  useEffect(() => {
    const onEditorMode = (event: Event) => {
      const mode = (event as CustomEvent<EditorMode>).detail;
      if (mode === "md" || mode === "tiptap") setPref("defaultEditorMode", mode);
    };
    const onCodeTheme = (event: Event) => {
      const theme = (event as CustomEvent<CodeBlockThemeId>).detail;
      if (theme) setPref("codeBlockTheme", theme);
    };
    const onTitleOnly = (event: Event) => {
      const enabled = (event as CustomEvent<boolean>).detail;
      if (typeof enabled === "boolean") setPref("noteListTitleOnly", enabled);
    };
    window.addEventListener("nowen:editor-mode-change", onEditorMode);
    window.addEventListener("nowen:codeblock-theme-change", onCodeTheme);
    window.addEventListener("nowen:note-list-title-only-change", onTitleOnly);
    return () => {
      window.removeEventListener("nowen:editor-mode-change", onEditorMode);
      window.removeEventListener("nowen:codeblock-theme-change", onCodeTheme);
      window.removeEventListener("nowen:note-list-title-only-change", onTitleOnly);
    };
  }, [setPref]);

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
