import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  Info,
  Lock,
  Radio,
  RotateCcw,
  Search,
  Sparkles,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import {
  SHORTCUT_CATEGORY_LABELS,
  SHORTCUT_COMMANDS,
  detectShortcutPlatform,
  detectShortcutSurface,
  findShortcutConflictsForCandidate,
  formatShortcutChord,
  getDefaultShortcutChords,
  getShortcutChords,
  validateShortcutChord,
  type ShortcutCategory,
  type ShortcutChord,
} from "@/lib/shortcutRegistry";
import {
  SHORTCUT_OVERRIDES_CHANGED_EVENT,
  exportShortcutOverrides,
  hasShortcutOverride,
  importShortcutOverrides,
  resetAllShortcutOverrides,
  resetShortcutOverride,
  setShortcutOverride,
  shortcutChordFromKeyboardEvent,
} from "@/lib/shortcutOverrides";
import {
  MOTION_DURATION,
  MOTION_EASE,
  MOTION_SPRING,
  dialogMotion,
  overlayMotion,
  toastMotion,
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
  formatPlatformDisplayName,
  formatPlatformKeyToken,
} from "@/components/shortcuts/shortcutVisualMeta";
import { cn } from "@/lib/utils";

interface PendingBinding {
  commandId: string;
  chord: ShortcutChord;
  conflicts: ReturnType<typeof findShortcutConflictsForCandidate>;
}

type CategoryFilter = "all" | "customized" | ShortcutCategory;

export default function ShortcutSettingsPanel() {
  const platform = detectShortcutPlatform();
  const surface = detectShortcutSurface();
  const [query, setQuery] = useState("");
  const [activeCategory, setActiveCategory] = useState<CategoryFilter>("all");
  const [recordingId, setRecordingId] = useState<string | null>(null);
  const [liveModifiers, setLiveModifiers] = useState<string[]>([]);
  const [justSavedId, setJustSavedId] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingBinding | null>(null);
  const [confirmResetAll, setConfirmResetAll] = useState(false);
  const [message, setMessage] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const [revision, setRevision] = useState(0);
  const importRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const savedTimerRef = useRef<number | null>(null);

  useEffect(() => {
    const refresh = () => setRevision((value) => value + 1);
    window.addEventListener(SHORTCUT_OVERRIDES_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(SHORTCUT_OVERRIDES_CHANGED_EVENT, refresh);
  }, []);

  useEffect(() => () => {
    if (savedTimerRef.current !== null) window.clearTimeout(savedTimerRef.current);
  }, []);

  // Press "/" outside inputs to jump straight into search.
  useEffect(() => {
    if (recordingId || pending || confirmResetAll) return;
    const onSlashFocus = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
        return;
      }
      event.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener("keydown", onSlashFocus);
    return () => window.removeEventListener("keydown", onSlashFocus);
  }, [confirmResetAll, pending, recordingId]);

  const surfaceCommands = useMemo(
    () => SHORTCUT_COMMANDS.filter((command) => command.availableIn.includes(surface)),
    [surface],
  );

  const customizedCount = useMemo(() => {
    void revision;
    return surfaceCommands.filter((command) => hasShortcutOverride(command.id, platform)).length;
  }, [platform, revision, surfaceCommands]);

  const categoryCounts = useMemo(() => {
    const counts = new Map<ShortcutCategory, number>();
    for (const category of SHORTCUT_CATEGORY_ORDER) {
      const count = surfaceCommands.filter((command) => command.category === category).length;
      if (count > 0) counts.set(category, count);
    }
    return counts;
  }, [surfaceCommands]);

  const filteredCommands = useMemo(() => {
    void revision;
    const needle = query.trim().toLowerCase();
    return surfaceCommands
      .filter((command) => {
        if (activeCategory === "customized") {
          return hasShortcutOverride(command.id, platform);
        }
        if (activeCategory !== "all" && command.category !== activeCategory) {
          return false;
        }
        return true;
      })
      .filter((command) => {
        if (!needle) return true;
        const current = getShortcutChords(command.id, platform, surface)[0];
        const chordText = current ? formatShortcutChord(current, platform) : "";
        return [
          command.label,
          command.description,
          SHORTCUT_CATEGORY_LABELS[command.category],
          chordText,
        ].join(" ").toLowerCase().includes(needle);
      });
  }, [activeCategory, platform, query, revision, surface, surfaceCommands]);

  const groups = useMemo(
    () => SHORTCUT_CATEGORY_ORDER
      .map((category) => ({
        category,
        commands: filteredCommands.filter((command) => command.category === category),
      }))
      .filter((group) => group.commands.length > 0),
    [filteredCommands],
  );

  // If user clears the last customized binding while on "customized" tab, glide back to "all".
  useEffect(() => {
    if (activeCategory === "customized" && customizedCount === 0) {
      setActiveCategory("all");
    }
  }, [activeCategory, customizedCount]);

  const triggerSavedPop = useCallback((commandId: string) => {
    setJustSavedId(commandId);
    if (savedTimerRef.current !== null) window.clearTimeout(savedTimerRef.current);
    savedTimerRef.current = window.setTimeout(() => {
      setJustSavedId(null);
      savedTimerRef.current = null;
    }, 1100);
  }, []);

  const applyBinding = useCallback((commandId: string, chord: ShortcutChord) => {
    setShortcutOverride(commandId, platform, [chord]);
    setRecordingId(null);
    setLiveModifiers([]);
    setPending(null);
    triggerSavedPop(commandId);
    setMessage({
      kind: "success",
      text: `啪嗒！已设为 ${formatShortcutChord(chord, platform)}，即刻在本机生效。`,
    });
  }, [platform, triggerSavedPop]);

  useEffect(() => {
    if (!recordingId) {
      setLiveModifiers([]);
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();

      if (event.key === "Escape") {
        setRecordingId(null);
        setLiveModifiers([]);
        return;
      }

      setLiveModifiers(extractLiveModifierTokens(event, platform));

      // Wait patiently while the user is only holding modifier keys.
      if (["Control", "Meta", "Alt", "Shift"].includes(event.key)) {
        return;
      }

      const chord = shortcutChordFromKeyboardEvent(event, platform);
      if (!chord) {
        setMessage({
          kind: "error",
          text: `还需要一个修饰键哦，请试试搭配 ${platform === "macos" ? "⌘ / ⌥ / ⇧" : "Ctrl / Alt / Shift"} 一起按。`,
        });
        return;
      }

      const invalidReason = validateShortcutChord(chord, platform, surface, recordingId);
      if (invalidReason) {
        setMessage({ kind: "error", text: invalidReason });
        return;
      }

      const conflicts = findShortcutConflictsForCandidate(recordingId, chord, platform);
      if (conflicts.length > 0) {
        setPending({ commandId: recordingId, chord, conflicts });
        setRecordingId(null);
        setLiveModifiers([]);
        return;
      }

      applyBinding(recordingId, chord);
    };

    const onKeyUp = (event: KeyboardEvent) => {
      setLiveModifiers(extractLiveModifierTokens(event, platform));
    };

    const onWindowBlur = () => setLiveModifiers([]);

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", onWindowBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", onWindowBlur);
    };
  }, [applyBinding, platform, recordingId, surface]);

  const resolveConflictsAndApply = () => {
    if (!pending) return;
    const locked = pending.conflicts.filter((conflict) => !conflict.customizable);
    if (locked.length > 0) {
      setMessage({ kind: "error", text: "该组合键与不可修改的系统命令冲突，换一个顺手的键位吧。" });
      setPending(null);
      return;
    }
    for (const conflict of pending.conflicts) {
      setShortcutOverride(conflict.commandId, platform, []);
    }
    applyBinding(pending.commandId, pending.chord);
  };

  const exportConfig = () => {
    const blob = new Blob([exportShortcutOverrides()], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `nowen-shortcuts-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    setMessage({ kind: "success", text: "已打包导出本机快捷键配置 JSON。" });
  };

  const importConfig = async (file: File) => {
    try {
      const validCommandIds = new Set(SHORTCUT_COMMANDS.map((command) => command.id));
      const customizableCommandIds = new Set(
        SHORTCUT_COMMANDS.filter((command) => command.customizable).map((command) => command.id),
      );
      const count = importShortcutOverrides(await file.text(), {
        validCommandIds,
        customizableCommandIds,
        validateChord: (chord, importPlatform, commandId) => (
          validateShortcutChord(chord, importPlatform, surface, commandId)
        ),
      });
      setMessage({ kind: "success", text: `导入成功，已装入 ${count} 项自定义快捷键！` });
    } catch (error) {
      setMessage({ kind: "error", text: error instanceof Error ? error.message : "快捷键配置导入失败" });
    } finally {
      if (importRef.current) importRef.current.value = "";
    }
  };

  const handleResetAllClick = () => {
    if (customizedCount === 0) {
      setMessage({ kind: "success", text: "当前已经是原厂默认键位啦，无需重置。" });
      return;
    }
    setConfirmResetAll(true);
  };

  const confirmAndResetAll = () => {
    resetAllShortcutOverrides(platform);
    setConfirmResetAll(false);
    setRecordingId(null);
    setMessage({ kind: "success", text: `已将 ${platformLabel} 的全部快捷键恢复为原厂手感。` });
  };

  const platformLabel = formatPlatformDisplayName(platform);
  const surfaceLabel = surface === "desktop" ? "桌面端" : "Web 端";

  const filterTabs: Array<{ id: CategoryFilter; label: string; count: number }> = [
    { id: "all", label: "全部", count: surfaceCommands.length },
    ...(customizedCount > 0 ? [{ id: "customized" as const, label: "已定制", count: customizedCount }] : []),
    ...SHORTCUT_CATEGORY_ORDER
      .filter((category) => (categoryCounts.get(category) ?? 0) > 0)
      .map((category) => ({
        id: category as CategoryFilter,
        label: SHORTCUT_CATEGORY_LABELS[category],
        count: categoryCounts.get(category) ?? 0,
      })),
  ];

  const liveModifierChoices: readonly string[] = ["Mod", "Alt", "Shift"];
  const pendingCommandLabel = pending
    ? SHORTCUT_COMMANDS.find((command) => command.id === pending.commandId)?.label ?? pending.commandId
    : "";

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3.5">
          <PlayfulKeycapEmblem platform={platform} />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-lg font-bold tracking-tight text-tx-primary">快捷键</h3>
              <span className="inline-flex items-center rounded-full border border-app-border bg-app-surface px-2.5 py-0.5 text-[11px] font-medium text-tx-secondary">
                {platformLabel} · {surfaceLabel}
              </span>
              <AnimatePresence>
                {customizedCount > 0 && (
                  <motion.span
                    key="custom-badge"
                    initial={{ opacity: 0, scale: 0.85 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.85 }}
                    transition={MOTION_SPRING.snappy}
                    className="inline-flex items-center gap-1 rounded-full bg-emerald-500/12 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-700 dark:bg-emerald-400/15 dark:text-emerald-300"
                  >
                    <Sparkles size={11} />
                    已自定义 {customizedCount} 项
                  </motion.span>
                )}
              </AnimatePresence>
            </div>
            <p className="mt-1 text-xs leading-relaxed text-tx-secondary">
              点一下键帽就能直接录制新招式。配置仅保存在本机，并按平台独立隔离。
            </p>
          </div>
        </div>
      </div>

      {/* Search + Utility Actions */}
      <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center">
        <label className="group flex min-w-0 flex-1 items-center gap-2 rounded-xl border border-app-border bg-app-surface px-3 py-2 transition-interactive duration-fast focus-within:border-accent-primary focus-within:bg-app-elevated focus-within:shadow-sm">
          <Search size={15} className="shrink-0 text-tx-tertiary transition-colors group-focus-within:text-accent-primary" />
          <input
            ref={searchRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜命令、分类，或直接搜键位（如 Ctrl+B）…"
            className="min-w-0 flex-1 bg-transparent text-sm text-tx-primary outline-none placeholder:text-tx-tertiary"
            spellCheck={false}
          />
          {query ? (
            <button
              type="button"
              onClick={() => setQuery("")}
              className="rounded-md p-0.5 text-tx-tertiary transition-colors hover:bg-app-hover hover:text-tx-primary"
              aria-label="清空搜索"
            >
              <X size={14} />
            </button>
          ) : (
            <Keycap size="sm" variant="modifier" className="hidden sm:inline-flex !h-5 !min-w-[1.25rem] !text-[10px]">
              /
            </Keycap>
          )}
        </label>

        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={exportConfig}
            className="nowen-press inline-flex items-center gap-1.5 rounded-xl border border-app-border bg-app-elevated px-3 py-2 text-xs font-medium text-tx-secondary hover:border-tx-tertiary/50 hover:bg-app-hover hover:text-tx-primary"
          >
            <Download size={13} />
            导出
          </button>
          <button
            type="button"
            onClick={() => importRef.current?.click()}
            className="nowen-press inline-flex items-center gap-1.5 rounded-xl border border-app-border bg-app-elevated px-3 py-2 text-xs font-medium text-tx-secondary hover:border-tx-tertiary/50 hover:bg-app-hover hover:text-tx-primary"
          >
            <Upload size={13} />
            导入
          </button>
          <button
            type="button"
            onClick={handleResetAllClick}
            className="nowen-press inline-flex items-center gap-1.5 rounded-xl border border-app-border bg-app-elevated px-3 py-2 text-xs font-medium text-tx-secondary hover:border-amber-500/40 hover:bg-amber-500/10 hover:text-amber-700 dark:hover:text-amber-300"
          >
            <RotateCcw size={13} />
            全部默认
          </button>
          <input
            ref={importRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void importConfig(file);
            }}
          />
        </div>
      </div>

      {/* Spring-Animated Category Pills */}
      <div
        role="tablist"
        aria-label="快捷键分类筛选"
        className="flex flex-wrap items-center gap-1.5 rounded-2xl border border-app-border bg-app-surface/80 p-1.5"
      >
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
                "relative inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-medium transition-colors",
                isActive ? "text-tx-primary" : "text-tx-secondary hover:text-tx-primary",
              )}
            >
              {isActive && (
                <motion.span
                  layoutId="shortcut-settings-category-pill"
                  transition={MOTION_SPRING.snappy}
                  className="absolute inset-0 rounded-xl border border-app-border bg-app-elevated shadow-sm"
                />
              )}
              <span className="relative z-10">{tab.label}</span>
              <span
                className={cn(
                  "relative z-10 rounded-full px-1.5 py-0.5 text-[10px] tabular-nums",
                  isActive
                    ? "bg-app-hover text-tx-primary"
                    : "bg-app-hover/60 text-tx-tertiary",
                )}
              >
                {tab.count}
              </span>
            </button>
          );
        })}
      </div>

      {/* Feedback Toast */}
      <AnimatePresence>
        {message && (
          <motion.div
            key={`${message.kind}:${message.text}`}
            initial={toastMotion.initial}
            animate={toastMotion.animate}
            exit={toastMotion.exit}
            className={cn(
              "flex items-center justify-between gap-3 rounded-xl border px-3.5 py-2.5 text-xs font-medium shadow-sm",
              message.kind === "success"
                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                : "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
            )}
          >
            <div className="flex items-center gap-2">
              {message.kind === "success" ? (
                <CheckCircle2 size={15} className="shrink-0" />
              ) : (
                <AlertTriangle size={15} className="shrink-0" />
              )}
              <span>{message.text}</span>
            </div>
            <button
              type="button"
              onClick={() => setMessage(null)}
              className="rounded-md p-0.5 opacity-75 transition-opacity hover:opacity-100"
              aria-label="关闭提示"
            >
              <X size={14} />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Subtle Runtime Note */}
      <div className="flex items-start gap-2 rounded-xl border border-app-border bg-app-surface/70 px-3.5 py-2.5 text-xs text-tx-secondary">
        <Info size={14} className="mt-0.5 shrink-0 text-accent-primary" />
        <span>
          Electron 原生菜单仍可点击，可自定义命令的键盘触发已统一由应用注册表接管，改完立即生效、无需重启。
        </span>
      </div>

      {/* Shortcut Category Groups */}
      <div className="space-y-6">
        {groups.map((group) => {
          const meta = SHORTCUT_CATEGORY_META[group.category];
          const CategoryIcon = meta.icon;
          return (
            <section key={group.category} aria-label={meta.label}>
              <div className="mb-2.5 flex items-center justify-between gap-2 px-0.5">
                <div className="flex items-center gap-2">
                  <span className={cn("inline-flex h-6 w-6 items-center justify-center rounded-lg", meta.badgeClass)}>
                    <CategoryIcon size={13} />
                  </span>
                  <h4 className="text-xs font-semibold tracking-wide text-tx-primary">
                    {meta.label}
                  </h4>
                  <span className="hidden text-[11px] text-tx-tertiary sm:inline">
                    · {meta.tagline}
                  </span>
                </div>
                <span className="text-[11px] tabular-nums text-tx-tertiary">
                  {group.commands.length} 项
                </span>
              </div>

              <div className="overflow-hidden rounded-2xl border border-app-border bg-app-elevated shadow-sm">
                {group.commands.map((command, index) => {
                  const current = getShortcutChords(command.id, platform, surface);
                  const defaults = getDefaultShortcutChords(command.id, platform, surface);
                  const overridden = hasShortcutOverride(command.id, platform);
                  const isRecording = recordingId === command.id;
                  const isJustSaved = justSavedId === command.id;
                  const defaultLabel = defaults[0] ? formatShortcutChord(defaults[0], platform) : "无默认键位";

                  return (
                    <div
                      key={command.id}
                      className={cn(
                        "nowen-shortcut-row px-4 py-3.5",
                        index > 0 && "border-t border-app-border",
                        isRecording
                          ? "bg-amber-500/[0.07] dark:bg-amber-400/[0.08]"
                          : "hover:bg-app-hover/55",
                      )}
                    >
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                        {/* Left: Command metadata */}
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-semibold text-tx-primary">
                              {command.label}
                            </span>
                            {!command.customizable && (
                              <span className="inline-flex items-center gap-1 rounded-full bg-app-surface px-2 py-0.5 text-[10px] font-medium text-tx-tertiary">
                                <Lock size={10} />
                                系统保留
                              </span>
                            )}
                            {overridden && (
                              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/12 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 dark:bg-emerald-400/15 dark:text-emerald-300">
                                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                                已修改
                              </span>
                            )}
                          </div>
                          <p className="mt-0.5 text-xs text-tx-secondary">
                            {command.description}
                          </p>
                          {(overridden || !current[0]) && (
                            <p className="mt-1 text-[11px] text-tx-tertiary">
                              原默认：{defaultLabel}
                            </p>
                          )}
                        </div>

                        {/* Right: Tactile keycaps + Controls */}
                        <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                          {isRecording ? (
                            <div className="flex flex-col items-start gap-1.5 sm:items-end">
                              <div className="flex items-center gap-1.5 rounded-xl border border-amber-500/45 bg-amber-500/10 px-2.5 py-1.5">
                                <Radio size={13} className="nowen-listen-dot shrink-0 text-amber-600 dark:text-amber-300" />
                                <div className="flex items-center gap-1 pb-[2px]">
                                  {liveModifierChoices.map((modToken) => {
                                    const held = liveModifiers.includes(modToken);
                                    return (
                                      <Keycap
                                        key={modToken}
                                        size="sm"
                                        variant={held ? "recording" : "modifier"}
                                        pressed={held}
                                        className={cn(!held && "opacity-45")}
                                      >
                                        {formatPlatformKeyToken(modToken, platform)}
                                      </Keycap>
                                    );
                                  })}
                                  <span className="text-[10px] font-semibold text-amber-700/70 dark:text-amber-300/70">+</span>
                                  <Keycap size="sm" variant="recording">
                                    ?
                                  </Keycap>
                                </div>
                              </div>
                              <span className="text-[11px] font-medium text-amber-700 dark:text-amber-300">
                                正在聆听按键… 按 Esc 取消
                              </span>
                            </div>
                          ) : (
                            <ShortcutChordCaps
                              chord={current[0]}
                              platform={platform}
                              emptyText="未绑定"
                              state={isJustSaved ? "saved" : "idle"}
                              pop={isJustSaved}
                              interactive
                              onClick={command.customizable ? () => {
                                setMessage(null);
                                setRecordingId(command.id);
                              } : undefined}
                              title={command.customizable ? "点击直接录制新快捷键" : "系统保留快捷键"}
                            />
                          )}

                          {command.customizable && (
                            <div className="flex items-center gap-1.5">
                              <button
                                type="button"
                                onClick={() => {
                                  setMessage(null);
                                  setRecordingId(isRecording ? null : command.id);
                                }}
                                className={cn(
                                  "nowen-press rounded-lg border px-2.5 py-1.5 text-xs font-medium",
                                  isRecording
                                    ? "border-amber-500/50 bg-amber-500/15 text-amber-800 hover:bg-amber-500/20 dark:text-amber-200"
                                    : "border-app-border bg-app-surface text-tx-primary hover:border-accent-primary/50 hover:bg-app-hover",
                                )}
                              >
                                {isRecording ? "取消" : "录制"}
                              </button>

                              <button
                                type="button"
                                disabled={!current[0]}
                                onClick={() => {
                                  setShortcutOverride(command.id, platform, []);
                                  setMessage({ kind: "success", text: `已清空「${command.label}」的快捷键。` });
                                }}
                                className="nowen-press rounded-lg border border-app-border bg-app-surface p-1.5 text-tx-secondary hover:border-red-500/40 hover:bg-red-500/10 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-30 dark:hover:text-red-400"
                                title="清空键位"
                                aria-label={`清空 ${command.label} 快捷键`}
                              >
                                <Trash2 size={13} />
                              </button>

                              <button
                                type="button"
                                disabled={!overridden}
                                onClick={() => {
                                  resetShortcutOverride(command.id, platform);
                                  triggerSavedPop(command.id);
                                  setMessage({ kind: "success", text: `「${command.label}」已恢复默认键位。` });
                                }}
                                className="nowen-press rounded-lg border border-app-border bg-app-surface p-1.5 text-tx-secondary hover:border-accent-primary/50 hover:bg-app-hover hover:text-tx-primary disabled:cursor-not-allowed disabled:opacity-30"
                                title="恢复默认"
                                aria-label={`恢复 ${command.label} 默认快捷键`}
                              >
                                <RotateCcw size={13} />
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>

      {/* Empty State */}
      {groups.length === 0 && (
        <motion.div
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: MOTION_DURATION.normal, ease: MOTION_EASE.enter }}
          className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-app-border bg-app-surface/50 px-6 py-12 text-center"
        >
          <div className="mb-3 flex items-center gap-1.5 opacity-80">
            <Keycap variant="modifier">?</Keycap>
            <Keycap variant="ghost">无结果</Keycap>
          </div>
          <p className="text-sm font-medium text-tx-primary">没找到匹配的快捷键</p>
          <p className="mt-1 text-xs text-tx-tertiary">换个关键词，或者切回全部分类看看吧</p>
          {(query || activeCategory !== "all") && (
            <button
              type="button"
              onClick={() => {
                setQuery("");
                setActiveCategory("all");
              }}
              className="nowen-press mt-4 rounded-xl border border-app-border bg-app-elevated px-3.5 py-1.5 text-xs font-medium text-tx-primary hover:bg-app-hover"
            >
              重置筛选
            </button>
          )}
        </motion.div>
      )}

      {/* Conflict Resolution Modal */}
      <AnimatePresence>
        {pending && (
          <motion.div
            key="shortcut-conflict-modal"
            initial={overlayMotion.initial}
            animate={overlayMotion.animate}
            exit={overlayMotion.exit}
            className="fixed inset-0 z-[300] flex items-center justify-center p-4"
          >
            <div className="absolute inset-0 bg-black/45 backdrop-blur-sm" onClick={() => setPending(null)} />
            <motion.div
              role="dialog"
              aria-modal="true"
              aria-labelledby="shortcut-conflict-title"
              initial={dialogMotion.initial}
              animate={dialogMotion.animate}
              exit={dialogMotion.exit}
              className="relative w-full max-w-md rounded-2xl border border-app-border bg-app-elevated p-5 shadow-dialog"
            >
              <div className="flex items-start gap-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-500/15 text-amber-600 dark:text-amber-300">
                  <AlertTriangle size={20} />
                </span>
                <div className="min-w-0 flex-1">
                  <h4 id="shortcut-conflict-title" className="text-base font-semibold text-tx-primary">
                    这个键位正被占用着呢
                  </h4>
                  <p className="mt-1 text-xs text-tx-secondary">
                    准备分配给「{pendingCommandLabel}」的组合键与以下命令冲突：
                  </p>
                  <div className="mt-3 flex items-center gap-2 rounded-xl border border-app-border bg-app-surface px-3 py-2">
                    <ShortcutChordCaps chord={pending.chord} platform={platform} state="recording" />
                  </div>
                  <ul className="mt-3 space-y-1.5 text-xs">
                    {pending.conflicts.map((conflict) => {
                      const conflictLabel = SHORTCUT_COMMANDS.find((command) => command.id === conflict.commandId)?.label ?? conflict.commandId;
                      return (
                        <li
                          key={`${conflict.surface}:${conflict.commandId}`}
                          className="flex items-center justify-between gap-2 rounded-lg bg-app-surface px-2.5 py-1.5 text-tx-primary"
                        >
                          <span className="flex items-center gap-1.5 font-medium">
                            {!conflict.customizable && <Lock size={11} className="text-tx-tertiary" />}
                            {conflictLabel}
                          </span>
                          <span className="text-[11px] text-tx-tertiary">
                            {conflict.surface === "desktop" ? "桌面端" : "Web 端"}
                            {!conflict.customizable ? " · 系统保留" : ""}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              </div>
              <div className="mt-5 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setPending(null)}
                  className="nowen-press rounded-xl border border-app-border bg-app-surface px-3.5 py-2 text-xs font-medium text-tx-secondary hover:bg-app-hover hover:text-tx-primary"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={resolveConflictsAndApply}
                  disabled={pending.conflicts.some((conflict) => !conflict.customizable)}
                  className="nowen-press rounded-xl bg-accent-primary px-3.5 py-2 text-xs font-semibold text-white hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  解除旧绑定并应用
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Reset-All Confirmation Modal */}
      <AnimatePresence>
        {confirmResetAll && (
          <motion.div
            key="shortcut-reset-modal"
            initial={overlayMotion.initial}
            animate={overlayMotion.animate}
            exit={overlayMotion.exit}
            className="fixed inset-0 z-[300] flex items-center justify-center p-4"
          >
            <div className="absolute inset-0 bg-black/45 backdrop-blur-sm" onClick={() => setConfirmResetAll(false)} />
            <motion.div
              role="dialog"
              aria-modal="true"
              aria-labelledby="shortcut-reset-title"
              initial={dialogMotion.initial}
              animate={dialogMotion.animate}
              exit={dialogMotion.exit}
              className="relative w-full max-w-sm rounded-2xl border border-app-border bg-app-elevated p-5 shadow-dialog"
            >
              <div className="flex items-start gap-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-500/15 text-amber-600 dark:text-amber-300">
                  <RotateCcw size={18} />
                </span>
                <div>
                  <h4 id="shortcut-reset-title" className="text-base font-semibold text-tx-primary">
                    恢复全部默认键位？
                  </h4>
                  <p className="mt-1 text-xs leading-relaxed text-tx-secondary">
                    这会清空你在 {platformLabel} 上自定义的 {customizedCount} 项快捷键，恢复为原厂默认设置。
                  </p>
                </div>
              </div>
              <div className="mt-5 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setConfirmResetAll(false)}
                  className="nowen-press rounded-xl border border-app-border bg-app-surface px-3.5 py-2 text-xs font-medium text-tx-secondary hover:bg-app-hover hover:text-tx-primary"
                >
                  先留着
                </button>
                <button
                  type="button"
                  onClick={confirmAndResetAll}
                  className="nowen-press rounded-xl bg-amber-500 px-3.5 py-2 text-xs font-semibold text-white hover:bg-amber-600"
                >
                  确认恢复默认
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
