import React, { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowLeftRight,
  BrainCircuit,
  CircleDot,
  FolderOpen,
  Link2,
  ListTodo,
  NotebookPen,
  Settings,
  Sparkles,
  Star,
  Trash2,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { useAIConnectionAvailable } from "@/lib/aiConnection";
import { api, getCurrentWorkspace } from "@/lib/api";
import { pushAppPathState, resolveCurrentAppPathname } from "@/lib/appPathNavigation";
import { getCurrentMindMapAppRoute, pushMindMapAppPath } from "@/lib/mindMapDeepLink";
import { registerMobileBackHandler } from "@/lib/mobileBackNavigation";
import { isMobileLocalMode, requestMobileAccountLogin } from "@/lib/mobileLocalMode";
import { MOTION_SPRING, overlayMotion } from "@/lib/motion";
import { isNavigationModuleVisible, type NavigationModuleId } from "@/lib/navigationVisibility";
import { openWorkspaceIssue, parseIssueAppPath } from "@/lib/workspaceIssueNavigation";
import { useUserPreferences } from "@/hooks/useUserPreferences";
import { cn } from "@/lib/utils";
import { useApp, useAppActions } from "@/store/AppContext";
import type { ViewMode, WorkspaceFeatures } from "@/types";

export interface MobileLiteMoreSheetProps {
  open: boolean;
  onClose: () => void;
  onSwitchToFullMode: () => void;
}

interface MoreModuleItem {
  id: string;
  mode: ViewMode;
  labelKey: string;
  icon: React.ReactNode;
  feature?: keyof WorkspaceFeatures;
  navModuleId?: NavigationModuleId;
  cloudOnly?: boolean;
  danger?: boolean;
}

export default function MobileLiteMoreSheet({
  open,
  onClose,
  onSwitchToFullMode,
}: MobileLiteMoreSheetProps) {
  const { t } = useTranslation();
  const { state } = useApp();
  const actions = useAppActions();
  const { prefs: userPrefs } = useUserPreferences();
  const aiAvailable = useAIConnectionAvailable();
  const localDeviceMode = isMobileLocalMode();
  const [workspaceId, setWorkspaceId] = useState(getCurrentWorkspace);
  const [features, setFeatures] = useState<WorkspaceFeatures | null>(null);

  useEffect(() => {
    if (!open) return;
    return registerMobileBackHandler("sheet", () => {
      onClose();
      return true;
    });
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  useEffect(() => {
    const load = () => {
      const ws = getCurrentWorkspace();
      setWorkspaceId(ws);
      if (!ws || ws === "personal" || localDeviceMode) {
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
  }, [localDeviceMode]);

  const navigateToMode = (mode: ViewMode, cloudOnly?: boolean) => {
    onClose();
    if (localDeviceMode && cloudOnly) {
      requestMobileAccountLogin();
      window.location.reload();
      return;
    }
    if (mode === "issues") {
      openWorkspaceIssue(null);
    } else if (parseIssueAppPath(resolveCurrentAppPathname()).matched) {
      pushAppPathState("/");
    }
    if (mode === "mindmaps") {
      pushMindMapAppPath(null);
    } else if (getCurrentMindMapAppRoute().matched) {
      pushAppPathState("/");
    }
    actions.setViewMode(mode);
    actions.setSelectedNotebook(null);
    if (mode === "favorites") {
      actions.setMobileView("list");
    }
    actions.setMobileSidebar(false);
  };

  const candidateModules: MoreModuleItem[] = [
    { id: "favorites", mode: "favorites", labelKey: "mobileLite.more.favorites", icon: <Star size={20} className="text-amber-400" />, feature: "favorites", navModuleId: "favorites" },
    { id: "tasks", mode: "tasks", labelKey: "mobileLite.more.tasks", icon: <ListTodo size={20} className="text-sky-500" />, feature: "tasks", navModuleId: "tasks" },
    { id: "mindmaps", mode: "mindmaps", labelKey: "mobileLite.more.mindmaps", icon: <BrainCircuit size={20} className="text-violet-500" />, feature: "mindmaps", navModuleId: "mindmaps" },
    { id: "diary", mode: "diary", labelKey: "mobileLite.more.diary", icon: <NotebookPen size={20} className="text-emerald-500" />, feature: "diaries", navModuleId: "diary" },
    { id: "files", mode: "files", labelKey: "mobileLite.more.files", icon: <FolderOpen size={20} className="text-amber-500" />, feature: "files", navModuleId: "files" },
    ...(aiAvailable
      ? [{ id: "ai-chat", mode: "ai-chat" as ViewMode, labelKey: "mobileLite.more.aiChat", icon: <Sparkles size={20} className="text-accent-primary" />, navModuleId: "ai-chat" as NavigationModuleId, cloudOnly: true }]
      : []),
    ...(!localDeviceMode
      ? [{ id: "shares", mode: "shares" as ViewMode, labelKey: "mobileLite.more.shares", icon: <Link2 size={20} className="text-teal-500" />, navModuleId: "shares" as NavigationModuleId, cloudOnly: true }]
      : []),
    ...(!localDeviceMode && workspaceId !== "personal"
      ? [{ id: "issues", mode: "issues" as ViewMode, labelKey: "mobileLite.more.issues", icon: <CircleDot size={20} className="text-indigo-500" />, cloudOnly: true }]
      : []),
  ];

  const modules = candidateModules.filter((item) => {
    if (!localDeviceMode && features && item.feature && features[item.feature] === false) return false;
    if (item.navModuleId && !isNavigationModuleVisible(item.navModuleId, userPrefs.hiddenNavigationModules)) return false;
    return true;
  });

  return (
    <AnimatePresence>
      {open && (
        <div
          data-mobile-lite-more-sheet=""
          data-swipe-blocker="mobile-lite-more"
          className="fixed inset-0 z-50 flex flex-col justify-end md:hidden"
          role="dialog"
          aria-modal="true"
          aria-label={t("mobileLite.more.title")}
        >
          <motion.div
            initial={overlayMotion.initial}
            animate={overlayMotion.animate}
            exit={overlayMotion.exit}
            onClick={onClose}
            className="absolute inset-0 bg-zinc-900/55 backdrop-blur-[2px]"
          />
          <motion.div
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%" }}
            transition={MOTION_SPRING.panel}
            className="relative flex max-h-[82dvh] w-full flex-col overflow-hidden rounded-t-2xl border-t border-app-border bg-app-elevated shadow-2xl"
            style={{ paddingBottom: "var(--safe-area-bottom)" }}
          >
            <div className="flex justify-center pt-2 pb-1 shrink-0" aria-hidden="true">
              <span className="h-1 w-10 rounded-full bg-app-border" />
            </div>

            <div className="flex items-center justify-between px-4 pb-2 shrink-0">
              <h2 className="text-base font-semibold text-tx-primary">
                {t("mobileLite.more.title")}
              </h2>
              <button
                type="button"
                onClick={onClose}
                aria-label={t("mobileLite.more.close")}
                className="flex h-11 w-11 items-center justify-center rounded-xl text-tx-secondary hover:bg-app-hover hover:text-tx-primary"
              >
                <X size={20} />
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 space-y-4">
              {modules.length > 0 && (
                <section>
                  <div className="mb-2 text-xs font-medium text-tx-tertiary">
                    {t("mobileLite.more.modulesSection")}
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    {modules.map((item) => {
                      const active = state.viewMode === item.mode;
                      return (
                        <button
                          key={item.id}
                          type="button"
                          data-mobile-lite-more-item={item.id}
                          onClick={() => navigateToMode(item.mode, item.cloudOnly)}
                          className={cn(
                            "flex min-h-[72px] flex-col items-center justify-center gap-1.5 rounded-2xl border p-2.5 text-xs font-medium transition-colors active:scale-95",
                            active
                              ? "border-accent-primary/40 bg-accent-primary/10 text-accent-primary"
                              : "border-app-border bg-app-surface text-tx-primary hover:bg-app-hover",
                          )}
                        >
                          {item.icon}
                          <span className="max-w-full truncate">{t(item.labelKey)}</span>
                        </button>
                      );
                    })}
                  </div>
                </section>
              )}

              <section>
                <div className="mb-2 text-xs font-medium text-tx-tertiary">
                  {t("mobileLite.more.toolsSection")}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    data-mobile-lite-more-item="trash"
                    onClick={() => navigateToMode("trash")}
                    className={cn(
                      "flex min-h-[48px] items-center justify-center gap-2 rounded-xl border px-3 text-sm font-medium transition-colors active:scale-95",
                      state.viewMode === "trash"
                        ? "border-accent-primary/40 bg-accent-primary/10 text-accent-primary"
                        : "border-app-border bg-app-surface text-tx-primary hover:bg-app-hover",
                    )}
                  >
                    <Trash2 size={17} className="text-tx-tertiary" />
                    <span>{t("mobileLite.more.trash")}</span>
                  </button>
                  <button
                    type="button"
                    data-mobile-lite-more-item="settings"
                    onClick={() => {
                      onClose();
                      window.dispatchEvent(new CustomEvent("nowen:open-settings"));
                    }}
                    className="flex min-h-[48px] items-center justify-center gap-2 rounded-xl border border-app-border bg-app-surface px-3 text-sm font-medium text-tx-primary transition-colors hover:bg-app-hover active:scale-95"
                  >
                    <Settings size={17} className="text-tx-tertiary" />
                    <span>{t("mobileLite.more.settings")}</span>
                  </button>
                </div>
              </section>

              <button
                type="button"
                data-mobile-lite-switch-full=""
                onClick={() => {
                  onClose();
                  onSwitchToFullMode();
                }}
                className="flex w-full items-center gap-3 rounded-2xl border border-accent-primary/30 bg-accent-primary/10 px-4 py-3.5 text-left transition-colors hover:bg-accent-primary/15 active:scale-[0.99]"
              >
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent-primary text-white">
                  <ArrowLeftRight size={18} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold text-accent-primary">
                    {t("mobileLite.switchToFullTitle")}
                  </span>
                  <span className="mt-0.5 block text-xs text-tx-secondary">
                    {t("mobileLite.switchToFullDesc")}
                  </span>
                </span>
              </button>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
