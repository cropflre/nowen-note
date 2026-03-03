import React, { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Menu, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import Sidebar from "@/components/Sidebar";
import NoteList from "@/components/NoteList";
import EditorPane from "@/components/EditorPane";
import TaskCenter from "@/components/TaskCenter";
import MindMapCenter from "@/components/MindMapEditor";
import DocumentCenter from "@/components/DocumentCenter";
import AIChatPanel from "@/components/AIChatPanel";
import LoginPage from "@/components/LoginPage";
import { AppProvider, useApp, useAppActions, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH, DEFAULT_SIDEBAR_WIDTH, MIN_NOTELIST_WIDTH, MAX_NOTELIST_WIDTH, DEFAULT_NOTELIST_WIDTH } from "@/store/AppContext";
import { ThemeProvider } from "@/components/ThemeProvider";
import { SiteSettingsProvider, useSiteSettings } from "@/hooks/useSiteSettings";
import { TooltipProvider } from "@/components/ui/tooltip";
import { User } from "@/types";

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

function AppLayout() {
  const { state } = useApp();
  const actions = useAppActions();
  const isTaskView = state.viewMode === "tasks";
  const isMindMapView = state.viewMode === "mindmaps";
  const isDocumentView = state.viewMode === "documents";
  const isAIChatView = state.viewMode === "ai-chat";

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
              className="fixed inset-y-0 left-0 z-50 w-[80%] max-w-[300px] md:hidden shadow-2xl"
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
      ) : isDocumentView ? (
        <div className="flex-1 flex flex-col">
          <DocumentCenter />
        </div>
      ) : isAIChatView ? (
        <div className="flex-1 flex flex-col">
          <MobileTopBar />
          <AIChatPanel onClose={() => actions.setViewMode("all")} />
        </div>
      ) : (
        <div className="flex-1 flex relative overflow-hidden">
          {/* 笔记列表 — 桌面端动态宽度，移动端全宽 */}
          <div
            className={`
              flex flex-col shrink-0 h-full
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
    <header className="flex items-center px-4 py-3 border-b border-app-border bg-app-surface/50 md:hidden">
      <button
        onClick={() => actions.setMobileSidebar(true)}
        className="p-1.5 -ml-1.5 rounded-md text-tx-secondary hover:bg-app-hover"
      >
        <Menu size={22} />
      </button>
      <span className="ml-3 text-sm font-semibold text-tx-primary">{siteConfig.title}</span>
    </header>
  );
}

function AuthGate() {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const { t } = useTranslation();

  useEffect(() => {
    const token = localStorage.getItem("nowen-token");
    if (!token) {
      setIsAuthenticated(false);
      return;
    }

    // 验证 token 有效性
    fetch("/api/auth/verify", {
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
        localStorage.removeItem("nowen-token");
        setIsAuthenticated(false);
      });
  }, []);

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

  // 未登录
  if (!isAuthenticated) {
    return <LoginPage onLogin={handleLogin} />;
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
  return (
    <ThemeProvider>
      <SiteSettingsProvider>
        <AuthGate />
      </SiteSettingsProvider>
    </ThemeProvider>
  );
}

export default App;
