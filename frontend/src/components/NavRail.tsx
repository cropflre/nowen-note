import React, { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  BookOpen,
  BrainCircuit,
  Cloud,
  CloudOff,
  Columns2,
  Columns3,
  DatabaseBackup,
  FolderOpen,
  ListTodo,
  LogOut,
  NotebookPen,
  PanelLeft,
  PanelLeftClose,
  RotateCcw,
  Server,
  Settings,
  Sparkles,
  Star,
  Trash2,
  User,
  X,
} from "lucide-react";
import { AnimatePresence } from "framer-motion";
import { useTranslation } from "react-i18next";
import { useApp, useAppActions } from "@/store/AppContext";
import { api, broadcastLogout, clearServerUrl, getCurrentWorkspace, getServerUrl } from "@/lib/api";
import { ViewMode, WorkspaceFeatures } from "@/types";
import { cn } from "@/lib/utils";
import SettingsModal from "@/components/SettingsModal";
import { SERVER_CONNECTION_CENTER_OPEN_EVENT } from "@/components/ServerConnectionCenter";
import { RailMode, useRailMode } from "@/hooks/useRailMode";
import {
  clearDesktopLocalAuth,
  getAppInfo,
  getDiagnosticsInfo,
  isDesktop as isDesktopApp,
  resetDesktopLocalAuth,
  switchDesktopToFull,
  type AppInfo,
} from "@/lib/desktopBridge";
import { clearLocalIdMap, clearQueue, getQueueLength } from "@/lib/offlineQueue";
import { clearRememberedCredentials } from "@/lib/rememberLogin";
import { getActiveServerProfile, subscribeServerProfiles, type ServerProfile } from "@/lib/serverProfiles";

type NavGroup = "workspace" | "modules" | "tools";

interface NavConfigItem {
  icon: React.ReactNode;
  labelKey: string;
  mode: ViewMode;
  feature?: keyof WorkspaceFeatures;
  group: NavGroup;
}

const RAIL_ICON_SIZE = 18;

const NAV_CONFIG: NavConfigItem[] = [
  { icon: <BookOpen size={RAIL_ICON_SIZE} />, labelKey: "sidebar.allNotes", mode: "all", feature: "notes", group: "workspace" },
  { icon: <Star size={RAIL_ICON_SIZE} />, labelKey: "sidebar.favorites", mode: "favorites", feature: "favorites", group: "workspace" },
  { icon: <FolderOpen size={RAIL_ICON_SIZE} />, labelKey: "sidebar.fileManager", mode: "files", feature: "files", group: "workspace" },
  { icon: <Trash2 size={RAIL_ICON_SIZE} />, labelKey: "sidebar.trash", mode: "trash", group: "workspace" },
  { icon: <NotebookPen size={RAIL_ICON_SIZE} />, labelKey: "sidebar.diary", mode: "diary", feature: "diaries", group: "modules" },
  { icon: <ListTodo size={RAIL_ICON_SIZE} />, labelKey: "sidebar.tasks", mode: "tasks", feature: "tasks", group: "modules" },
  { icon: <BrainCircuit size={RAIL_ICON_SIZE} />, labelKey: "sidebar.mindMaps", mode: "mindmaps", feature: "mindmaps", group: "modules" },
  { icon: <Sparkles size={RAIL_ICON_SIZE} />, labelKey: "sidebar.aiChat", mode: "ai-chat", group: "tools" },
];

function isActive(itemMode: ViewMode, viewMode: ViewMode): boolean {
  if (itemMode === "all") return viewMode === "all" || viewMode === "search" || viewMode === "tag";
  return viewMode === itemMode;
}

function serverStatusDotClass(status?: ServerProfile["status"]): string {
  if (status === "online") return "bg-emerald-500";
  if (status === "offline" || status === "auth-expired") return "bg-rose-500";
  if (status === "checking") return "bg-amber-500 animate-pulse";
  return "bg-zinc-400";
}

export default function NavRail({ variant = "desktop" }: { variant?: "desktop" | "mobile" } = {}) {
  const { t } = useTranslation();
  const { state } = useApp();
  const actions = useAppActions();
  const [railMode, setRailMode] = useRailMode();
  const effectiveMode: RailMode = variant === "mobile" && railMode === "hidden" ? "icon" : railMode;
  const showLabel = effectiveMode === "label";
  const isMobile = variant === "mobile";

  const [features, setFeatures] = useState<WorkspaceFeatures | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [desktopInfo, setDesktopInfo] = useState<AppInfo | null>(null);
  const [activeServer, setActiveServer] = useState<ServerProfile | null>(() => getActiveServerProfile());

  useEffect(() => {
    const load = () => {
      const ws = getCurrentWorkspace();
      if (!ws || ws === "personal") {
        setFeatures(null);
        return;
      }
      api.getWorkspaceFeatures(ws).then(setFeatures).catch(() => setFeatures(null));
    };
    load();
    window.addEventListener("nowen:workspace-changed", load);
    window.addEventListener("nowen:workspace-features-changed", load);
    return () => {
      window.removeEventListener("nowen:workspace-changed", load);
      window.removeEventListener("nowen:workspace-features-changed", load);
    };
  }, []);

  useEffect(() => {
    const refreshActiveServer = () => setActiveServer(getActiveServerProfile());
    refreshActiveServer();
    return subscribeServerProfiles(refreshActiveServer);
  }, []);

  useEffect(() => {
    if (!isDesktopApp()) return;
    let cancelled = false;
    getAppInfo()
      .then((info) => {
        if (!cancelled) setDesktopInfo(info ?? null);
      })
      .catch(() => {
        if (!cancelled) setDesktopInfo(null);
      });
    getDiagnosticsInfo()
      .then((diag) => {
        if (!cancelled && diag) setDesktopInfo((prev) => (prev ? { ...prev, ...diag } : prev));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!accountMenuOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setAccountMenuOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [accountMenuOpen]);

  const normalizeUrl = (url: string) => url.replace(/\/+$/, "").toLowerCase();
  const isLoopbackUrl = (url: string) => {
    try {
      const parsed = new URL(url);
      return parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "::1";
    } catch {
      return false;
    }
  };

  const serverUrl = getServerUrl();
  const currentOrigin = typeof window !== "undefined" && window.location.origin.startsWith("http") ? window.location.origin : "";
  const usingDesktopLiteMode = desktopInfo?.mode === "lite";
  const desktopLocalUrl = desktopInfo?.backendPort ? `http://127.0.0.1:${desktopInfo.backendPort}` : "";
  const usingCurrentLocalBackend = !!serverUrl && !!desktopLocalUrl && normalizeUrl(serverUrl) === normalizeUrl(desktopLocalUrl);
  const usingRemoteServer =
    !!serverUrl &&
    !usingCurrentLocalBackend &&
    (usingDesktopLiteMode || !isLoopbackUrl(serverUrl) || (!!currentOrigin && normalizeUrl(serverUrl) !== normalizeUrl(currentOrigin)));
  const canSwitchBackToLocal = isDesktopApp() && (usingRemoteServer || usingDesktopLiteMode);

  const items = features ? NAV_CONFIG.filter((item) => !item.feature || features[item.feature] !== false) : NAV_CONFIG;

  const handleClick = useCallback(
    (mode: ViewMode) => {
      actions.setViewMode(mode);
      actions.setSelectedNotebook(null);
      if (isMobile) actions.setMobileSidebar(false);
    },
    [actions, isMobile],
  );

  const openConnectionAndAccounts = useCallback(() => {
    setAccountMenuOpen(false);
    window.dispatchEvent(new Event(SERVER_CONNECTION_CENTER_OPEN_EVENT));
  }, []);

  const openMigration = useCallback(() => {
    setAccountMenuOpen(false);
    window.dispatchEvent(
      new CustomEvent(SERVER_CONNECTION_CENTER_OPEN_EVENT, {
        detail: { tab: "migration" },
      }),
    );
  }, []);

  const handleDesktopCloudButton = useCallback(async () => {
    setAccountMenuOpen(false);
    if (!canSwitchBackToLocal) {
      window.dispatchEvent(new Event(SERVER_CONNECTION_CENTER_OPEN_EVENT));
      return;
    }

    const queuedCount = getQueueLength();
    if (queuedCount > 0) {
      const confirmed = window.confirm(
        t(
          "sidebar.switchToLocalConfirmWithQueue",
          "切回本地离线模式？当前云端账号还有未同步操作，切换后这些待同步操作会被丢弃，云端数据不会被删除。",
        ),
      );
      if (!confirmed) return;
    }

    const result = await switchDesktopToFull();
    if (result?.ok !== false) return;

    clearQueue();
    clearLocalIdMap();
    await broadcastLogout("switch_to_local");
    try {
      clearServerUrl();
      localStorage.removeItem("nowen-token");
      localStorage.removeItem("nowen-prefer-cloud");
      localStorage.removeItem("nowen-offline-queue");
      localStorage.removeItem("nowen-offline-id-map");
    } catch {
      // ignore storage failures
    }
    window.location.reload();
  }, [canSwitchBackToLocal, t]);

  const handleDesktopLogoutSession = useCallback(async () => {
    setAccountMenuOpen(false);
    await clearRememberedCredentials();
    await clearDesktopLocalAuth().catch(() => ({ ok: false }));
    try {
      localStorage.setItem("nowen-prefer-cloud", "1");
    } catch {
      // ignore storage failures
    }
    await broadcastLogout("desktop_logout_session");
    window.location.reload();
  }, []);

  const handleDesktopCloudLogout = useCallback(async () => {
    setAccountMenuOpen(false);
    await clearRememberedCredentials();
    await broadcastLogout("user_logout");
    window.location.reload();
  }, []);

  const handleDesktopResetLocalAuth = useCallback(async () => {
    setAccountMenuOpen(false);
    const result = await resetDesktopLocalAuth();
    if (result?.ok && result.token) {
      try {
        localStorage.setItem("nowen-token", result.token);
        localStorage.removeItem("nowen-prefer-cloud");
      } catch {
        // ignore storage failures
      }
      window.location.reload();
      return;
    }
    if (result?.error) window.alert(result.error);
  }, []);

  const railWidthClass = showLabel ? "w-16" : "w-12";
  const itemBaseClass = showLabel
    ? "relative w-14 py-1.5 rounded-lg flex flex-col items-center justify-center gap-0.5 transition-colors"
    : "relative w-10 h-10 rounded-lg flex items-center justify-center transition-colors";

  const renderItem = (item: NavConfigItem) => {
    const active = isActive(item.mode, state.viewMode);
    const label = t(item.labelKey);
    return (
      <button
        key={item.mode}
        onClick={() => handleClick(item.mode)}
        title={showLabel ? undefined : label}
        aria-label={label}
        className={cn(
          itemBaseClass,
          active ? "bg-accent-primary/12 text-accent-primary" : "text-tx-tertiary hover:bg-app-hover hover:text-tx-primary",
          item.mode === "trash" && !active && "opacity-70 hover:opacity-100",
        )}
      >
        {active && <span className="absolute left-0 top-1.5 bottom-1.5 w-[2px] rounded-full bg-accent-primary" aria-hidden />}
        {item.icon}
        {showLabel && <span className="text-[10px] leading-none mt-0.5 max-w-full truncate px-1">{label}</span>}
      </button>
    );
  };

  const groups: NavGroup[] = ["workspace", "modules", "tools"];
  const mobileNextMode: RailMode = effectiveMode === "label" ? "icon" : "label";
  const MobileSwitchIcon = effectiveMode === "label" ? Columns2 : Columns3;
  const accountMenuLeft = showLabel ? 72 : 56;

  const accountMenu = accountMenuOpen
    ? createPortal(
        <div
          className="fixed inset-0 z-[190]"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setAccountMenuOpen(false);
          }}
        >
          <div
            className="fixed bottom-3 w-64 rounded-lg border border-app-border bg-app-elevated py-1.5 shadow-xl"
            style={{ left: accountMenuLeft }}
            role="menu"
            aria-label={t("sidebar.accountMenu")}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="px-3 py-2 border-b border-app-border/70">
              <div className="flex items-center gap-2 text-xs font-medium text-tx-primary">
                <span className={cn("w-2 h-2 rounded-full shrink-0", serverStatusDotClass(activeServer?.status))} aria-hidden />
                <span className="truncate">{activeServer?.name || (canSwitchBackToLocal ? "远程服务器" : "当前服务器")}</span>
              </div>
              <div className="mt-1 truncate text-[11px] text-tx-tertiary" title={activeServer?.serverUrl || serverUrl}>
                {activeServer?.serverUrl || serverUrl || "当前客户端未记录服务端地址"}
              </div>
            </div>

            <button
              type="button"
              role="menuitem"
              onClick={openConnectionAndAccounts}
              className="w-full px-3 py-2 text-left text-sm text-tx-secondary hover:bg-app-hover hover:text-tx-primary flex items-center gap-2"
            >
              <Server size={15} />
              <span>连接与账号</span>
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={openMigration}
              className="w-full px-3 py-2 text-left text-sm text-tx-secondary hover:bg-app-hover hover:text-tx-primary flex items-center gap-2"
            >
              <DatabaseBackup size={15} />
              <span>迁移数据</span>
            </button>

            {isDesktopApp() && (
              <>
                <div className="my-1 border-t border-app-border/70" />
                {canSwitchBackToLocal ? (
                  <>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={handleDesktopCloudLogout}
                      className="w-full px-3 py-2 text-left text-sm text-tx-secondary hover:bg-app-hover hover:text-tx-primary flex items-center gap-2"
                    >
                      <LogOut size={15} />
                      <span>{t("sidebar.logoutDesktop")}</span>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={handleDesktopCloudButton}
                      className="w-full px-3 py-2 text-left text-sm text-tx-secondary hover:bg-app-hover hover:text-tx-primary flex items-center gap-2"
                    >
                      <CloudOff size={15} />
                      <span>{t("sidebar.switchToLocal")}</span>
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={handleDesktopLogoutSession}
                      className="w-full px-3 py-2 text-left text-sm text-tx-secondary hover:bg-app-hover hover:text-tx-primary flex items-center gap-2"
                    >
                      <LogOut size={15} />
                      <span>{t("sidebar.logoutSession")}</span>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={handleDesktopResetLocalAuth}
                      className="w-full px-3 py-2 text-left text-sm text-tx-secondary hover:bg-app-hover hover:text-tx-primary flex items-center gap-2"
                    >
                      <RotateCcw size={15} />
                      <span>{t("sidebar.resetLocalAutoLogin")}</span>
                    </button>
                  </>
                )}
              </>
            )}
          </div>
        </div>,
        document.body,
      )
    : null;

  return (
    <div
      className={cn(
        isMobile ? "flex md:hidden h-full" : "hidden md:flex h-full",
        "nav-rail vibrancy-sidebar bg-app-sidebar border-r border-app-border flex-col items-center shrink-0 transition-[width] duration-150",
        railWidthClass,
      )}
      style={{ paddingTop: "calc(var(--safe-area-top) + 4px)", paddingBottom: "8px" }}
    >
      {isMobile ? (
        <>
          <button
            onClick={() => actions.setMobileSidebar(false)}
            title={t("common.close")}
            aria-label={t("common.close")}
            className="w-10 h-10 rounded-lg flex items-center justify-center text-tx-tertiary hover:bg-app-hover hover:text-tx-primary transition-colors"
          >
            <X size={16} />
          </button>
          <button
            onClick={() => setRailMode(mobileNextMode)}
            title={t(`sidebar.railMode.switchTo.${mobileNextMode}`)}
            aria-label={t(`sidebar.railMode.switchTo.${mobileNextMode}`)}
            className="w-10 h-10 rounded-lg flex items-center justify-center text-tx-tertiary hover:bg-app-hover hover:text-tx-primary transition-colors"
          >
            <MobileSwitchIcon size={16} />
          </button>
        </>
      ) : (
        <button
          onClick={actions.toggleSidebar}
          title={state.sidebarCollapsed ? t("common.expand") : t("common.collapse")}
          aria-label={state.sidebarCollapsed ? t("common.expand") : t("common.collapse")}
          className="w-10 h-10 rounded-lg flex items-center justify-center text-tx-tertiary hover:bg-app-hover hover:text-tx-primary transition-colors"
        >
          {state.sidebarCollapsed ? <PanelLeft size={16} /> : <PanelLeftClose size={16} />}
        </button>
      )}

      <div className={cn("my-2 border-t border-app-border/60", showLabel ? "w-8" : "w-6")} aria-hidden />

      <div className="flex-1 min-h-0 w-full overflow-y-auto no-scrollbar flex flex-col items-center gap-1 px-1">
        {groups.map((group, index) => {
          const groupItems = items.filter((item) => item.group === group);
          if (groupItems.length === 0) return null;
          return (
            <React.Fragment key={group}>
              {index > 0 && <div className={cn("my-1 border-t border-app-border/60", showLabel ? "w-8" : "w-6")} aria-hidden />}
              {groupItems.map(renderItem)}
            </React.Fragment>
          );
        })}
      </div>

      <div className={cn("my-2 border-t border-app-border/60", showLabel ? "w-8" : "w-6")} aria-hidden />

      <button
        onClick={() => setShowSettings(true)}
        title={showLabel ? undefined : t("sidebar.settings")}
        aria-label={t("sidebar.settings")}
        className={cn(itemBaseClass, "text-tx-tertiary hover:bg-app-hover hover:text-tx-primary")}
      >
        <Settings size={16} />
        {showLabel && <span className="text-[10px] leading-none mt-0.5 max-w-full truncate px-1">{t("sidebar.settings")}</span>}
      </button>

      <button
        onClick={() => setAccountMenuOpen((open) => !open)}
        title={showLabel ? undefined : t("sidebar.accountMenu")}
        aria-label={t("sidebar.accountMenu")}
        aria-expanded={accountMenuOpen}
        className={cn(
          itemBaseClass,
          accountMenuOpen ? "bg-accent-primary/12 text-accent-primary" : "text-tx-tertiary hover:bg-app-hover hover:text-tx-primary",
        )}
      >
        <User size={16} />
        <span className={cn("absolute right-1 top-1 w-2 h-2 rounded-full ring-2 ring-app-sidebar", serverStatusDotClass(activeServer?.status))} aria-hidden />
        {showLabel && <span className="text-[10px] leading-none mt-0.5 max-w-full truncate px-1">{t("sidebar.accountMenu")}</span>}
      </button>

      {isDesktopApp() ? (
        <button
          onClick={handleDesktopCloudButton}
          title={showLabel ? undefined : canSwitchBackToLocal ? t("sidebar.switchToLocal", "切回本地离线模式") : "连接 NAS / 云端"}
          aria-label={canSwitchBackToLocal ? t("sidebar.switchToLocal", "切回本地离线模式") : "连接 NAS / 云端"}
          className={cn(itemBaseClass, "text-tx-tertiary hover:bg-app-hover hover:text-accent-primary")}
        >
          {canSwitchBackToLocal ? <CloudOff size={16} /> : <Cloud size={16} />}
          {showLabel && (
            <span className="text-[10px] leading-none mt-0.5 max-w-full truncate px-1">
              {canSwitchBackToLocal ? t("sidebar.switchToLocalShort", "本地") : "连接"}
            </span>
          )}
        </button>
      ) : (
        <button
          onClick={async () => {
            await clearRememberedCredentials();
            await broadcastLogout("user_logout");
            window.location.reload();
          }}
          title={showLabel ? undefined : t("sidebar.logout")}
          aria-label={t("sidebar.logout")}
          className={cn(itemBaseClass, "text-tx-tertiary hover:text-accent-danger hover:bg-accent-danger/10")}
        >
          <LogOut size={16} />
          {showLabel && <span className="text-[10px] leading-none mt-0.5 max-w-full truncate px-1">{t("sidebar.logout")}</span>}
        </button>
      )}

      <AnimatePresence>{showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}</AnimatePresence>
      {accountMenu}
    </div>
  );
}
