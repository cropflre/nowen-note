import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { useMobileRailHidden } from "@/hooks/useMobileRailHidden";
import { getAppInfo, isDesktop, setDesktopHideMenuBar } from "@/lib/desktopBridge";
import {
  DESKTOP_KNOWLEDGE_TREE_VIEW_MODE_CHANGED_EVENT,
  DESKTOP_KNOWLEDGE_TREE_VIEW_MODE_STORAGE_KEY,
  loadDesktopKnowledgeTreeViewMode,
  loadMobileKnowledgeTreeCompact,
  loadMobileKnowledgeTreeViewMode,
  MOBILE_KNOWLEDGE_TREE_COMPACT_CHANGED_EVENT,
  MOBILE_KNOWLEDGE_TREE_COMPACT_STORAGE_KEY,
  MOBILE_KNOWLEDGE_TREE_VIEW_MODE_CHANGED_EVENT,
  MOBILE_KNOWLEDGE_TREE_VIEW_MODE_STORAGE_KEY,
  saveDesktopKnowledgeTreeViewMode,
  saveMobileKnowledgeTreeCompact,
  saveMobileKnowledgeTreeViewMode,
  type DesktopKnowledgeTreeViewMode,
  type MobileKnowledgeTreeViewMode,
} from "@/lib/mobileKnowledgeTreeViewMode";
import { notifyPreferenceSaveFailed } from "./preferenceFeedback";

export type LayoutSurface = "mobile" | "desktop";

/** Same breakpoint (Tailwind `md`) at which App switches between the mobile drawer and the desktop sidebar. */
export const MOBILE_LAYOUT_QUERY = "(max-width: 767px)";

function readLayoutSurface(): LayoutSurface {
  try {
    return window.matchMedia?.(MOBILE_LAYOUT_QUERY).matches ? "mobile" : "desktop";
  } catch {
    return "desktop";
  }
}

/** The layout this window is showing now, so only the options that apply to it are offered. */
export function useLayoutSurface(): LayoutSurface {
  const [surface, setSurface] = useState<LayoutSurface>(readLayoutSurface);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(MOBILE_LAYOUT_QUERY);
    const update = () => setSurface(media.matches ? "mobile" : "desktop");
    update();
    // Older Android WebViews only implement addListener on MediaQueryList.
    if (typeof media.addEventListener === "function") {
      media.addEventListener("change", update);
      return () => media.removeEventListener("change", update);
    }
    media.addListener(update);
    return () => media.removeListener(update);
  }, []);
  return surface;
}

function useStoredValue<T>(load: () => T, storageKey: string, changedEvent: string): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(load);
  useEffect(() => {
    const sync = () => setValue(load());
    const syncStorage = (event: StorageEvent) => {
      if (event.key === storageKey) sync();
    };
    window.addEventListener(changedEvent, sync);
    window.addEventListener("storage", syncStorage);
    return () => {
      window.removeEventListener(changedEvent, sync);
      window.removeEventListener("storage", syncStorage);
    };
  }, [load, storageKey, changedEvent]);
  return [value, setValue];
}

/** Device-only layout switches. Storage keys and change events are shared with the sidebar. */
export function useDeviceLayoutPreferences() {
  const [mobileRailHidden, setMobileRailHidden] = useMobileRailHidden();
  const [mobileKnowledgeTreeMode, setMobileKnowledgeTreeMode] = useStoredValue<MobileKnowledgeTreeViewMode>(
    loadMobileKnowledgeTreeViewMode,
    MOBILE_KNOWLEDGE_TREE_VIEW_MODE_STORAGE_KEY,
    MOBILE_KNOWLEDGE_TREE_VIEW_MODE_CHANGED_EVENT,
  );
  const [mobileKnowledgeTreeCompact, setMobileKnowledgeTreeCompact] = useStoredValue<boolean>(
    loadMobileKnowledgeTreeCompact,
    MOBILE_KNOWLEDGE_TREE_COMPACT_STORAGE_KEY,
    MOBILE_KNOWLEDGE_TREE_COMPACT_CHANGED_EVENT,
  );
  const [desktopKnowledgeTreeMode, setDesktopKnowledgeTreeMode] = useStoredValue<DesktopKnowledgeTreeViewMode>(
    loadDesktopKnowledgeTreeViewMode,
    DESKTOP_KNOWLEDGE_TREE_VIEW_MODE_STORAGE_KEY,
    DESKTOP_KNOWLEDGE_TREE_VIEW_MODE_CHANGED_EVENT,
  );

  const setMobileTreeEnabled = useCallback((treeEnabled: boolean) => {
    const nextMode: MobileKnowledgeTreeViewMode = treeEnabled ? "tree" : "navigator";
    setMobileKnowledgeTreeMode(nextMode);
    saveMobileKnowledgeTreeViewMode(nextMode);
  }, [setMobileKnowledgeTreeMode]);

  const setMobileTreeCompact = useCallback((nextCompact: boolean) => {
    setMobileKnowledgeTreeCompact(nextCompact);
    saveMobileKnowledgeTreeCompact(nextCompact);
  }, [setMobileKnowledgeTreeCompact]);

  const setDesktopQuickBrowse = useCallback((quickEnabled: boolean) => {
    const nextMode: DesktopKnowledgeTreeViewMode = quickEnabled ? "quick" : "tree";
    setDesktopKnowledgeTreeMode(nextMode);
    saveDesktopKnowledgeTreeViewMode(nextMode);
  }, [setDesktopKnowledgeTreeMode]);

  return {
    mobileRailHidden,
    setMobileRailHidden,
    mobileTreeEnabled: mobileKnowledgeTreeMode === "tree",
    setMobileTreeEnabled,
    mobileTreeCompact: mobileKnowledgeTreeCompact,
    setMobileTreeCompact,
    desktopQuickBrowse: desktopKnowledgeTreeMode === "quick",
    setDesktopQuickBrowse,
  };
}

/** Windows/Linux desktop shell only; macOS has no in-window menu bar. */
export function useDesktopMenuBarPreference() {
  const { t } = useTranslation();
  const desktop = isDesktop();
  const [platform, setPlatform] = useState<string | null>(null);
  const [hidden, setHidden] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!desktop) return;
    let cancelled = false;
    getAppInfo()
      .then((info) => {
        if (cancelled) return;
        setHidden(!!info?.hideMenuBar);
        setPlatform(info?.platform ?? null);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [desktop]);

  const setMenuBarHidden = useCallback(async (hide: boolean) => {
    const previous = hidden;
    setHidden(hide);
    setSaving(true);
    try {
      const result = await setDesktopHideMenuBar(hide);
      if (!result.ok) throw new Error(result.reason || "");
      if (typeof result.hideMenuBar === "boolean") setHidden(result.hideMenuBar);
    } catch (error) {
      setHidden(previous);
      notifyPreferenceSaveFailed(t, error);
    } finally {
      setSaving(false);
    }
  }, [hidden, t]);

  return {
    supported: desktop && platform !== null && platform !== "darwin",
    hidden,
    saving,
    setMenuBarHidden,
  };
}
