/**
 * 应用入口：会话状态 + 路由。
 *
 * 启动顺序（刻意做得「可预期」）：
 *   1. 本地没有 token → 直接显示登录页
 *   2. 有 token → 静默校验一次（/api/auth/verify）
 *        · 有效 → 进入主界面
 *        · 无效 → 清掉并回登录页
 *   3. 校验期间显示极简 loading（不闪白屏、不卡住）
 *
 * ⚠️ 刻意不做的事：没有本地优先、没有离线队列、没有启动期网络预取。
 *    主项目的「本地优先运行时」就是在这块把 App 卡死的。
 */
import { useCallback, useEffect, useState } from "react";
import { BottomNav } from "./shell/BottomNav";
import { LoginScreen } from "./screens/LoginScreen";
import { NotesFeedScreen } from "./screens/NotesFeedScreen";
import { NoteViewScreen } from "./screens/NoteViewScreen";
import { NoteEditScreen } from "./screens/NoteEditScreen";
import { DiaryScreen } from "./screens/DiaryScreen";
import { TasksScreen } from "./screens/TasksScreen";
import { SearchScreen } from "./screens/SearchScreen";
import { SettingsScreen } from "./screens/SettingsScreen";
import {
  clearSession,
  getRefreshToken,
  getServerUrl,
  getToken,
  refreshSession,
  verifyToken,
} from "./auth/auth";
import { resetClient } from "./api/client";
import { currentRoute, goBack, type Route } from "./lib/router";
import { ConnectionBadge } from "./shell/ConnectionBadge";
import { isBadgeEnabled, useConnPolling } from "./lib/connStatus";

type Session = "checking" | "anonymous" | "authenticated";

export default function App() {
  const [session, setSession] = useState<Session>(() => (getToken() ? "checking" : "anonymous"));
  const [route, setRoute] = useState<Route>(() => currentRoute());

  // 路由：hash 变化即重渲染（浏览器返回键天然可用）
  useEffect(() => {
    const onHash = () => setRoute(currentRoute());
    window.addEventListener("hashchange", onHash);
    if (!window.location.hash) window.location.hash = "#/notes";
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // 启动时校验一次已有 token
  useEffect(() => {
    if (session !== "checking") return;
    let cancelled = false;
    void (async () => {
      // 先看 access token；不行就用 refresh token 续一次再判。
      // ⚠️ access token 只有 15 分钟，直接判失效会让用户每 15 分钟重登一次。
      let token = getToken();
      let ok = token ? (await verifyToken(getServerUrl(), token)).valid : false;

      if (!ok && getRefreshToken()) {
        await refreshSession();
        token = getToken();
        ok = token ? (await verifyToken(getServerUrl(), token)).valid : false;
      }

      if (cancelled) return;
      if (!ok) {
        clearSession();
        resetClient();
      }
      setSession(ok ? "authenticated" : "anonymous");
    })();
    return () => {
      cancelled = true;
    };
  }, [session]);

  const onLoggedIn = useCallback(() => {
    resetClient();
    setSession("authenticated");
  }, []);

  // 右上角连接状态指示器：可见时才轮询，后台自动停（见 connStatus.ts）
  useConnPolling(isBadgeEnabled());

  const onLoggedOut = useCallback(() => {
    clearSession();
    resetClient();
    window.location.hash = "#/notes";
    setSession("anonymous");
  }, []);

  if (session === "checking") {
    return <div className="loading">正在恢复会话…</div>;
  }

  if (session === "anonymous") {
    // 登录页也要显示：那里正是最需要知道"连不连得上服务端"的地方
    return (
      <>
        <ConnectionBadge />
        <LoginScreen onLoggedIn={onLoggedIn} />
      </>
    );
  }

  return (
    <div className="app">
      {/* 固定右上角：延迟 + 可用性（设置里可关） */}
      <ConnectionBadge />
      {renderScreen(route, onLoggedOut)}
      <BottomNav route={route} />
    </div>
  );
}

function renderScreen(route: Route, onLoggedOut: () => void) {
  switch (route.name) {
    case "notes":
      return <NotesFeedScreen />;
    case "note":
      return <NoteViewScreen noteId={route.noteId} title={route.title} />;
    case "edit":
      return <NoteEditScreen noteId={route.noteId} title={route.title} />;
    case "diary":
      return <DiaryScreen />;
    case "tasks":
      return <TasksScreen />;
    case "search":
      return <SearchScreen />;
    case "settings":
      return <SettingsScreen onLoggedOut={onLoggedOut} />;
    default:
      return <NotesFeedScreen />;
  }
}

/** 顶栏：返回按钮 + 标题 + 可选右侧插槽。各页面复用。 */
export function TopBar({
  title,
  showBack,
  right,
  onBack,
}: {
  title: string;
  showBack?: boolean;
  right?: React.ReactNode;
  /** 自定义返回行为（编辑器要在有未保存改动时先询问，不能直接走） */
  onBack?: () => void;
}) {
  return (
    <div className="app-topbar glass">
      {showBack ? (
        <button className="topbar-btn" onClick={onBack ?? (() => goBack())} aria-label="返回">
          ‹
        </button>
      ) : null}
      <h1>{title}</h1>
      {right}
    </div>
  );
}
