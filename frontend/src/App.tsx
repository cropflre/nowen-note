import React, { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Menu, X } from "lucide-react";
import Sidebar from "@/components/Sidebar";
import NoteList from "@/components/NoteList";
import EditorPane from "@/components/EditorPane";
import TaskCenter from "@/components/TaskCenter";
import LoginPage from "@/components/LoginPage";
import { AppProvider, useApp, useAppActions } from "@/store/AppContext";
import { ThemeProvider } from "@/components/ThemeProvider";
import { SiteSettingsProvider, useSiteSettings } from "@/hooks/useSiteSettings";
import { TooltipProvider } from "@/components/ui/tooltip";
import { User } from "@/types";

function AppLayout() {
  const { state } = useApp();
  const actions = useAppActions();
  const isTaskView = state.viewMode === "tasks";

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

      {/* ===== 桌面端：固定侧边栏 ===== */}
      <div className="hidden md:flex">
        <Sidebar />
      </div>

      {/* ===== 主内容区 ===== */}
      {isTaskView ? (
        <div className="flex-1 flex flex-col">
          {/* 移动端顶栏 */}
          <MobileTopBar />
          <TaskCenter />
        </div>
      ) : (
        <div className="flex-1 flex relative overflow-hidden">
          {/* 笔记列表 — 移动端根据 mobileView 控制显隐 */}
          <div className={`
            flex flex-col w-full md:w-[300px] md:min-w-[300px] md:shrink-0
            ${state.mobileView === "list" ? "flex" : "hidden md:flex"}
          `}>
            <NoteList />
          </div>

          {/* 编辑器 — 移动端全屏覆盖 */}
          <div className={`
            absolute inset-0 z-20 md:static md:z-auto md:flex-1 flex flex-col
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
          <p className="text-sm text-zinc-400 dark:text-zinc-500">正在验证身份...</p>
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
