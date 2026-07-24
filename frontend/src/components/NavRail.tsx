import React, { useCallback, useEffect, useState } from "react";
import {
  BookOpen,
  BrainCircuit,
  CloudOff,
  Columns2,
  Columns3,
  FolderOpen,
  ListTodo,
  LogOut,
  NotebookPen,
  PanelLeft,
  PanelLeftClose,
  Settings,
  Sparkles,
  Star,
  Trash2,
  X,
} from "lucide-react";
import { AnimatePresence } from "framer-motion";
import { useTranslation } from "react-i18next";
import { useApp, useAppActions } from "@/store/AppContext";
import { api, broadcastLogout, clearServerUrl, getCurrentWorkspace, getServerUrl } from "@/lib/api";
import { ViewMode, WorkspaceFeatures } from "@/types";
import { cn } from "@/lib/utils";
import SettingsModal from "@/components/SettingsModal";
import { RailMode, useRailMode } from "@/hooks/useRailMode";
import {
  clearDesktopLocalAuth,
  getAppInfo,
  getDiagnosticsInfo,
  isDesktop as isDesktopApp,
  switchDesktopToFull,
  type AppInfo,
} from "@/lib/desktopBridge";
import { clearLocalIdMap, clearQueue, getQueueLength } from "@/lib/offlineQueue";
import { clearRememberedCredentials } from "@/lib/rememberLogin";

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
  const [desktopInfo, setDesktopInfo] = useState<AppInfo | null>(null);

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

  const handleDesktopCloudButton = useCallback(async () => {
    if (!canSwitchBackToLocal) return;

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

  const handleLogout = useCallback(async () => {
    await clearRememberedCredentials();
    if (isDesktopApp() && !canSwitchBackToLocal) {
      await clearDesktopLocalAuth().catch(() => ({ ok: false }));
      try {
        localStorage.setItem("nowen-prefer-cloud", "1");
      } catch {
        // ignore storage failures
      }
      await broadcastLogout("desktop_logout_session");
    } else {
      await broadcastLogout("user_logout");
    }
    window.location.reload();
  }, [canSwitchBackToLocal]);

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

      {isDesktopApp() && canSwitchBackToLocal && (
        <button
          onClick={handleDesktopCloudButton}
          title={showLabel ? undefined : t("sidebar.switchToLocal", "切回本地离线模式")}
          aria-label={t("sidebar.switchToLocal", "切回本地离线模式")}
          className={cn(itemBaseClass, "text-tx-tertiary hover:bg-app-hover hover:text-accent-primary")}
        >
          <CloudOff size={16} />
          {showLabel && (
            <span className="text-[10px] leading-none mt-0.5 max-w-full truncate px-1">
              {t("sidebar.switchToLocalShort", "本地")}
            </span>
          )}
        </button>
      )}

      <button
        onClick={handleLogout}
        title={showLabel ? undefined : t("sidebar.logout")}
        aria-label={t("sidebar.logout")}
        className={cn(itemBaseClass, "text-tx-tertiary hover:text-accent-danger hover:bg-accent-danger/10")}
      >
        <LogOut size={16} />
        {showLabel && <span className="text-[10px] leading-none mt-0.5 max-w-full truncate px-1">{t("sidebar.logout")}</span>}
      </button>

      <AnimatePresence>{showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}</AnimatePresence>
    </div>
  );
}
