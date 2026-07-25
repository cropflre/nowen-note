import React, { useEffect, useMemo, useRef, useState, type ChangeEvent, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Keyboard, Search, X } from "lucide-react";
import {
  SHORTCUT_CATEGORY_LABELS,
  SHORTCUT_COMMANDS,
  detectShortcutPlatform,
  detectShortcutSurface,
  findShortcutConflicts,
  formatShortcutForCommand,
  shortcutMatchesEvent,
  type ShortcutCategory,
} from "@/lib/shortcutRegistry";
import { installShortcutTooltipBridge } from "@/lib/shortcutTooltipBridge";

export const OPEN_SHORTCUT_HELP_EVENT = "nowen:open-shortcut-help";

const CATEGORY_ORDER: readonly ShortcutCategory[] = [
  "global", "navigation", "rich-text", "markdown", "desktop",
];

export default function ShortcutHelpCenter() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const platform = detectShortcutPlatform();
  const surface = detectShortcutSurface();

  useEffect(() => installShortcutTooltipBridge(), []);

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
    if (!open) return;
    setQuery("");
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  const commands = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return SHORTCUT_COMMANDS
      .filter((command) => command.availableIn.includes(surface))
      .filter((command) => formatShortcutForCommand(command.id, platform, surface))
      .filter((command) => !needle || [
        command.label,
        command.description,
        SHORTCUT_CATEGORY_LABELS[command.category],
        ...(command.secondaryCategories ?? []).map((category) => SHORTCUT_CATEGORY_LABELS[category]),
      ].join(" ").toLowerCase().includes(needle));
  }, [platform, query, surface]);

  const groups = useMemo(() => CATEGORY_ORDER
    .map((category) => ({
      category,
      commands: commands.filter((command) => (
        command.category === category || command.secondaryCategories?.includes(category)
      )),
    }))
    .filter((group) => group.commands.length > 0), [commands]);
  const conflicts = useMemo(() => findShortcutConflicts(), []);

  const modal = open && typeof document !== "undefined" ? createPortal(
    <div
      className="fixed inset-0 z-[260] flex items-center justify-center p-4"
      onMouseDown={(event: MouseEvent<HTMLDivElement>) => {
        if (event.target === event.currentTarget) setOpen(false);
      }}
    >
      <div className="absolute inset-0 bg-black/45 backdrop-blur-sm" aria-hidden />
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcut-help-title"
        className="relative flex max-h-[82vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-app-border bg-app-elevated shadow-2xl"
        onMouseDown={(event: MouseEvent<HTMLElement>) => event.stopPropagation()}
      >
        <header className="flex items-center gap-3 border-b border-app-border px-5 py-4">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-app-hover text-accent-primary">
            <Keyboard size={20} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="shortcut-help-title" className="text-base font-semibold text-tx-primary">键盘快捷键</h2>
            <p className="mt-0.5 text-xs text-tx-tertiary">
              当前显示 {platform === "macos" ? "macOS" : platform === "windows" ? "Windows" : "Linux"}
              {surface === "desktop" ? "桌面端" : "Web 端"}键位
            </p>
          </div>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="rounded-lg p-2 text-tx-secondary transition-colors hover:bg-app-hover hover:text-tx-primary"
            aria-label="关闭快捷键帮助"
          >
            <X size={18} />
          </button>
        </header>

        <div className="border-b border-app-border px-5 py-3">
          <label className="flex items-center gap-2 rounded-lg border border-app-border bg-app-surface px-3 py-2 focus-within:border-accent-primary">
            <Search size={15} className="shrink-0 text-tx-tertiary" />
            <input
              ref={inputRef}
              value={query}
              onChange={(event: ChangeEvent<HTMLInputElement>) => setQuery(event.target.value)}
              placeholder="搜索命令或分类…"
              className="min-w-0 flex-1 bg-transparent text-sm text-tx-primary outline-none placeholder:text-tx-tertiary"
              spellCheck={false}
            />
          </label>
        </div>

        {conflicts.length > 0 && (
          <div className="mx-5 mt-4 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
            <AlertTriangle size={15} className="mt-0.5 shrink-0" />
            <span>检测到 {conflicts.length} 组快捷键冲突，请在合并前修复注册表。</span>
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {groups.length === 0 ? (
            <div className="py-12 text-center text-sm text-tx-tertiary">没有匹配的快捷键</div>
          ) : (
            <div className="space-y-6">
              {groups.map((group) => (
                <section key={group.category} aria-label={SHORTCUT_CATEGORY_LABELS[group.category]}>
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-tx-tertiary">
                    {SHORTCUT_CATEGORY_LABELS[group.category]}
                  </h3>
                  <div className="overflow-hidden rounded-xl border border-app-border">
                    {group.commands.map((command, index) => (
                      <div
                        key={`${group.category}:${command.id}`}
                        className={`flex items-center gap-4 px-4 py-3 ${index > 0 ? "border-t border-app-border" : ""}`}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-medium text-tx-primary">{command.label}</div>
                          <div className="mt-0.5 truncate text-xs text-tx-tertiary">{command.description}</div>
                        </div>
                        <kbd className="shrink-0 rounded-md border border-app-border bg-app-surface px-2 py-1 font-mono text-xs text-tx-secondary shadow-sm">
                          {formatShortcutForCommand(command.id, platform, surface)}
                        </kbd>
                      </div>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
        </div>

        <footer className="flex items-center justify-between border-t border-app-border px-5 py-3 text-[11px] text-tx-tertiary">
          <span>工具栏悬停提示与当前运行端使用同一套键位</span>
          <span>Esc 关闭</span>
        </footer>
      </section>
    </div>,
    document.body,
  ) : null;

  return surface !== "android" ? modal : null;
}
