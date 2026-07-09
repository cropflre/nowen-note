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

/**
 * 用户级 UI 偏好（per-user, synced）
 *
 * 与 useSiteSettings 的区别：
 *   - useSiteSettings  → 站点级配置（site_title / favicon / 字体），走后端 API，
 *     全站共享，**只有管理员能改**；
 *   - useUserPreferences（本 hook）→ 当前用户的私人偏好，优先同步到后端，
 *     localStorage 仅作为启动缓存和离线兜底。
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

/** 阅读密度：影响编辑器正文段落与列表项的纵向间距/行高。
 *   - "cozy"   ：默认宽松（保持历史观感）
 *   - "compact"：紧凑——减少 ~30% 纵向空间，长笔记翻屏更省力
 * 仅影响 .ProseMirror 下的 p / li，不动标题/代码块/表格，避免破坏视觉锚点。 */
export type ReadingDensity = "cozy" | "compact";
export type MarkdownViewMode = "source" | "preview" | "split";

export interface UserPreferences {
  /** 标签页/Electron 窗口标题是否跟随当前笔记标题（关闭则用站点名）。默认 false。 */
  noteTitleAsAppTitle: boolean;
  /** 进入任意笔记时大纲面板是否默认展开。默认 false。 */
  outlineDefaultOpen: boolean;
  /** 进入任意笔记时是否默认进入"视图层只读"。默认 false。
   *  注意：这不会修改笔记自身的 isLocked 字段，只影响本会话该笔记的编辑权限。 */
  lockOnOpen: boolean;
  /** 笔记本目录是否在展开节点下显示直属笔记。默认 false。 */
  showNotesInNotebookTree: boolean;
  /** 阅读密度（cozy/compact）。默认 cozy，即与历史一致的宽松排版。 */
  readingDensity: ReadingDensity;
  /** 笔记列表是否显示更新时间。默认 true。 */
  showNoteListUpdatedTime: boolean;
  /** 是否启用编辑区顶部多笔记标签页。默认 false。 */
  enableNoteTabs: boolean;
  /** Markdown 笔记默认打开视图。默认 source，保持历史行为。 */
  markdownDefaultViewMode: MarkdownViewMode;
}

const DEFAULT_PREFS: UserPreferences = {
  noteTitleAsAppTitle: false,
  outlineDefaultOpen: false,
  lockOnOpen: false,
  showNotesInNotebookTree: false,
  readingDensity: "cozy",
  showNoteListUpdatedTime: true,
  enableNoteTabs: false,
  markdownDefaultViewMode: "source",
};

function normalizeUserPreferences(parsed: Partial<UserPreferences>): UserPreferences {
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
    showNotesInNotebookTree: typeof parsed.showNotesInNotebookTree === "boolean"
      ? parsed.showNotesInNotebookTree
      : DEFAULT_PREFS.showNotesInNotebookTree,
    readingDensity: parsed.readingDensity === "compact" || parsed.readingDensity === "cozy"
      ? parsed.readingDensity
      : DEFAULT_PREFS.readingDensity,
    showNoteListUpdatedTime: typeof parsed.showNoteListUpdatedTime === "boolean"
      ? parsed.showNoteListUpdatedTime
      : (localStorage.getItem("nowen.noteList.showTime") !== null
        ? localStorage.getItem("nowen.noteList.showTime") === "true"
        : DEFAULT_PREFS.showNoteListUpdatedTime),
    enableNoteTabs: typeof parsed.enableNoteTabs === "boolean"
      ? parsed.enableNoteTabs
      : DEFAULT_PREFS.enableNoteTabs,
    markdownDefaultViewMode:
      parsed.markdownDefaultViewMode === "source" ||
      parsed.markdownDefaultViewMode === "preview" ||
      parsed.markdownDefaultViewMode === "split"
        ? parsed.markdownDefaultViewMode
        : DEFAULT_PREFS.markdownDefaultViewMode,
  };
}

function readFromStorage(): UserPreferences {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_PREFS;
    const parsed = JSON.parse(raw) as Partial<UserPreferences>;
    // 字段做白名单 + 类型校验，防止旧版本 / 手改 localStorage 把布尔变成字符串
    return normalizeUserPreferences(parsed);
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
  const prefsRef = useRef(prefs);

  useEffect(() => {
    prefsRef.current = prefs;
  }, [prefs]);

  // 阅读密度作用到全局：通过 body class 触发 CSS 变量切换，从而影响 .ProseMirror p/li 的间距。
  // 放在 Provider 而非具体组件里，是因为编辑器并不一定挂载（设置弹窗也要能预览到效果）。
  useEffect(() => {
    const cls = "density-compact";
    if (prefs.readingDensity === "compact") {
      document.body.classList.add(cls);
    } else {
      document.body.classList.remove(cls);
    }
  }, [prefs.readingDensity]);

  // 多标签页 / 多窗口同步：监听 storage 事件，让另一个 tab 改了开关后这个 tab 也跟上。
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY) return;
      setPrefs(readFromStorage());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const syncFromServer = useCallback(async () => {
    try {
      if (!localStorage.getItem("nowen-token")) return;
      const remote = await api.getUserPreferences();
      const remotePrefs = normalizeUserPreferences(remote);

      if (remote.hasPreferences) {
        setPrefs(remotePrefs);
        writeToStorage(remotePrefs);
        return;
      }

      // 旧版本的开关只存在当前浏览器。服务器还没有记录时，先把本地值迁移上去。
      await api.updateUserPreferences(prefsRef.current);
    } catch {
      // 未登录、离线或旧后端时保留 localStorage 行为，避免设置页不可用。
    }
  }, []);

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
    setPrefs((prev) => {
      if (prev[key] === value) return prev;
      const next = { ...prev, [key]: value };
      writeToStorage(next);
      if (localStorage.getItem("nowen-token")) {
        api.updateUserPreferences(next).catch(() => {
          // 网络失败不回滚 UI；localStorage 仍作为离线兜底。
        });
      }
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
