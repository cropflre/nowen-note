import React, { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Menu, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import Sidebar from "@/components/Sidebar";
import NavRail from "@/components/NavRail";
import { useRailMode } from "@/hooks/useRailMode";
import NoteList from "@/components/NoteList";
import EditorPane from "@/components/EditorPane";
import TaskCenter from "@/components/TaskCenter";
import MindMapCenter from "@/components/MindMapEditor";
import AIChatPanel from "@/components/AIChatPanel";
import DiaryCenter from "@/components/DiaryCenter";
import FileManager from "@/components/FileManager";
import SharedNoteView from "@/components/SharedNoteView";
import LoginPage from "@/components/LoginPage";
import QuickLoginGate from "@/components/QuickLoginGate";
import QuickLoginEnrollDialog from "@/components/QuickLoginEnrollDialog";
import WhatsNewModal, { useWhatsNew } from "@/components/WhatsNewModal";
import { AppProvider, useApp, useAppActions, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH, DEFAULT_SIDEBAR_WIDTH, MIN_NOTELIST_WIDTH, MAX_NOTELIST_WIDTH, DEFAULT_NOTELIST_WIDTH } from "@/store/AppContext";
import { ThemeProvider } from "@/components/ThemeProvider";
import { SiteSettingsProvider, useSiteSettings } from "@/hooks/useSiteSettings";
import { UserPreferencesProvider, useUserPreferences } from "@/hooks/useUserPreferences";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ConfirmProvider } from "@/components/ui/confirm";
import Toaster from "@/components/Toaster";
import { User } from "@/types";
import { getServerUrl, clearServerUrl, broadcastLogout } from "@/lib/api";
import { bootstrap as syncBootstrap, teardown as syncTeardown } from "@/lib/syncEngine";
import { useBackButton, hideSplashScreen, useStatusBarSync, useKeyboardLayout, isNativePlatform } from "@/hooks/useCapacitor";
import { useDesktopMenuBridge } from "@/hooks/useDesktopMenuBridge";
import CommandPalette from "@/components/common/CommandPalette";
import OfflineIndicator from "@/components/common/OfflineIndicator";
import UpdateNotifier from "@/components/common/UpdateNotifier";

const AUTH_USER_CACHE_PREFIX = "nowen-auth-user:";

function normalizeAuthUrl(url: string): string {
  return url.replace(/\/+$/, "").toLowerCase();
}

function isLoopbackAuthUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "::1";
  } catch {
    return false;
  }
}

function getAuthCacheScope(serverUrl: string): string {
  const origin = typeof window !== "undefined" && window.location.origin.startsWith("http")
    ? window.location.origin
    : "";
  const isDesktop = typeof window !== "undefined" && !!(window as any).nowenDesktop?.isDesktop;
  if (isDesktop && ((serverUrl && isLoopbackAuthUrl(serverUrl)) || (!serverUrl && origin && isLoopbackAuthUrl(origin)))) {
    return "local-desktop";
  }
  if (serverUrl) return normalizeAuthUrl(serverUrl);
  if (origin) return normalizeAuthUrl(origin);
  return "same-origin";
}

function getAuthUserCacheKey(scope: string): string {
  return `${AUTH_USER_CACHE_PREFIX}${scope}`;
}

function decodeUserFromToken(token: string): User | null {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const json = decodeURIComponent(
      Array.from(atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=")))
        .map((c) => `%${c.charCodeAt(0).toString(16).padStart(2, "0")}`)
        .join("")
    );
    const data = JSON.parse(json) as { userId?: string; username?: string };
    if (!data.userId || !data.username) return null;
    return {
      id: data.userId,
      username: data.username,
      email: null,
      avatarUrl: null,
      displayName: data.username,
      createdAt: new Date(0).toISOString(),
    };
  } catch {
    return null;
  }
}

function saveCachedAuthUser(scope: string, token: string, user: User): void {
  try {
    localStorage.setItem(
      getAuthUserCacheKey(scope),
      JSON.stringify({ token, user, cachedAt: Date.now() }),
    );
  } catch { /* ignore */ }
}

function loadCachedAuthUser(scope: string, token: string): User | null {
  try {
    const raw = localStorage.getItem(getAuthUserCacheKey(scope));
    if (raw) {
      const cached = JSON.parse(raw) as { token?: string; user?: User };
      const decoded = decodeUserFromToken(token);
      if (cached.user?.id && (cached.token === token || cached.user.id === decoded?.id)) {
        return cached.user;
      }
    }
  } catch { /* ignore */ }
  return decodeUserFromToken(token);
}

function isVerifyNetworkFailure(err: any): boolean {
  return err?.networkLike === true
    || err?.name === "AbortError"
    || err instanceof TypeError;
}

function isNativeClientRuntime(): boolean {
  return !!(window as any).nowenDesktop?.isDesktop
    || !!(window as any).Capacitor?.isNativePlatform?.()
    || (!!(window as any).Capacitor?.platform && (window as any).Capacitor.platform !== "web");
}

async function fetchWebUiEnabled(): Promise<boolean> {
  try {
    const baseUrl = getServerUrl() ? `${getServerUrl()}/api` : "/api";
    const res = await fetch(`${baseUrl}/settings`, { cache: "no-store" });
    if (!res.ok) return true;
    const data = await res.json().catch(() => ({}));
    return data?.web_ui_enabled !== "false";
  } catch {
    // 网络/后端异常时不做前端自锁，避免误伤本地开发和临时故障恢复。
    return true;
  }
}

function WebUiDisabledPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-zinc-50 px-6 text-center text-zinc-600">
      <main className="max-w-lg rounded-2xl border border-zinc-200 bg-white p-8 shadow-sm">
        <h1 className="text-xl font-semibold text-zinc-900 mb-3">网页端已被管理员关闭</h1>
        <p className="text-sm leading-7">
          当前服务器仅提供 API 服务。请使用 Nowen Note 桌面客户端连接该服务器。
        </p>
      </main>
    </div>
  );
}

function SidebarResizeHandle() {
  const { state } = useApp();
  const actions = useAppActions();
  const isDragging = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(0);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDragging.current = true;
    startX.current = e.clientX;
    startWidth.current = state.sidebarWidth;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const handleMouseMove = (ev: MouseEvent) => {
      if (!isDragging.current) return;
      const newWidth = startWidth.current + (ev.clientX - startX.current);
      actions.setSidebarWidth(Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, newWidth)));
    };

    const handleMouseUp = () => {
      isDragging.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
  }, [state.sidebarWidth, actions]);

  if (state.sidebarCollapsed) return null;

  return (
    <div
      onMouseDown={handleMouseDown}
      onDoubleClick={() => actions.setSidebarWidth(DEFAULT_SIDEBAR_WIDTH)}
      className="hidden md:flex w-1 cursor-col-resize items-center justify-center hover:bg-accent-primary/30 active:bg-accent-primary/50 transition-colors shrink-0 group"
      title="拖拽调整侧边栏宽度 / 双击恢复默认"
    >
      <div className="w-[2px] h-8 rounded-full bg-transparent group-hover:bg-accent-primary/60 transition-colors" />
    </div>
  );
}

function NoteListResizeHandle() {
  const { state } = useApp();
  const actions = useAppActions();
  const isDragging = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(0);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDragging.current = true;
    startX.current = e.clientX;
    startWidth.current = state.noteListWidth;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const handleMouseMove = (ev: MouseEvent) => {
      if (!isDragging.current) return;
      const newWidth = startWidth.current + (ev.clientX - startX.current);
      actions.setNoteListWidth(Math.max(MIN_NOTELIST_WIDTH, Math.min(MAX_NOTELIST_WIDTH, newWidth)));
    };

    const handleMouseUp = () => {
      isDragging.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
  }, [state.noteListWidth, actions]);

  // 笔记列表折叠后拖拽条也需同步隐藏，避免留下一根“孤儿拖柄”拖到空列。
  if (state.noteListCollapsed) return null;

  return (
    <div
      onMouseDown={handleMouseDown}
      onDoubleClick={() => actions.setNoteListWidth(DEFAULT_NOTELIST_WIDTH)}
      className="hidden md:flex w-1 cursor-col-resize items-center justify-center hover:bg-accent-primary/30 active:bg-accent-primary/50 transition-colors shrink-0 group"
    >
      <div className="w-[2px] h-8 rounded-full bg-transparent group-hover:bg-accent-primary/60 transition-colors" />
    </div>
  );
}

/**
 * P3: 侧边栏边缘滑动手势 Hook
 * 从屏幕左侧 30px 区域右滑打开侧边栏，侧边栏打开时左滑关闭
 *
 * 重要：本 hook 在 document 上挂全局 touchstart/touchend，触发的是 setMobileSidebar(false)。
 * 在移动端，用户从 Sidebar 进入 SettingsModal 时，Sidebar 仍处于 open 状态（关闭设置后
 * 还要回到 Sidebar），mobileSidebarOpen 为 true。此时只要 touchend 的 deltaX 超过阈值
 * 就会左滑关闭 Sidebar——而 SettingsModal 通过 createPortal 渲染到 body，但**生命周期
 * 仍挂在 Sidebar 子树**：Sidebar 卸载 = SettingsModal 卸载 = 设置弹窗"莫名消失"。
 *
 * 实测表现：用户在 SettingsModal 里"长按 / 滚动 / 横向触摸"时，touch 起止位移就足够触发
 * 该判定，弹窗瞬间被卸掉，看起来像"动一下就关"。React 合成事件的 stopPropagation
 * 拦不住 document 原生监听，必须在监听内部主动跳过。
 *
 * 修复：在 touchstart 时，沿事件 target 向上查找是否处于带 `[data-swipe-blocker]` 的子树。
 * 是则置 isSwiping=false，本次手势整段不参与 sidebar 开关判定。任何想屏蔽 sidebar 全局
 * 滑动手势的浮层（设置弹窗、未来的对话框等）只需在自身根节点加上这个 data 属性即可，
 * 不需要改 hook 也不需要污染全局 store。
 */
function useSwipeGesture({
  onSwipeRight,
  onSwipeLeft,
  mobileSidebarOpen,
}: {
  onSwipeRight: () => void;
  onSwipeLeft: () => void;
  mobileSidebarOpen: boolean;
}) {
  const touchStartX = useRef(0);
  const touchStartY = useRef(0);
  const isSwiping = useRef(false);

  useEffect(() => {
    // 仅在小屏幕（移动端）上启用手势
    const EDGE_THRESHOLD = 30; // 边缘检测区域宽度
    const SWIPE_MIN_DISTANCE = 60; // 最小滑动距离
    const SWIPE_MAX_Y_RATIO = 0.6; // y 偏移不超过 x 偏移的 60%

    // 触摸起点是否落在"屏蔽该手势"的浮层内。
    // 用 closest 走 DOM 树而非比较具体节点，能兼容 portal 渲染的浮层（document.body 直挂）。
    const isInsideSwipeBlocker = (target: EventTarget | null): boolean => {
      if (!(target instanceof Element)) return false;
      return target.closest("[data-swipe-blocker]") !== null;
    };

    const handleTouchStart = (e: TouchEvent) => {
      const touch = e.touches[0];
      touchStartX.current = touch.clientX;
      touchStartY.current = touch.clientY;
      // 起点在屏蔽层内：本次手势全程禁用，避免误关 Sidebar 顺带卸掉浮层。
      if (isInsideSwipeBlocker(e.target)) {
        isSwiping.current = false;
        return;
      }
      // 仅在左边缘区域或侧边栏已打开时激活
      isSwiping.current = touch.clientX <= EDGE_THRESHOLD || mobileSidebarOpen;
    };

    const handleTouchEnd = (e: TouchEvent) => {
      if (!isSwiping.current) return;
      const touch = e.changedTouches[0];
      const deltaX = touch.clientX - touchStartX.current;
      const deltaY = Math.abs(touch.clientY - touchStartY.current);

      // 确保是水平滑动而非垂直滑动
      if (deltaY > Math.abs(deltaX) * SWIPE_MAX_Y_RATIO) return;

      if (deltaX > SWIPE_MIN_DISTANCE && touchStartX.current <= EDGE_THRESHOLD && !mobileSidebarOpen) {
        onSwipeRight();
      } else if (deltaX < -SWIPE_MIN_DISTANCE && mobileSidebarOpen) {
        onSwipeLeft();
      }

      isSwiping.current = false;
    };

    document.addEventListener("touchstart", handleTouchStart, { passive: true });
    document.addEventListener("touchend", handleTouchEnd, { passive: true });

    return () => {
      document.removeEventListener("touchstart", handleTouchStart);
      document.removeEventListener("touchend", handleTouchEnd);
    };
  }, [mobileSidebarOpen, onSwipeRight, onSwipeLeft]);
}

function AppLayout() {
  const { state } = useApp();
  const actions = useAppActions();
  const { t } = useTranslation();
  // v16 P3 后续：Rail 视觉模式三档（icon / label / hidden）。
  // 约束：主侧栏折叠时强制显示 Rail（即便偏好是 hidden），
  // 否则用户会陷入"既无 Rail 又无主侧栏"的死局，找不到任何导航入口。
  const [railMode] = useRailMode();
  const railVisible = railMode !== "hidden" || state.sidebarCollapsed;
  const isTaskView = state.viewMode === "tasks";
  const isMindMapView = state.viewMode === "mindmaps";
  const isAIChatView = state.viewMode === "ai-chat";
  const isDiaryView = state.viewMode === "diary";
  const isFilesView = state.viewMode === "files";

  /**
   * Cmd-K 全局搜索面板开关
   * ----------------------------------------------------------------
   * 三种来源：
   *   1) 组件内部 Cmd-K 键盘事件自己派发 "nowen:open-command-palette"；
   *   2) macOS 原生菜单 "搜索笔记…" / Dock 右键 → useDesktopMenuBridge.onOpenSearch；
   *   3) 未来若需要业务代码编程式打开，同样 dispatch 上述事件即可。
   * 统一从外部事件驱动 setOpen(true)，组件只负责展示 + Esc 关闭。
   */
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  useEffect(() => {
    const onOpen = () => setCommandPaletteOpen(true);
    window.addEventListener("nowen:open-command-palette", onOpen);
    return () => window.removeEventListener("nowen:open-command-palette", onOpen);
  }, []);

  // 离线队列入队事件 → 把 syncStatus 切到 "queued"（让 UI 展示"已暂存"而非"已同步"）
  useEffect(() => {
    const onQueued = () => {
      actions.setSyncStatus("queued");
    };
    window.addEventListener("nowen:offline-queued", onQueued);
    return () => window.removeEventListener("nowen:offline-queued", onQueued);
  }, [actions]);


  // P0: Android 返回键处理
  const handleBackToList = useCallback(() => {
    actions.setMobileView("list");
  }, [actions]);
  const handleCloseSidebar = useCallback(() => {
    actions.setMobileSidebar(false);
  }, [actions]);

  useBackButton({
    mobileView: state.mobileView,
    mobileSidebarOpen: state.mobileSidebarOpen,
    onBackToList: handleBackToList,
    onCloseSidebar: handleCloseSidebar,
  });

  // P2: 状态栏与主题同步
  useStatusBarSync();

  // 标签页/Electron 窗口标题同步：
  //   关闭"标题跟随笔记标题"开关 → 沿用 useSiteSettings 设置的站点名（默认行为）；
  //   开启时 → 标题改为 "笔记标题 - 站点名"，没选中笔记则回退站点名。
  // 之所以放在 AppLayout 而不是 useSiteSettings：noteTitleAsAppTitle 依赖
  // AppContext.activeNote，而 AppContext 是在 AuthGate → AppProvider 之后才挂的，
  // useSiteSettings 是分享页/登录页等更外层场景也会用到的更基础 Provider。
  const { siteConfig } = useSiteSettings();
  const { prefs: userPrefs } = useUserPreferences();
  useEffect(() => {
    const baseTitle = siteConfig.title || "nowen-note";
    if (userPrefs.noteTitleAsAppTitle) {
      const noteTitle = (state.activeNote?.title || "").trim();
      document.title = noteTitle ? `${noteTitle} - ${baseTitle}` : baseTitle;
    } else {
      document.title = baseTitle;
    }
  }, [siteConfig.title, userPrefs.noteTitleAsAppTitle, state.activeNote?.id, state.activeNote?.title]);


  // P5: 键盘弹出布局适配
  useKeyboardLayout();

  // P3: 侧边栏边缘滑动手势
  const handleSwipeOpen = useCallback(() => {
    actions.setMobileSidebar(true);
  }, [actions]);

  useSwipeGesture({
    onSwipeRight: handleSwipeOpen,
    onSwipeLeft: handleCloseSidebar,
    mobileSidebarOpen: state.mobileSidebarOpen,
  });

  // Alt+N 全局快捷键 / 桌面端菜单"新建笔记"共用同一入口
  const quickCreateNote = useCallback(async () => {
    const { toast } = await import("@/lib/toast");
    // 无笔记本时给出提示
    if (state.notebooks.length === 0) {
      toast.warning(t('common.needNotebookFirst'));
      return;
    }
    // 优先使用当前选中的笔记本，否则取第一个笔记本
    const notebookId = state.selectedNotebookId || state.notebooks[0]?.id;
    if (!notebookId) {
      toast.warning(t('common.needNotebookFirst'));
      return;
    }
    try {
      const { api } = await import("@/lib/api");
      const note = await api.createNote({ notebookId, title: t('common.untitledNote') });
      actions.setActiveNote(note);
      actions.setSelectedNotebook(notebookId);
      actions.setViewMode("notebook");
      actions.setMobileView("editor");
      actions.refreshNotebooks();
    } catch (err: any) {
      console.error("Quick create note failed:", err);
      toast.error(err?.message || t('noteList.createFailed'));
    }
  }, [state.selectedNotebookId, state.notebooks, actions, t]);

  // Alt+N 全局快捷键：快速新建笔记
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.altKey && e.key.toLowerCase() === "n") {
        e.preventDefault();
        void quickCreateNote();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [quickCreateNote]);

  // ── 工作区切换：清空当前会话态，回到空态页 ──────────────────────────
  //
  // WorkspaceSwitcher 切换后会广播 "nowen:workspace-changed"。之前只有 Sidebar /
  // TaskCenter / FileManager / DiaryCenter / MindMap 自己监听并各自重拉，但
  // App 顶层并没有清理"正在编辑的笔记 + 笔记列表 + 选择/筛选状态"——于是会
  // 出现两类问题：
  //   1) 切到 A 空间后，右侧仍显示着 B 空间的 activeNote，且该笔记被 B 空间
  //      的权限/归属保护，任何保存操作都可能落到错误的上下文里；
  //   2) 上一次选中的 notebookId / tagId 仍在 state 中，下一次"快速新建"会
  //      把新笔记塞到不属于当前空间的笔记本里（后端已拒，但 UX 很糟）。
  //
  // 切换工作区是一次强隔离事件，正确的交互是：**回到"选择一条笔记开始编辑
  // / Alt+N 快速新建"空态页**。因此这里统一做：
  //   - activeNote = null      → EditorPane 渲染空态
  //   - notes = []             → 避免旧空间的列表残留（后续 refresh 会填）
  //   - selectedNotebookId/Tag = null
  //   - viewMode = "all"       → 回到"所有笔记"默认视图
  //   - mobileView = "list"    → 移动端从编辑页退回列表页
  //   - searchQuery = ""       → 搜索词也一并清掉，避免跨空间的语义错位
  //   - refreshNotes/Notebooks → 触发重拉，让 Sidebar/NoteList 拿到新空间数据
  //
  // 注：notebooks/tags 本身由 Sidebar 监听同一事件重拉，这里不重复；但我们
  //     显式调用 refreshNotebooks 以统一触发一次订阅刷新，保持一致性。
  useEffect(() => {
    const onWorkspaceChanged = () => {
      actions.setActiveNote(null);
      actions.setNotes([]);
      actions.setSelectedNotebook(null);
      actions.setSelectedTag(null);
      actions.setViewMode("all");
      actions.setMobileView("list");
      actions.setSearchQuery("");
      actions.refreshNotes();
      actions.refreshNotebooks();
    };
    window.addEventListener("nowen:workspace-changed", onWorkspaceChanged);
    return () => window.removeEventListener("nowen:workspace-changed", onWorkspaceChanged);
  }, [actions]);

  // Electron 桌面端：菜单 / 托盘动作 IPC 桥
  useDesktopMenuBridge({
    onNewNote: () => void quickCreateNote(),
    onToggleSidebar: () => actions.toggleSidebar(),
    /**
     * 原生"搜索"菜单 / Dock Quick Action → 打开 Cmd-K 命令面板。
     * 相比过去聚焦 Sidebar 搜索框的方案，命令面板是"即用即走"语义，
     * 不污染当前 viewMode，也与 Cmd-K 键盘入口完全统一。
     */
    onOpenSearch: () => setCommandPaletteOpen(true),
  });

  return (
    <div className="flex h-[100dvh] w-screen bg-app-bg overflow-hidden transition-colors duration-200">
      {/* ===== 移动端：抽屉式侧边栏 =====
          v16 P3 后续：与桌面端对齐，抽屉内部也拆成 NavRail + Sidebar 双栏。
          - NavRail variant="mobile"：48/64px，顶部含关闭 X 与图标/文字模式切换；
                                       不接受 hidden 模式（抽屉里没意义）。
          - Sidebar variant="mobile"：主区只渲染 WorkspaceSwitcher + 搜索 + 笔记本 + 标签。
          抽屉总宽 max-w 从 340 → 380：Rail 约占 48-64px，主区保持 ~320px 与改造前持平。 */}
      <AnimatePresence>
        {state.mobileSidebarOpen && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => actions.setMobileSidebar(false)}
              className="fixed inset-0 z-40 bg-zinc-900/60 backdrop-blur-sm md:hidden"
            />
            <motion.div
              initial={{ x: "-100%" }}
              animate={{ x: 0 }}
              exit={{ x: "-100%" }}
              transition={{ type: "spring", bounce: 0, duration: 0.35 }}
              className="fixed inset-y-0 left-0 z-50 w-[88%] max-w-[380px] md:hidden shadow-2xl flex"
              // 底部避让 home indicator / 手势栏：抽屉容器统一处理，
              // 内部 NavRail / Sidebar 不再各自加 safe-area-bottom，避免重复 padding。
              // 顶部状态栏避让仍由 NavRail / Sidebar Header 各自的 paddingTop 处理
              // （桌面端两者也复用，写在子组件里更通用）。
              style={{ paddingBottom: 'var(--safe-area-bottom)' }}
            >
              <NavRail variant="mobile" />
              <div className="flex-1 min-w-0">
                <Sidebar />
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* ===== 桌面端：永久 Rail + 可折叠主侧栏 + 拖拽条 =====
          v16 P3：左侧 Rail 永久可见（含模块切换 + 设置/登出 + 折叠按钮）；
          主侧栏（笔记本 + 标签）由 sidebarCollapsed 控制显隐——折叠时主侧栏整块消失，
          但 Rail 仍在，模块切换永远 1 次点击可达。
          v16 P3 后续：Rail 三档模式（icon=48px 纯图标 / label=64px 图标+文字 / hidden=完全隐藏）；
          hidden 模式下若主侧栏也折叠，强制保留 Rail（避免完全无侧栏入口）。 */}
      {railVisible && <NavRail />}
      {!state.sidebarCollapsed && (
        <div
          className="hidden md:flex shrink-0"
          style={{ width: `${state.sidebarWidth}px` }}
        >
          <Sidebar variant="desktop" />
        </div>
      )}
      <SidebarResizeHandle />

      {/* ===== 主内容区 ===== */}
      {isTaskView ? (
        <div className="flex-1 flex flex-col">
          {/* 移动端顶栏 */}
          <MobileTopBar />
          <TaskCenter />
        </div>
      ) : isMindMapView ? (
        <div className="flex-1 flex flex-col">
          <MobileTopBar />
          <MindMapCenter />
        </div>
      ) : isAIChatView ? (
        <div className="flex-1 flex flex-col">
          <MobileTopBar />
          <AIChatPanel
            onClose={() => actions.setViewMode("all")}
            onNavigateToNote={async (noteId) => {
              try {
                const { api } = await import("@/lib/api");
                const note = await api.getNote(noteId);
                if (note) {
                  actions.setActiveNote(note);
                  actions.setViewMode("all");
                  actions.setMobileView("editor");
                }
              } catch (err) {
                console.error("Navigate to note failed:", err);
              }
            }}
          />
        </div>
      ) : isDiaryView ? (
        <div className="flex-1 flex flex-col">
          <MobileTopBar />
          <DiaryCenter />
        </div>
      ) : isFilesView ? (
        <div className="flex-1 flex flex-col">
          <MobileTopBar />
          <FileManager />
        </div>
      ) : (
        <div className="flex-1 flex relative overflow-hidden">
          {/* 笔记列表 — 桌面端动态宽度，移动端全宽。
              桌面端 noteListCollapsed = true 时整列不渲染（让编辑器占满）；
              移动端不受该状态影响（本来就是 list/editor 单栏切换）。 */}
          <div
            className={`
              flex flex-col shrink-0 h-full
              max-md:!w-full
              ${state.noteListCollapsed ? "max-md:flex md:hidden" : ""}
              ${state.mobileView === "list" ? "flex" : "hidden md:flex"}
            `}
            style={{ width: `${state.noteListWidth}px` }}
          >
            <NoteList />
          </div>

          {/* 拖拽分割条 */}
          <NoteListResizeHandle />

          {/* 编辑器 — 移动端全屏覆盖 */}
          <div className={`
            absolute inset-0 z-20 md:static md:z-auto md:flex-1 flex flex-col min-w-0
            ${state.mobileView === "editor" ? "flex" : "hidden md:flex"}
          `}>
            <EditorPane />
          </div>
        </div>
      )}

      {/* 全局命令面板（Cmd-K / 菜单搜索 / Dock 搜索统一入口） */}
      <CommandPalette
        open={commandPaletteOpen}
        onClose={() => setCommandPaletteOpen(false)}
      />

      {/* 离线状态 + 待同步指示器 */}
      <OfflineIndicator />

      {/* 服务端版本升级提示（前端 bundle 与服务端不一致时） */}
      <UpdateNotifier />
    </div>
  );
}

function MobileTopBar() {
  const actions = useAppActions();
  const { siteConfig } = useSiteSettings();
  return (
    <header className="flex items-center px-4 py-3 border-b border-app-border bg-app-surface/50 md:hidden" style={{ paddingTop: 'calc(var(--safe-area-top) + 4px)' }}>
      <button
        onClick={() => actions.setMobileSidebar(true)}
        className="p-2 -ml-2 rounded-lg text-tx-secondary hover:bg-app-hover active:bg-app-active"
      >
        <Menu size={24} />
      </button>
      <span className="ml-3 text-sm font-semibold text-tx-primary">{siteConfig.title}</span>
    </header>
  );
}

function AuthGate() {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null);
  const [user, setUser] = useState<User | null>(null);
  // Phase 7: 快速登录（生物识别）网关 —— 在客户端模式下、isAuthenticated=false
  // 时优先尝试用 Keystore 中的 token + 指纹/人脸完成无密码登录。
  //   "pending"：刚确认未登录，正交给 QuickLoginGate 决定是否唤起
  //   "skipped" / null：QuickLoginGate 决定不展示（不支持 / 未启用 / 已尝试过）
  //                    或用户取消，UI 应渲染 LoginPage 让用户输密码
  const [quickLoginState, setQuickLoginState] = useState<"pending" | "skipped">("pending");
  const { t } = useTranslation();

  // P1: Splash Screen — 应用就绪后隐藏启动屏（必须在条件返回之前调用）
  useEffect(() => {
    if (isAuthenticated !== null) {
      hideSplashScreen();
    }
  }, [isAuthenticated]);

  // 判断是否为客户端模式（Electron / Android / 曾配置过服务器地址）
  //
  // Electron 打包后窗口加载的是 http://127.0.0.1:<port>/，protocol 是 "http:" 而非 "file:"，
  // 所以不能只靠 protocol 判断。preload 会注入 window.nowenDesktop.isDesktop=true，
  // 用它精确识别 Electron 桌面端 —— 同一个 Electron 窗口既能连"内置 backend"（localhost）
  // 也能连"远程服务器"（填 IP + 端口），登录页会展示服务器地址输入框。
  const isCapacitor = !!(window as any).Capacitor?.isNativePlatform?.()
    || !!(window as any).Capacitor?.platform && (window as any).Capacitor.platform !== "web";
  const isElectron = !!(window as any).nowenDesktop?.isDesktop;
  const isClientMode = window.location.protocol === "file:"
    || window.location.protocol === "capacitor:"
    || isCapacitor
    || isElectron
    || !!getServerUrl();

  const checkAuth = useCallback(() => {
    const token = localStorage.getItem("nowen-token");
    if (!token) {
      setIsAuthenticated(false);
      return;
    }

    const serverUrl = getServerUrl();
    const authScope = getAuthCacheScope(serverUrl);
    // 原生 APP（Capacitor）里没有 vite proxy，也没有同源后端 ——
    // 如果拿不到 serverUrl，直接回登录页让用户重新输，避免打到 "/api"
    // 后请求挂起导致白屏。
    const isCap = !!(window as any).Capacitor?.isNativePlatform?.();
    if (isCap && !serverUrl) {
      setIsAuthenticated(false);
      return;
    }
    const baseUrl = serverUrl ? `${serverUrl}/api` : "/api";

    // 8s 超时兜底：网络不通 / 服务器未启动时 fetch 会一直挂起，
    // 没有超时的话 UI 会永远停在 loading（splash 已被手动隐藏 → 白屏）。
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);

    fetch(`${baseUrl}/auth/verify`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    })
      .then(async (res) => {
        if (res.ok) return res.json();
        let body: any = {};
        try { body = await res.clone().json(); } catch { /* ignore */ }
        // 401 / 会话吊销类 403 才是真正的"登录态失效"，需要清 token。
        // 网络抖动、远端 5xx、超时不应把用户踢回登录页，否则云端离线缓存无法使用。
        const code = body?.code as string | undefined;
        const authInvalid =
          res.status === 401 ||
          code === "ACCOUNT_DISABLED" ||
          code === "TOKEN_REVOKED" ||
          code === "USER_NOT_FOUND" ||
          code === "TOKEN_INVALID" ||
          code === "SESSION_REVOKED" ||
          code === "UNAUTHENTICATED";
        if (authInvalid) {
          const err = new Error(body?.error || "Invalid token") as Error & { authInvalid?: boolean };
          err.authInvalid = true;
          throw err;
        }
        const err = new Error(body?.error || `Verify failed: ${res.status}`) as Error & { networkLike?: boolean; status?: number };
        err.status = res.status;
        err.networkLike = res.status >= 500 || res.status === 408 || res.status === 425 || res.status === 429;
        throw err;
      })
      .then((data) => {
        const verifiedUser = data.user as User;
        saveCachedAuthUser(authScope, token, verifiedUser);
        setUser(verifiedUser);
        setIsAuthenticated(true);
      })
      .catch((err) => {
        if ((err as any)?.authInvalid) {
          // 只有明确的鉴权失效才广播登出；网络/远端不可达不能清 token。
          broadcastLogout("verify_failed");
          setIsAuthenticated(false);
          return;
        }

        if (isVerifyNetworkFailure(err)) {
          const cachedUser = loadCachedAuthUser(authScope, token);
          if (cachedUser) {
            // 云端降级：保留 token + serverUrl，使用上次用户信息进入主界面。
            // 后续读请求会走 offlineRead，本地缓存可用；写请求失败会进 offlineQueue。
            setUser(cachedUser);
            setIsAuthenticated(true);
            try { window.dispatchEvent(new CustomEvent("nowen:cloud-degraded")); } catch { /* ignore */ }
            return;
          }
          // 无缓存时无法绑定 localStore 用户 id，只能展示登录页；但仍不清 token，
          // 网络恢复后刷新即可重新 verify 进入。
          setIsAuthenticated(false);
          return;
        }

        setIsAuthenticated(false);
      })
      .finally(() => clearTimeout(timer));
  }, []);

  useEffect(() => {
    // Phase A: Electron 桌面端零登录优先 —— 在任何"客户端模式 + 无 serverUrl 即回登录页"
    // 的判断之前先问主进程要本地账号 token。
    //   - 如果 localStorage 里已有 token（用户已显式登录过），优先尊重之，不覆盖；
    //   - 仅当未登录且 nowenDesktop.isDesktop+getLocalAuth 可用时才走零登录路径；
    //   - lite 模式（连远端）下主进程会返回 null，自动回落到原有登录流程；
    //   - 拿到 token 时同时把 window.location.origin（http://127.0.0.1:<port>）
    //     写入 nowen-server-url，让后续 API 调用照常走 ${serverUrl}/api，
    //     避免 verify / fetch 落空。
    //   - 整体放到最前面是因为：桌面端首启 localStorage 一片空白，
    //     原先 "isClientMode && !getServerUrl()" 会直接 return，零登录代码永远走不到。
    const desktopApi = (window as any).nowenDesktop;
    const existingToken = (() => {
      try { return localStorage.getItem("nowen-token"); } catch { return null; }
    })();
    // D-1：桌面端"切换到云端"开关。
    //   用户在 NavRail 点击云端入口后会写 nowen-prefer-cloud=1，
    //   此时强制跳过零登录，直接进登录页（让用户输入 fnos 服务器地址）。
    //   返回本地模式时 LoginPage 会清除该标记 + reload，零登录恢复。
    const preferCloud = (() => {
      try { return localStorage.getItem("nowen-prefer-cloud") === "1"; } catch { return false; }
    })();
    if (!existingToken && !preferCloud && desktopApi?.isDesktop && desktopApi?.getLocalAuth) {
      let cancelled = false;
      desktopApi.getLocalAuth().then((auth: { token: string; user: User } | null) => {
        if (cancelled) return;
        if (auth?.token) {
          try {
            localStorage.setItem("nowen-token", auth.token);
            // 桌面端首启把 origin 当作 serverUrl 落盘，让后续同源 API 调用顺利通过
            if (!getServerUrl() && window.location.origin.startsWith("http")) {
              localStorage.setItem("nowen-server-url", window.location.origin);
            }
          } catch { /* ignore */ }
          saveCachedAuthUser(getAuthCacheScope(getServerUrl()), auth.token, auth.user);
          setUser(auth.user);
          setIsAuthenticated(true);
          return;
        }
        // 主进程没给 token（lite 模式 / ensureLocalAccount 失败）→ 退回原有判定
        if (isClientMode && !getServerUrl()) {
          setIsAuthenticated(false);
        } else {
          checkAuth();
        }
      }).catch(() => {
        if (cancelled) return;
        if (isClientMode && !getServerUrl()) {
          setIsAuthenticated(false);
        } else {
          checkAuth();
        }
      });
      return () => { cancelled = true; };
    }

    // 非桌面端 / 已有 token：走原有逻辑
    // 客户端模式但没有服务器地址：直接显示登录页（含服务器输入框）
    if (isClientMode && !getServerUrl()) {
      setIsAuthenticated(false);
      return;
    }
    checkAuth();
  }, [checkAuth, isClientMode]);

  // L10: 多标签页登录态同步
  //
  //   同一浏览器里开了多个 tab 时，常见的诉求：
  //     1) A tab 退出登录 / 被踢下线 → B tab 要立刻跟着退出；
  //     2) A tab 登录成功（或换了账号） → B tab 应该重载进入对应账号；
  //     3) A tab 改了服务器地址 → B tab 的后续请求自然应该打到新服务器。
  //
  //   storage 事件只在"其他"tab 修改 localStorage 时触发（不会在自己这 tab 触发），
  //   所以 handler 里调 window.location.reload() 不会导致死循环。
  //   仅监听我们自己的 key：nowen-token / nowen-server-url / nowen-logout-broadcast。
  //
  //   另外单独用一个 "nowen-logout-broadcast" key 作为广播通道：
  //   当某 tab 主动登出时 setItem(..., Date.now()) 即可通知所有其他 tab。
  useEffect(() => {
    const onStorage = (ev: StorageEvent) => {
      if (!ev.key) return;
      if (ev.key === "nowen-token") {
        const oldHad = !!ev.oldValue;
        const nowHas = !!ev.newValue;
        if (oldHad && !nowHas) {
          // 其他 tab 登出了 → 把本 tab 也拉回登录页
          setIsAuthenticated(false);
          setUser(null);
        } else if (oldHad && nowHas && ev.oldValue !== ev.newValue) {
          // token 被替换（换账号 / factory-reset 下发新 token）→ 重新验证并重载应用
          window.location.reload();
        } else if (!oldHad && nowHas) {
          // 其他 tab 刚登录成功 → 本 tab 去走一遍 verify，无感进入已登录态
          checkAuth();
        }
      } else if (ev.key === "nowen-logout-broadcast") {
        // 其他 tab 主动登出 → 本 tab 也清本地 token 并回登录页
        try { localStorage.removeItem("nowen-token"); } catch {}
        setIsAuthenticated(false);
        setUser(null);
      } else if (ev.key === "nowen-server-url") {
        // 服务器地址改了，接下来的 API 调用需要刷新页面才能命中新 base URL
        // 只有已登录（或正在展示列表）才需要 reload，未登录状态本身就在输服务器地址那一步，不用动
        if (isAuthenticated) {
          window.location.reload();
        }
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [checkAuth, isAuthenticated]);

  // Phase 7: 标记"本次登录是否刚通过密码完成"——
  //   只有密码登录的用户才会被引导启用快速登录；
  //   通过快速登录进来的用户已经启用过，不应再弹。
  const [justPasswordLogin, setJustPasswordLogin] = useState(false);
  /** 当前 token（用于引导对话框写入 secure storage） */
  const [activeToken, setActiveToken] = useState<string>("");

  // Phase B: 用户登录态确立后启动同步引擎（绑定 IDB + 全量 pull）。
  // 任何登录入口（密码 / 快速登录 / 桌面零登录）最终都会落到 setUser，
  // 这里集中接管，避免每个入口都重复挂钩。失败不阻塞 UI。
  useEffect(() => {
    if (!user?.id) return;
    void syncBootstrap(user).catch((e) => {
      console.warn("[App] syncBootstrap failed:", e);
    });
  }, [user?.id]);

  // 「更新日志」首次升级自动弹窗。
  //   - 仅在已登录分支生效（enable=!!user），未登录态不打扰；
  //   - useWhatsNew 内部对比 localStorage.nowen-seen-version 与 __APP_VERSION__，
  //     不一致才返回 shouldShow=true，关闭后立即写回，下一次升级才再弹。
  const [showWhatsNew, markWhatsNewSeen] = useWhatsNew(!!user);

  const handleDisconnect = () => {
    clearServerUrl();
    // L10: 断开服务器相当于登出 + 切换服务器，通知其他 tab
    broadcastLogout("disconnect_server");
    // Phase 7: 切换服务器时 token 已经无意义，把 secure storage 镜像也清掉，
    // 避免下次开 app 又用旧 token 自动登录（会落到 verify 失败再回退，但没必要走一遭）
    void import("@/lib/quickLogin").then((m) => m.disableQuickLogin()).catch(() => {});
    // Phase B: 解绑本地缓存当前用户；缓存数据保留以便下次重登秒开
    syncTeardown();
    setIsAuthenticated(false);
    setUser(null);
  };

  const handleLogin = (token: string, userData: User) => {
    saveCachedAuthUser(getAuthCacheScope(getServerUrl()), token, userData);
    setUser(userData);
    setActiveToken(token);
    setIsAuthenticated(true);

    // 登录引导回跳：支持来自分享页（edit_auth 权限）的 `/login?redirect=/share/<token>`。
    //
    // 安全约束 —— 只允许相对路径回跳，绝不允许 http(s):// 或 // 开头：
    //   1. 防止开放重定向（open redirect）：恶意人造 `?redirect=https://attacker.example`
    //      把刚登录的用户带到钓鱼页；
    //   2. 防 protocol-relative URL（`//attacker.example`）和 `javascript:` 协议；
    //   3. 兼容 hash router 链路：相对 `/share/xxx` 直接 location.assign 即可命中
    //      App.tsx 顶部的 path 路由匹配（shareMatch）。
    //
    // 命中即跳；不命中保持原行为（停留在主界面）。
    try {
      const params = new URLSearchParams(window.location.search);
      const raw = params.get("redirect");
      if (raw) {
        // 仅接受单斜杠 + 字母/数字/常见符号的相对路径
        if (/^\/[A-Za-z0-9_\-./?&=%#]*$/.test(raw) && !raw.startsWith("//")) {
          // 用 replace 而非 assign：登录页在历史栈中没意义，避免用户后退又回登录页
          window.location.replace(raw);
          return;
        }
      }
    } catch {
      // location 异常时静默：保持登录后的默认主界面渲染即可，不阻断登录流程
    }
  };

  /** 仅用于 LoginPage（密码登录路径），登录成功后下一帧弹引导对话框 */
  const handlePasswordLogin = (token: string, userData: User) => {
    setJustPasswordLogin(true);
    handleLogin(token, userData);
  };

  // 加载中
  if (isAuthenticated === null) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-zinc-50 dark:bg-zinc-950 transition-colors">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
          <p className="text-sm text-zinc-400 dark:text-zinc-500">{t('auth.verifying')}</p>
        </div>
      </div>
    );
  }

  // 未登录 → 一体化登录页
  if (!isAuthenticated) {
    // Phase 7: 先让 QuickLoginGate 看看是否能用生物识别一键登录
    //   - 不支持 / 未启用 / 用户取消：onSettled(false) 会把 quickLoginState
    //     置为 "skipped"，下面继续渲染 LoginPage
    //   - 成功：onSettled(true, payload) 直接走 handleLogin 进主界面
    if (isClientMode && quickLoginState === "pending") {
      return (
        <QuickLoginGate
          isClientMode={isClientMode}
          onSettled={(used, payload) => {
            if (used && payload) {
              handleLogin(payload.token, payload.user);
            } else {
              setQuickLoginState("skipped");
            }
          }}
        />
      );
    }

    return (
      <LoginPage
        onLogin={handlePasswordLogin}
        isClientMode={isClientMode}
        onDisconnect={isClientMode ? handleDisconnect : undefined}
      />
    );
  }

  // 已登录
  return (
    <AppProvider>
      <TooltipProvider>
        <AppLayout />
        {/* Phase 7: 客户端模式下，密码登录成功后引导启用快速登录。
            QuickLoginEnrollDialog 内部会判断"是否已问过 / 设备是否支持"，
            不需要展示时会立即调 onClose 自我隐身。 */}
        {justPasswordLogin && isClientMode && user && activeToken && (
          <QuickLoginEnrollDialog
            username={user.username}
            token={activeToken}
            onClose={() => setJustPasswordLogin(false)}
          />
        )}
        {/* 首次升级到新版本自动弹「更新日志」。
            useWhatsNew 决定是否该弹；onClose 调 markSeen 写回 localStorage，
            下一次升版前都不会再弹。 */}
        <WhatsNewModal
          open={showWhatsNew}
          onClose={markWhatsNewSeen}
          highlightVersion={__APP_VERSION__}
        />
      </TooltipProvider>
    </AppProvider>
  );
}

function App() {
  const [webUiAllowed, setWebUiAllowed] = useState<boolean | null>(() => isNativeClientRuntime() ? true : null);

  useEffect(() => {
    if (isNativeClientRuntime()) {
      setWebUiAllowed(true);
      return;
    }
    let cancelled = false;
    fetchWebUiEnabled().then((enabled) => {
      if (!cancelled) setWebUiAllowed(enabled);
    });
    return () => { cancelled = true; };
  }, []);

  if (webUiAllowed === null) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-zinc-50 dark:bg-zinc-950">
        <div className="w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!webUiAllowed) {
    return <WebUiDisabledPage />;
  }

  // 检查是否是分享页面路由 /share/:token
  //
  // 字符集说明：后端 generateShareToken() 用 crypto.randomBytes(9).toString("base64url")
  // 输出 12 字符 base64url，字符集是 [A-Za-z0-9_-]（注意包含下划线和连字符）。
  //
  // 历史 BUG（必须保留下划线/连字符的支持）：
  //   早期正则写成 [A-Za-z0-9]+，碰到含 `-` / `_` 的 token 时匹配失败，
  //   App 直接落到 AuthGate 分支 → 未登录用户被导到登录页，
  //   被误诊为"可评论分享触发登录"。如果再次收紧此正则，请同步约束 token 生成。
  const path = window.location.pathname;
  const shareMatch = path.match(/^\/share\/([A-Za-z0-9_-]+)$/);
  if (shareMatch) {
    return (
      <ThemeProvider>
        <ConfirmProvider>
          <SharedNoteView shareToken={shareMatch[1]} />
          <Toaster />
        </ConfirmProvider>
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider>
      <SiteSettingsProvider>
        <UserPreferencesProvider>
          <ConfirmProvider>
            <AuthGate />
            <Toaster />
          </ConfirmProvider>
        </UserPreferencesProvider>
      </SiteSettingsProvider>
    </ThemeProvider>
  );
}

export default App;
