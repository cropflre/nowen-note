import React, { useState, useEffect } from "react";
import Sidebar from "@/components/Sidebar";
import NoteList from "@/components/NoteList";
import EditorPane from "@/components/EditorPane";
import TaskCenter from "@/components/TaskCenter";
import LoginPage from "@/components/LoginPage";
import { AppProvider, useApp } from "@/store/AppContext";
import { ThemeProvider } from "@/components/ThemeProvider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { User } from "@/types";

function AppLayout() {
  const { state } = useApp();
  const isTaskView = state.viewMode === "tasks";

  return (
    <div className="flex h-screen w-screen bg-app-bg overflow-hidden transition-colors duration-200">
      <Sidebar />
      {isTaskView ? (
        <TaskCenter />
      ) : (
        <>
          <NoteList />
          <EditorPane />
        </>
      )}
    </div>
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
      <AuthGate />
    </ThemeProvider>
  );
}

export default App;
