import React, { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Puzzle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { EditorActionEntry, RegisteredEditorAction } from "@/lib/editorActions/registry";
import { EditorActionIcon } from "./EditorActionIcon";

interface OpenMenu { entries: EditorActionEntry[]; left: number; top?: number; bottom?: number; maxHeight: number; keyboard: boolean }

/**
 * Extension actions for the toolbar or the selection bubble. Entries are computed when the menu opens,
 * so nothing runs while typing. Mouse use keeps focus (and the selection) in the editor.
 */
export function EditorActionsMenu({ placement, getEntries, onRun, iconSize = 15, compact = false }: {
  placement: string;
  getEntries: () => EditorActionEntry[];
  onRun: (action: RegisteredEditorAction) => void;
  iconSize?: number;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState<OpenMenu | null>(null);
  const menuId = useId();

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(null);
    if (restoreFocus) trigger.current?.focus();
  }, []);

  const toggle = (keyboard: boolean) => {
    if (open) { close(keyboard); return; }
    const rect = trigger.current!.getBoundingClientRect();
    const width = Math.min(288, window.innerWidth - 32);
    const below = window.innerHeight - rect.bottom - 12, above = rect.top - 12;
    const down = below >= 220 || below >= above;
    setOpen({
      entries: getEntries(),
      left: Math.max(16, Math.min(rect.left, window.innerWidth - width - 16)),
      ...(down ? { top: rect.bottom + 4 } : { bottom: window.innerHeight - rect.top + 4 }),
      maxHeight: Math.max(160, Math.min(360, (down ? below : above) - 4)),
      keyboard,
    });
  };

  useEffect(() => {
    if (!open) return;
    if (open.keyboard) list.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!list.current?.contains(target) && !trigger.current?.contains(target)) close(false);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); close(true); } };
    const dismiss = () => close(false);
    window.addEventListener("pointerdown", outside, true);
    window.addEventListener("keydown", escape, true);
    window.addEventListener("resize", dismiss);
    return () => {
      window.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("keydown", escape, true);
      window.removeEventListener("resize", dismiss);
    };
  }, [open, close]);

  const moveFocus = (event: React.KeyboardEvent) => {
    const items = [...(list.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") || [])];
    if (!items.length) return;
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "ArrowDown" ? (index + 1) % items.length
      : event.key === "ArrowUp" ? (index - 1 + items.length) % items.length
        : event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : -1;
    if (next >= 0) { event.preventDefault(); items[next].focus(); }
    if (event.key === "Tab") close(false);
  };

  return <>
    <button ref={trigger} type="button" data-editor-actions-placement={placement} aria-label={t("editorActions.menuLabel")} title={t("editorActions.menuLabel")}
      aria-haspopup="menu" aria-expanded={Boolean(open)} aria-controls={open ? menuId : undefined}
      onMouseDown={(event) => event.preventDefault()} onClick={(event) => toggle(event.detail === 0)}
      className={cn(compact ? "p-1" : "p-1.5", "shrink-0 rounded-md nowen-press",
        open ? "bg-accent-primary/20 text-accent-primary" : "text-tx-secondary hover:bg-app-hover hover:text-tx-primary")}>
      <Puzzle size={iconSize} />
    </button>
    {open && createPortal(
      <div ref={list} id={menuId} role="menu" aria-label={t("editorActions.menuLabel")} onKeyDown={moveFocus} onMouseDown={(event) => event.preventDefault()}
        style={{ left: open.left, top: open.top, bottom: open.bottom, maxHeight: open.maxHeight, width: "min(18rem, calc(100vw - 32px))" }}
        className="fixed z-[60] overflow-y-auto rounded-xl border border-app-border bg-app-elevated p-1 shadow-xl">
        {open.entries.length === 0 && <p className="px-3 py-2 text-xs text-tx-tertiary">{t("editorActions.menuEmpty")}</p>}
        {open.entries.map(({ action, disabledReason }) => (
          <button key={action.runtimeId} type="button" role="menuitem" disabled={Boolean(disabledReason)}
            title={disabledReason ? t("editorActions.needsSelection") : action.description || action.label}
            onClick={() => { close(false); onRun(action); }}
            className="flex min-h-11 w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-app-hover focus:bg-app-hover focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 md:min-h-9">
            <EditorActionIcon icon={action.icon} className="mt-0.5 shrink-0 text-tx-secondary" />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5">
                <span className="truncate text-sm text-tx-primary">{action.label}</span>
                {action.ai && <span className="shrink-0 rounded bg-violet-500/10 px-1 text-[10px] font-semibold text-violet-600 dark:text-violet-300">{t("editorActions.aiBadge")}</span>}
              </span>
              <span className="block truncate text-xs text-tx-tertiary">
                {disabledReason ? t("editorActions.needsSelection") : t("editorActions.fromPlugin", { plugin: action.pluginName })}
              </span>
            </span>
          </button>
        ))}
      </div>,
      document.body,
    )}
  </>;
}
