import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

/**
 * 用户级 UI 偏好（per-device, per-browser）
 *
 * 与 useSiteSettings 的区别：
 *   - useSiteSettings  → 站点级配置（site_title / favicon / 字体），走后端 API，
 *     全站共享，**只有管理员能改**；
 *   - useUserPreferences（本 hook）→ 当前浏览器/设备的私人偏好，仅 localStorage，
 *     不入库、不同步、**每个用户在每台设备各自独立**。
 *
 * 这里收纳的是"看起来该跟用户走，但又不该污染笔记数据本身"的开关，例如：
 *   - 标签页/窗口标题是显示笔记标题还是软件名；
 *   - 进入笔记后大纲面板默认开/关；
 *   - 进入笔记后是否进入"视图层只读"（不改库 isLocked，仅本会话只读）。
 *
 * 设计选择：
 *   - 单例 Provider + Context，避免每个组件各自 useState 导致跨组件不同步。
 *   - 持久化失败（隐身模式 / 配额满）静默回退到内存态，UI 仍可用。
 *   - 字段类型显式 boolean，不用 unknown JSON——以后加新字段就在这里加 key。
 */

const STORAGE_KEY = "nowen.user-prefs.v1";

export interface UserPreferences {
  /** 标签页/Electron 窗口标题是否跟随当前笔记标题（关闭则用站点名）。默认 false。 */
  noteTitleAsAppTitle: boolean;
  /** 进入任意笔记时大纲面板是否默认展开。默认 false。 */
  outlineDefaultOpen: boolean;
  /** 进入任意笔记时是否默认进入"视图层只读"。默认 false。
   *  注意：这不会修改笔记自身的 isLocked 字段，只影响本会话该笔记的编辑权限。 */
  lockOnOpen: boolean;
}

const DEFAULT_PREFS: UserPreferences = {
  noteTitleAsAppTitle: false,
  outlineDefaultOpen: false,
  lockOnOpen: false,
};

function readFromStorage(): UserPreferences {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_PREFS;
    const parsed = JSON.parse(raw) as Partial<UserPreferences>;
    // 字段做白名单 + 类型校验，防止旧版本 / 手改 localStorage 把布尔变成字符串
    return {
      noteTitleAsAppTitle: typeof parsed.noteTitleAsAppTitle === "boolean"
        ? parsed.noteTitleAsAppTitle
        : DEFAULT_PREFS.noteTitleAsAppTitle,
      outlineDefaultOpen: typeof parsed.outlineDefaultOpen === "boolean"
        ? parsed.outlineDefaultOpen
        : DEFAULT_PREFS.outlineDefaultOpen,
      lockOnOpen: typeof parsed.lockOnOpen === "boolean"
        ? parsed.lockOnOpen
        : DEFAULT_PREFS.lockOnOpen,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

function writeToStorage(prefs: UserPreferences): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // 隐身模式 / quota exceeded 时静默丢弃；UI 仍能正常运行（只是下次启动复位）
  }
}

interface UserPreferencesContextValue {
  prefs: UserPreferences;
  setPref: <K extends keyof UserPreferences>(key: K, value: UserPreferences[K]) => void;
}

const UserPreferencesContext = createContext<UserPreferencesContextValue>({
  prefs: DEFAULT_PREFS,
  setPref: () => {},
});

export function UserPreferencesProvider({ children }: { children: React.ReactNode }) {
  const [prefs, setPrefs] = useState<UserPreferences>(() => readFromStorage());

  // 多标签页 / 多窗口同步：监听 storage 事件，让另一个 tab 改了开关后这个 tab 也跟上。
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY) return;
      setPrefs(readFromStorage());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const setPref = useCallback(<K extends keyof UserPreferences>(key: K, value: UserPreferences[K]) => {
    setPrefs((prev) => {
      if (prev[key] === value) return prev;
      const next = { ...prev, [key]: value };
      writeToStorage(next);
      return next;
    });
  }, []);

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
