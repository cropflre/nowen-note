import { useEffect, useMemo, useRef, useState, type ChangeEvent, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { AlertTriangle, Search, Sparkles, X } from "lucide-react";
import {
  SHORTCUT_CATEGORY_LABELS,
  SHORTCUT_COMMANDS,
  detectShortcutPlatform,
  detectShortcutSurface,
  findShortcutConflicts,
  formatShortcutForCommand,
  getShortcutChords,
  shortcutMatchesEvent,
  type ShortcutCategory,
} from "@/lib/shortcutRegistry";
import { installShortcutTooltipBridge } from "@/lib/shortcutTooltipBridge";
import { SHORTCUT_OVERRIDES_CHANGED_EVENT } from "@/lib/shortcutOverrides";
import {
  MOTION_SPRING,
  dialogMotion,
  overlayMotion,
} from "@/lib/motion";
import {
  Keycap,
  PlayfulKeycapEmblem,
  ShortcutChordCaps,
} from "@/components/shortcuts/ShortcutVisualKit";
import {
  SHORTCUT_CATEGORY_META,
  SHORTCUT_CATEGORY_ORDER,
  extractLiveModifierTokens,
  extractLivePrimaryToken,
  formatPlatformDisplayName,
  formatPlatformKeyToken,
} from "@/components/shortcuts/shortcutVisualMeta";
import { cn } from "@/lib/utils";

export const OPEN_SHORTCUT_HELP_EVENT = "nowen:open-shortcut-help";

type HelpCategoryFilter = "all" | ShortcutCategory;

export default function ShortcutHelpCenter() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeCategory, setActiveCategory] = useState<HelpCategoryFilter>("all");
  const [shortcutRevision, setShortcutRevision] = useState(0);
  const [liveTokens, setLiveTokens] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const clearLiveTimerRef = useRef<number | null>(null);
  const platform = detectShortcutPlatform();
  const surface = detectShortcutSurface();

  useEffect(() => installShortcutTooltipBridge(), []);

  useEffect(() => {
    const refresh = () => setShortcutRevision((value) => value + 1);
    window.addEventListener(SHORTCUT_OVERRIDES_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(SHORTCUT_OVERRIDES_CHANGED_EVENT, refresh);
  }, []);

  useEffect(() => {
    const openHelp = () => setOpen(true);
    const onKeyDown = (event: KeyboardEvent) => {
      if (shortcutMatchesEvent("shortcut-help", event, platform, surface)) {
        event.preventDefault();
        setOpen(true);
      } else if (open && event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
      }
    };
    window.addEventListener(OPEN_SHORTCUT_HELP_EVENT, openHelp);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener(OPEN_SHORTCUT_HELP_EVENT, openHelp);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open, platform, surface]);

  useEffect(() => {
    if (!open) {
      setLiveTokens([]);
      return;
    }
    setQuery("");
    setActiveCategory("all");
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  // Live keypress echo when modal is open: holding modifiers or pressing chords
  // lights up matching keycaps in real time (without interfering with plain typing in search).
  useEffect(() => {
    if (!open) return;

    const scheduleClear = () => {
      if (clearLiveTimerRef.current !== null) window.clearTimeout(clearLiveTimerRef.current);
      clearLiveTimerRef.current = window.setTimeout(() => {
        setLiveTokens([]);
        clearLiveTimerRef.current = null;
      }, 900);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") return;
      const modifiers = extractLiveModifierTokens(event, platform);
      const inSearchInput = event.target === inputRef.current;

      // When typing plain text inside search, only react if a modifier chord is held.
      if (inSearchInput && modifiers.length === 0) return;

      const primary = extractLivePrimaryToken(event);
      const nextTokens = primary ? [...modifiers, primary] : modifiers;
      if (nextTokens.length === 0) return;

      if (clearLiveTimerRef.current !== null) {
        window.clearTimeout(clearLiveTimerRef.current);
        clearLiveTimerRef.current = null;
      }
      setLiveTokens(nextTokens);
      if (primary) scheduleClear();
    };

    const onKeyUp = (event: KeyboardEvent) => {
      const modifiers = extractLiveModifierTokens(event, platform);
      if (modifiers.length === 0 && clearLiveTimerRef.current === null) {
        setLiveTokens([]);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      if (clearLiveTimerRef.current !== null) {
        window.clearTimeout(clearLiveTimerRef.current);
        clearLiveTimerRef.current = null;
      }
    };
  }, [open, platform]);

  const allAvailableCommands = useMemo(() => {
    void shortcutRevision;
    return SHORTCUT_COMMANDS
      .filter((command) => command.availableIn.includes(surface))
      .filter((command) => formatShortcutForCommand(command.id, platform, surface));
  }, [platform, shortcutRevision, surface]);

  const categoryCounts = useMemo(() => {
    const counts = new Map<ShortcutCategory, number>();
    for (const category of SHORTCUT_CATEGORY_ORDER) {
      const count = allAvailableCommands.filter(
        (command) => command.category === category || command.secondaryCategories?.includes(category),
      ).length;
      if (count > 0) counts.set(category, count);
    }
    return counts;
  }, [allAvailableCommands]);

  const commands = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return allAvailableCommands.filter((command) => {
      if (!needle) return true;
      const chordText = formatShortcutForCommand(command.id, platform, surface);
      return [
        command.label,
        command.description,
        SHORTCUT_CATEGORY_LABELS[command.category],
        ...(command.secondaryCategories ?? []).map((category) => SHORTCUT_CATEGORY_LABELS[category]),
        chordText,
      ].join(" ").toLowerCase().includes(needle);
    });
  }, [allAvailableCommands, platform, query, surface]);

  const groups = useMemo(
    () => SHORTCUT_CATEGORY_ORDER
      .filter((category) => activeCategory === "all" || activeCategory === category)
      .map((category) => ({
        category,
        commands: commands.filter(
          (command) => command.category === category || command.secondaryCategories?.includes(category),
        ),
      }))
      .filter((group) => group.commands.length > 0),
    [activeCategory, commands],
  );

  const conflicts = useMemo(() => {
    void shortcutRevision;
    return findShortcutConflicts();
  }, [shortcutRevision]);
  const liveTokenSet = useMemo(() => new Set(liveTokens), [liveTokens]);
  const platformLabel = formatPlatformDisplayName(platform);
  const surfaceLabel = surface === "desktop" ? "桌面端" : "Web 端";

  const filterTabs: Array<{ id: HelpCategoryFilter; label: string; count: number }> = [
    { id: "all", label: "全部", count: allAvailableCommands.length },
    ...SHORTCUT_CATEGORY_ORDER
      .filter((category) => (categoryCounts.get(category) ?? 0) > 0)
      .map((category) => ({
        id: category as HelpCategoryFilter,
        label: SHORTCUT_CATEGORY_LABELS[category],
        count: categoryCounts.get(category) ?? 0,
      })),
  ];

  const modal = typeof document !== "undefined" ? createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          key="shortcut-help-overlay"
          initial={overlayMotion.initial}
          animate={overlayMotion.animate}
          exit={overlayMotion.exit}
          className="fixed inset-0 z-[260] flex items-center justify-center p-4"
          onMouseDown={(event: MouseEvent<HTMLDivElement>) => {
            if (event.target === event.currentTarget) setOpen(false);
          }}
        >
          <div className="absolute inset-0 bg-black/45 backdrop-blur-sm" aria-hidden />
          <motion.section
            role="dialog"
            aria-modal="true"
            aria-labelledby="shortcut-help-title"
            initial={dialogMotion.initial}
            animate={dialogMotion.animate}
            exit={dialogMotion.exit}
            className="relative flex max-h-[84vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-app-border bg-app-elevated shadow-dialog"
            onMouseDown={(event: MouseEvent<HTMLElement>) => event.stopPropagation()}
          >
            {/* Header */}
            <header className="flex flex-wrap items-center gap-3 border-b border-app-border px-5 py-4">
              <PlayfulKeycapEmblem platform={platform} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 id="shortcut-help-title" className="text-base font-bold tracking-tight text-tx-primary">
                    键盘快捷键
                  </h2>
                  <span className="rounded-full border border-app-border bg-app-surface px-2.5 py-0.5 text-[11px] font-medium text-tx-secondary">
                    {platformLabel} · {surfaceLabel}
                  </span>
                </div>
                <p className="mt-0.5 text-xs text-tx-tertiary">
                  轻敲组合键实时点亮对应招式，或输入关键词快速定位
                </p>
              </div>

              {/* Live Keypress Echo Pill */}
              <div className="hidden items-center gap-2 rounded-xl border border-app-border bg-app-surface px-3 py-1.5 sm:flex">
                {liveTokens.length > 0 ? (
                  <>
                    <span className="text-[11px] font-medium text-accent-primary">正在按下</span>
                    <div className="flex items-center gap-1 pb-[2px]">
                      {liveTokens.map((token, index) => (
                        <Keycap key={`${token}-${index}`} size="sm" variant="active" pressed>
                          {formatPlatformKeyToken(token, platform)}
                        </Keycap>
                      ))}
                    </div>
                  </>
                ) : (
                  <span className="inline-flex items-center gap-1.5 text-[11px] text-tx-tertiary">
                    <Sparkles size={12} className="text-amber-500" />
                    按住 {platform === "macos" ? "⌘" : "Ctrl"} 试试点亮键帽
                  </span>
                )}
              </div>

              <button
                type="button"
                onClick={() => setOpen(false)}
                className="nowen-press rounded-xl p-2 text-tx-secondary hover:bg-app-hover hover:text-tx-primary"
                aria-label="关闭快捷键帮助"
              >
                <X size={18} />
              </button>
            </header>

            {/* Search + Category Filter Pills */}
            <div className="space-y-3 border-b border-app-border bg-app-surface/50 px-5 py-3.5">
              <label className="group flex items-center gap-2 rounded-xl border border-app-border bg-app-elevated px-3 py-2 transition-interactive duration-fast focus-within:border-accent-primary focus-within:shadow-sm">
                <Search size={15} className="shrink-0 text-tx-tertiary transition-colors group-focus-within:text-accent-primary" />
                <input
                  ref={inputRef}
                  value={query}
                  onChange={(event: ChangeEvent<HTMLInputElement>) => setQuery(event.target.value)}
                  placeholder="搜索命令、分类或组合键…"
                  className="min-w-0 flex-1 bg-transparent text-sm text-tx-primary outline-none placeholder:text-tx-tertiary"
                  spellCheck={false}
                />
                {query && (
                  <button
                    type="button"
                    onClick={() => setQuery("")}
                    className="rounded-md p-0.5 text-tx-tertiary transition-colors hover:bg-app-hover hover:text-tx-primary"
                    aria-label="清空搜索"
                  >
                    <X size={14} />
                  </button>
                )}
              </label>

              <div role="tablist" aria-label="帮助中心分类筛选" className="flex flex-wrap items-center gap-1.5">
                {filterTabs.map((tab) => {
                  const isActive = activeCategory === tab.id;
                  return (
                    <button
                      key={tab.id}
                      type="button"
                      role="tab"
                      aria-selected={isActive}
                      onClick={() => setActiveCategory(tab.id)}
                      className={cn(
                        "relative inline-flex items-center gap-1.5 rounded-xl px-2.5 py-1 text-xs font-medium transition-colors",
                        isActive ? "text-tx-primary" : "text-tx-secondary hover:text-tx-primary",
                      )}
                    >
                      {isActive && (
                        <motion.span
                          layoutId="shortcut-help-category-pill"
                          transition={MOTION_SPRING.snappy}
                          className="absolute inset-0 rounded-xl border border-app-border bg-app-elevated shadow-sm"
                        />
                      )}
                      <span className="relative z-10">{tab.label}</span>
                      <span className="relative z-10 text-[10px] tabular-nums text-tx-tertiary">
                        {tab.count}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            {conflicts.length > 0 && (
              <div className="mx-5 mt-4 flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3.5 py-2.5 text-xs text-amber-700 dark:text-amber-300">
                <AlertTriangle size={15} className="mt-0.5 shrink-0" />
                <span>检测到 {conflicts.length} 组快捷键冲突，请在合并前修复注册表。</span>
              </div>
            )}

            {/* Shortcut Grid Body */}
            <div className="flex-1 overflow-y-auto px-5 py-4">
              {groups.length === 0 ? (
                <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-app-border bg-app-surface/40 px-6 py-12 text-center">
                  <div className="mb-3 flex items-center gap-1.5 opacity-80">
                    <Keycap variant="modifier">?</Keycap>
                    <Keycap variant="ghost">没找到</Keycap>
                  </div>
                  <p className="text-sm font-medium text-tx-primary">键盘上好像还没有这招</p>
                  <p className="mt-1 text-xs text-tx-tertiary">试试别的关键词，或者切回全部快捷键</p>
                  <button
                    type="button"
                    onClick={() => {
                      setQuery("");
                      setActiveCategory("all");
                    }}
                    className="nowen-press mt-4 rounded-xl border border-app-border bg-app-elevated px-3.5 py-1.5 text-xs font-medium text-tx-primary hover:bg-app-hover"
                  >
                    显示全部快捷键
                  </button>
                </div>
              ) : (
                <div className="space-y-6">
                  {groups.map((group) => {
                    const meta = SHORTCUT_CATEGORY_META[group.category];
                    const CategoryIcon = meta.icon;
                    return (
                      <section key={group.category} aria-label={meta.label}>
                        <div className="mb-2.5 flex items-center gap-2">
                          <span className={cn("inline-flex h-6 w-6 items-center justify-center rounded-lg", meta.badgeClass)}>
                            <CategoryIcon size={13} />
                          </span>
                          <h3 className="text-xs font-semibold tracking-wide text-tx-primary">
                            {meta.label}
                          </h3>
                          <span className="text-[11px] text-tx-tertiary">· {meta.tagline}</span>
                        </div>

                        <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                          {group.commands.map((command) => {
                            const chord = getShortcutChords(command.id, platform, surface)[0];
                            const exactMatch = Boolean(
                              chord
                              && liveTokens.length > 0
                              && chord.length === liveTokens.length
                              && chord.every((token) => liveTokenSet.has(token)),
                            );
                            const partialMatch = Boolean(
                              !exactMatch
                              && chord
                              && liveTokens.length > 0
                              && liveTokens.every((token) => chord.includes(token)),
                            );

                            return (
                              <div
                                key={`${group.category}:${command.id}`}
                                className={cn(
                                  "nowen-shortcut-row flex items-center justify-between gap-3 rounded-xl border px-3.5 py-2.5",
                                  exactMatch
                                    ? "border-accent-primary bg-accent-primary/10 shadow-sm"
                                    : partialMatch
                                      ? "border-accent-primary/40 bg-app-surface"
                                      : "border-app-border bg-app-surface/65 hover:border-tx-tertiary/40 hover:bg-app-hover/65",
                                )}
                              >
                                <div className="min-w-0 flex-1">
                                  <div className="truncate text-sm font-medium text-tx-primary">
                                    {command.label}
                                  </div>
                                  <div className="mt-0.5 truncate text-[11px] text-tx-tertiary">
                                    {command.description}
                                  </div>
                                </div>
                                <ShortcutChordCaps
                                  chord={chord}
                                  platform={platform}
                                  size="sm"
                                  state={exactMatch ? "active" : "idle"}
                                  pressedTokens={partialMatch || exactMatch ? liveTokenSet : undefined}
                                  interactive
                                  className="shrink-0"
                                />
                              </div>
                            );
                          })}
                        </div>
                      </section>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Footer */}
            <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-app-border bg-app-surface/60 px-5 py-3 text-[11px] text-tx-tertiary">
              <span>工具栏悬停提示与当前运行端使用同一套键位</span>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="inline-flex items-center gap-1.5 text-tx-secondary transition-colors hover:text-tx-primary"
              >
                <Keycap size="sm" variant="modifier" interactive>
                  Esc
                </Keycap>
                <span>关闭</span>
              </button>
            </footer>
          </motion.section>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  ) : null;

  return surface !== "android" ? modal : null;
}
