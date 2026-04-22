import React, { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Menu, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import Sidebar from "@/components/Sidebar";
import NoteList from "@/components/NoteList";
import EditorPane from "@/components/EditorPane";
import TaskCenter from "@/components/TaskCenter";
import MindMapCenter from "@/components/MindMapEditor";
import AIChatPanel from "@/components/AIChatPanel";
import DiaryCenter from "@/components/DiaryCenter";
import SharedNoteView from "@/components/SharedNoteView";
import LoginPage from "@/components/LoginPage";
import { AppProvider, useApp, useAppActions, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH, DEFAULT_SIDEBAR_WIDTH, MIN_NOTELIST_WIDTH, MAX_NOTELIST_WIDTH, DEFAULT_NOTELIST_WIDTH } from "@/store/AppContext";
import { ThemeProvider } from "@/components/ThemeProvider";
import { SiteSettingsProvider, useSiteSettings } from "@/hooks/useSiteSettings";
import { TooltipProvider } from "@/components/ui/tooltip";
import Toaster from "@/components/Toaster";
import { User } from "@/types";
import { getServerUrl, clearServerUrl, broadcastLogout } from "@/lib/api";
import { useBackButton, hideSplashScreen, useStatusBarSync, useKeyboardLayout, isNativePlatform } from "@/hooks/useCapacitor";

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

    const handleTouchStart = (e: TouchEvent) => {
      const touch = e.touches[0];
      touchStartX.current = touch.clientX;
      touchStartY.current = touch.clientY;
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
  const isTaskView = state.viewMode === "tasks";
  const isMindMapView = state.viewMode === "mindmaps";
  const isAIChatView = state.viewMode === "ai-chat";
  const isDiaryView = state.viewMode === "diary";


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

  // Alt+N 全局快捷键：快速新建笔记
  useEffect(() => {
    const handleKeyDown = async (e: KeyboardEvent) => {
      if (e.altKey && e.key.toLowerCase() === "n") {
        e.preventDefault();
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
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [state.selectedNotebookId, state.notebooks, actions, t]);

  return (
    <div className="flex h-[100dvh] w-screen bg-app-bg overflow-hidden transition-colors duration-200">
      {/* ===== 移动端：抽屉式侧边栏 ===== */}
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
              className="fixed inset-y-0 left-0 z-50 w-[85%] max-w-[340px] md:hidden shadow-2xl"
            >
              <Sidebar />
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* ===== 桌面端：固定侧边栏 + 拖拽条 ===== */}
      <div
        className="hidden md:flex shrink-0"
        style={{ width: state.sidebarCollapsed ? undefined : `${state.sidebarWidth}px` }}
      >
        <Sidebar />
      </div>
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
      ) : (
        <div className="flex-1 flex relative overflow-hidden">
          {/* 笔记列表 — 桌面端动态宽度，移动端全宽 */}
          <div
            className={`
              flex flex-col shrink-0 h-full
              max-md:!w-full
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
    </div>
  );
}

function MobileTopBar() {
  const actions = useAppActions();
  const { siteConfig } = useSiteSettings();
  return (
    <header className="flex items-center px-4 py-3 border-b border-app-border bg-app-surface/50 md:hidden" style={{ paddingTop: 'max(env(safe-area-inset-top, 0px), 12px)' }}>
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
  const { t } = useTranslation();

  // P1: Splash Screen — 应用就绪后隐藏启动屏（必须在条件返回之前调用）
  useEffect(() => {
    if (isAuthenticated !== null) {
      hideSplashScreen();
    }
  }, [isAuthenticated]);

  // 判断是否为客户端模式（Electron / Android / 曾配置过服务器地址）
  const isCapacitor = !!(window as any).Capacitor?.isNativePlatform?.() 
    || !!(window as any).Capacitor?.platform && (window as any).Capacitor.platform !== "web";
  const isClientMode = window.location.protocol === "file:"
    || window.location.protocol === "capacitor:"
    || isCapacitor
    || !!getServerUrl();

  const checkAuth = useCallback(() => {
    const token = localStorage.getItem("nowen-token");
    if (!token) {
      setIsAuthenticated(false);
      return;
    }

    const serverUrl = getServerUrl();
    const baseUrl = serverUrl ? `${serverUrl}/api` : "/api";

    fetch(`${baseUrl}/auth/verify`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((res) => {
        if (res.ok) return res.json();
        throw new Error("Invalid token");
      })
      .then((data) => {
        setUser(data.user);
        setIsAuthenticated(true);
      })
      .catch(() => {
        // L10: verify 失败 → 广播给其他 tab 一起下线
        broadcastLogout("verify_failed");
        setIsAuthenticated(false);
      });
  }, []);

  useEffect(() => {
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

  const handleDisconnect = () => {
    clearServerUrl();
    // L10: 断开服务器相当于登出 + 切换服务器，通知其他 tab
    broadcastLogout("disconnect_server");
    setIsAuthenticated(false);
    setUser(null);
  };

  const handleLogin = (token: string, userData: User) => {
    setUser(userData);
    setIsAuthenticated(true);
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
    return (
      <LoginPage
        onLogin={handleLogin}
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
      </TooltipProvider>
    </AppProvider>
  );
}

function App() {
  // 检查是否是分享页面路由 /share/:token
  const path = window.location.pathname;
  const shareMatch = path.match(/^\/share\/([A-Za-z0-9]+)$/);
  if (shareMatch) {
    return (
      <ThemeProvider>
        <SharedNoteView shareToken={shareMatch[1]} />
        <Toaster />
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider>
      <SiteSettingsProvider>
        <AuthGate />
        <Toaster />
      </SiteSettingsProvider>
    </ThemeProvider>
  );
}

export default App;
