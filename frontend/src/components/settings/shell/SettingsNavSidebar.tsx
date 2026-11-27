import React, { useMemo, useRef, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { Search, Settings, Sparkles, X } from "lucide-react";
import { MOTION_SPRING } from "@/lib/motion";
import { cn } from "@/lib/utils";
import {
  SETTINGS_NAV_GROUP_META,
  SETTINGS_NAV_GROUP_ORDER,
  SETTINGS_TAB_META,
  matchesSettingsSearch,
  type SettingsNavGroupId,
  type SettingsNavItem,
  type SettingsTabId,
} from "./settingsNavMeta";
import { PlayfulKbdHint, PlayfulSettingsEmblem } from "./SettingsVisualKit";

interface SettingsDesktopSidebarProps {
  title: string;
  siteTitle: string;
  appVersion: string;
  isEnglish: boolean;
  tabs: SettingsNavItem[];
  activeTab: SettingsTabId;
  searchQuery: string;
  onSearchChange: (value: string) => void;
  searchInputRef: React.RefObject<HTMLInputElement | null>;
  onSelectTab: (tabId: SettingsTabId) => void;
}

export function SettingsDesktopSidebar({
  title,
  siteTitle,
  appVersion,
  isEnglish,
  tabs,
  activeTab,
  searchQuery,
  onSearchChange,
  searchInputRef,
  onSelectTab,
}: SettingsDesktopSidebarProps) {
  const reducedMotion = useReducedMotion();
  const [gearTaps, setGearTaps] = useState(0);

  const groupedTabs = useMemo(() => {
    const filtered = tabs.filter((tab) => matchesSettingsSearch(tab, searchQuery));
    const map = new Map<SettingsNavGroupId, SettingsNavItem[]>();
    for (const group of SETTINGS_NAV_GROUP_ORDER) map.set(group, []);
    for (const tab of filtered) {
      const group = SETTINGS_TAB_META[tab.id].group;
      map.get(group)?.push(tab);
    }
    return SETTINGS_NAV_GROUP_ORDER
      .map((groupId) => ({
        groupId,
        meta: SETTINGS_NAV_GROUP_META[groupId],
        items: map.get(groupId) ?? [],
      }))
      .filter((entry) => entry.items.length > 0);
  }, [tabs, searchQuery]);

  const hasAbout = tabs.some((tab) => tab.id === "about");

  return (
    <aside className="nowen-settings-sidebar hidden min-h-0 w-64 flex-shrink-0 flex-col border-r border-zinc-200/80 p-3.5 dark:border-zinc-800/80 md:flex">
      {/* Playful brand header */}
      <div className="mb-3 flex items-center gap-2.5 px-1">
        <PlayfulSettingsEmblem
          icon={Settings}
          toneClass="from-indigo-500/20 to-sky-500/20 text-indigo-600 ring-indigo-500/25 dark:text-indigo-300"
          size="sm"
          title={title}
          onBoop={setGearTaps}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-bold tracking-tight text-zinc-900 dark:text-zinc-100">
              {title}
            </span>
            {gearTaps >= 5 && (
              <span className="rounded-full bg-indigo-500/15 px-1.5 py-0.5 text-[9px] font-semibold text-indigo-600 dark:text-indigo-300">
                ⚡
              </span>
            )}
          </div>
          <p className="truncate text-[10px] text-zinc-400 dark:text-zinc-500">
            {isEnglish ? "Tune your personal vault" : "调校你的专属知识空间"}
          </p>
        </div>
      </div>

      {/* Quick search box with 3D "/" keycap hint */}
      <div className="relative mb-3">
        <Search
          size={13}
          aria-hidden
          className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-400"
        />
        <input
          ref={searchInputRef}
          type="text"
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder={isEnglish ? "Quick find..." : "快速查找设置..."}
          aria-label={isEnglish ? "Quick find settings" : "快速查找设置"}
          className="w-full rounded-xl border border-zinc-200/85 bg-white/80 py-1.5 pl-8 pr-8 text-xs text-zinc-800 shadow-2xs outline-none transition-all placeholder:text-zinc-400 focus:border-accent-primary/60 focus:bg-white focus:ring-2 focus:ring-accent-primary/20 dark:border-zinc-700/80 dark:bg-zinc-900/70 dark:text-zinc-100 dark:focus:bg-zinc-900"
        />
        {searchQuery ? (
          <button
            type="button"
            onClick={() => onSearchChange("")}
            aria-label={isEnglish ? "Clear search" : "清空搜索"}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-0.5 text-zinc-400 hover:bg-zinc-200/60 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
          >
            <X size={12} />
          </button>
        ) : (
          <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2">
            <PlayfulKbdHint>/</PlayfulKbdHint>
          </span>
        )}
      </div>

      {/* Grouped navigation */}
      <nav
        aria-label="设置分类"
        className="min-h-0 flex-1 space-y-3.5 overflow-y-auto overscroll-contain pr-1"
      >
        {groupedTabs.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-zinc-200/90 px-3 py-6 text-center dark:border-zinc-800">
            <Sparkles size={18} className="mx-auto text-zinc-400" aria-hidden />
            <p className="mt-2 text-xs font-medium text-zinc-500 dark:text-zinc-400">
              {isEnglish ? "No matching settings" : "没找到这个设置项"}
            </p>
            <button
              type="button"
              onClick={() => onSearchChange("")}
              className="mt-2 rounded-lg bg-zinc-900/5 px-2.5 py-1 text-[11px] font-medium text-accent-primary hover:bg-zinc-900/10 dark:bg-white/5 dark:hover:bg-white/10"
            >
              {isEnglish ? "Show all" : "查看全部"}
            </button>
          </div>
        ) : (
          groupedTabs.map(({ groupId, meta, items }) => (
            <div key={groupId} className="space-y-0.5">
              <div className="flex items-center gap-1.5 px-2.5 pb-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
                <span aria-hidden className={cn("h-1.5 w-1.5 rounded-full opacity-80", meta.dotClass)} />
                <span>{isEnglish ? meta.labelEn : meta.labelZh}</span>
              </div>
              {items.map((tab) => {
                const Icon = tab.icon;
                const tabMeta = SETTINGS_TAB_META[tab.id];
                const isActive = activeTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    aria-current={isActive ? "page" : undefined}
                    onClick={() => onSelectTab(tab.id)}
                    className={cn(
                      "group/nav relative flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/60",
                      isActive
                        ? tabMeta.activeText
                        : "text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100",
                    )}
                  >
                    {isActive && (
                      <motion.span
                        layoutId="nowen-settings-active-pill"
                        transition={reducedMotion ? { duration: 0 } : MOTION_SPRING.snappy}
                        aria-hidden
                        className="nowen-settings-nav-pill absolute inset-0 rounded-xl border border-zinc-200/80 dark:border-white/10"
                      >
                        <span
                          className={cn(
                            "absolute left-1 top-1/2 h-4 w-1 -translate-y-1/2 rounded-full",
                            tabMeta.activeBar,
                          )}
                        />
                      </motion.span>
                    )}
                    {!isActive && (
                      <span
                        aria-hidden
                        className="absolute inset-0 rounded-xl bg-zinc-200/0 transition-colors group-hover/nav:bg-zinc-200/45 dark:group-hover/nav:bg-white/[0.045]"
                      />
                    )}
                    <span
                      aria-hidden
                      className={cn(
                        "relative z-10 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-lg transition-all",
                        isActive
                          ? cn("bg-gradient-to-br ring-1 ring-inset", tabMeta.badgeTone)
                          : "bg-zinc-200/50 text-zinc-500 group-hover/nav:bg-white/80 group-hover/nav:text-zinc-800 dark:bg-white/[0.05] dark:text-zinc-400 dark:group-hover/nav:bg-white/10 dark:group-hover/nav:text-zinc-100",
                      )}
                    >
                      <Icon
                        className={cn("h-3.5 w-3.5", `nowen-nav-icon--${tabMeta.motion}`)}
                      />
                    </span>
                    <span className="relative z-10 truncate">{tab.label}</span>
                  </button>
                );
              })}
            </div>
          ))
        )}
      </nav>

      {/* Bottom playful version pill */}
      <div className="mt-3 border-t border-zinc-200/70 pt-3 dark:border-zinc-800/80">
        <button
          type="button"
          onClick={() => { if (hasAbout) onSelectTab("about"); }}
          className="nowen-tactile-btn flex w-full items-center justify-between gap-2 rounded-xl border border-zinc-200/70 bg-white/70 px-2.5 py-1.5 text-left text-[11px] text-zinc-500 hover:border-accent-primary/40 hover:text-zinc-800 dark:border-zinc-800/80 dark:bg-zinc-900/50 dark:text-zinc-400 dark:hover:text-zinc-200"
        >
          <span className="truncate font-medium">{siteTitle}</span>
          <span className="shrink-0 rounded-full bg-indigo-500/10 px-2 py-0.5 font-mono text-[10px] font-semibold text-indigo-600 dark:text-indigo-300">
            v{appVersion}
          </span>
        </button>
      </div>
    </aside>
  );
}

interface SettingsMobileTopBarProps {
  tabs: SettingsNavItem[];
  activeTab: SettingsTabId;
  mobileTabsRef: React.RefObject<HTMLDivElement | null>;
  onSelectTab: (tabId: SettingsTabId) => void;
  onClose: () => void;
}

export function SettingsMobileTopBar({
  tabs,
  activeTab,
  mobileTabsRef,
  onSelectTab,
  onClose,
}: SettingsMobileTopBarProps) {
  const reducedMotion = useReducedMotion();
  const scrollRef = useRef<HTMLDivElement | null>(null);

  return (
    <div
      className="sticky top-0 z-10 flex items-center border-b border-zinc-200/85 bg-zinc-50/95 backdrop-blur-md dark:border-zinc-800 dark:bg-zinc-900/95 md:hidden"
      style={{ paddingTop: "var(--safe-area-top)", touchAction: "pan-x" }}
    >
      <div
        ref={(node) => {
          scrollRef.current = node;
          (mobileTabsRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
        }}
        className="no-scrollbar flex flex-1 items-center gap-1.5 overflow-x-auto px-3 py-2"
        style={{ touchAction: "pan-x" }}
      >
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const tabMeta = SETTINGS_TAB_META[tab.id];
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              aria-current={isActive ? "page" : undefined}
              onClick={() => onSelectTab(tab.id)}
              className={cn(
                "relative flex min-h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-xl px-3 py-1.5 text-xs font-medium transition-colors",
                isActive
                  ? tabMeta.activeText
                  : "text-zinc-500 active:bg-zinc-200/40 dark:text-zinc-400 dark:active:bg-zinc-800/50",
              )}
            >
              {isActive && (
                <motion.span
                  layoutId="nowen-settings-mobile-pill"
                  transition={reducedMotion ? { duration: 0 } : MOTION_SPRING.snappy}
                  aria-hidden
                  className="nowen-settings-nav-pill absolute inset-0 rounded-xl border border-zinc-200/80 dark:border-white/10"
                />
              )}
              <Icon className="relative z-10 h-3.5 w-3.5" aria-hidden />
              <span className="relative z-10">{tab.label}</span>
            </button>
          );
        })}
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label="关闭设置"
        className="mr-2 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-zinc-400 transition-colors hover:bg-zinc-200/60 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
      >
        <X className="h-5 w-5" />
      </button>
    </div>
  );
}
