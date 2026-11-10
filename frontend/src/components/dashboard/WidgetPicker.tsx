import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion } from "framer-motion";
import { useTranslation } from "react-i18next";
import { Search, X } from "lucide-react";
import { dialogMotion, overlayMotion } from "@/lib/motion";
import { addCardError, BUILTIN_WIDGETS, type WidgetPlacement, type WidgetSize } from "@/lib/pluginDashboard";
import type { PluginDashboardWidget } from "@/lib/pluginApi";
import { cn } from "@/lib/utils";
import { BuiltinCardIcon, builtinCardText } from "./dashboardUi";

export interface PickerEntry { id: string; title: string; description: string; group: "builtin" | "plugin"; defaultSize: WidgetSize }

export function pickerEntries(widgets: readonly PluginDashboardWidget[], t: (key: string, options?: Record<string, unknown>) => string): PickerEntry[] {
  return [
    ...BUILTIN_WIDGETS.map((widget) => ({ id: widget.id, ...builtinCardText(widget.kind, t), group: "builtin" as const, defaultSize: widget.defaultSize })),
    ...widgets.map((widget) => ({
      id: widget.runtimeId, title: widget.title, group: "plugin" as const, defaultSize: widget.defaultSize,
      description: `${t(`extensionCenter.workbench.widgetType.${widget.type}`)} · ${widget.pluginId}`,
    })),
  ];
}

/** Modal list of addable cards; the dashboard performs the actual (validated) insert. */
export function WidgetPicker({ entries, items, onAdd, onClose }: {
  entries: readonly PickerEntry[]; items: readonly WidgetPlacement[]; onAdd: (entry: PickerEntry) => void; onClose: () => void;
}) {
  const { t } = useTranslation();
  const titleId = useId();
  const search = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [returnFocus] = useState<HTMLElement | null>(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null));
  useEffect(() => {
    search.current?.focus();
    return () => { if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true }); };
  }, [returnFocus]);
  const visible = useMemo(() => {
    const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return entries.filter((entry) => tokens.every((token) => `${entry.title}\n${entry.description}`.toLowerCase().includes(token)));
  }, [entries, query]);
  const groups = (["builtin", "plugin"] as const).map((group) => ({ group, entries: visible.filter((entry) => entry.group === group) })).filter((item) => item.entries.length);

  return createPortal(<>
    <motion.div {...overlayMotion} className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px]" onClick={onClose} aria-hidden />
    <div className="pointer-events-none fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-4">
      <motion.div {...dialogMotion} role="dialog" aria-modal="true" aria-labelledby={titleId}
        onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}
        className="pointer-events-auto flex max-h-[85vh] w-full flex-col overflow-hidden rounded-t-2xl border border-app-border bg-app-surface shadow-2xl sm:max-w-lg sm:rounded-2xl">
        <div className="flex items-center gap-2 border-b border-app-border px-4 py-3">
          <h2 id={titleId} className="flex-1 text-base font-semibold text-tx-primary">{t("extensionCenter.workbench.pickerTitle")}</h2>
          <button type="button" onClick={onClose} aria-label={t("extensionCenter.action.close")} className="inline-flex h-11 w-11 items-center justify-center rounded-md text-tx-tertiary hover:bg-app-hover hover:text-tx-primary md:h-8 md:w-8"><X size={16} /></button>
        </div>
        <label className="mx-4 mt-3 flex items-center gap-2 rounded-xl border border-app-border bg-app-bg px-3 focus-within:ring-1 focus-within:ring-accent-primary">
          <Search size={15} className="shrink-0 text-tx-tertiary" aria-hidden />
          <input ref={search} type="search" value={query} onChange={(event) => setQuery(event.target.value)} aria-label={t("extensionCenter.workbench.pickerSearch")}
            placeholder={t("extensionCenter.workbench.pickerSearch")} className="h-11 min-w-0 flex-1 bg-transparent text-sm text-tx-primary outline-none placeholder:text-tx-tertiary" />
        </label>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-3" style={{ paddingBottom: "calc(var(--safe-area-bottom, 0px) + 16px)" }}>
          {groups.length ? groups.map(({ group, entries: list }) => <section key={group} className="space-y-1.5">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-tx-tertiary">{t(`extensionCenter.workbench.pickerGroup.${group}`)}</h3>
            <ul className="space-y-1">{list.map((entry) => {
              const reason = addCardError(items, entry.id);
              const descriptionId = `${titleId}-${entry.id}`;
              return <li key={entry.id}>
                <button type="button" disabled={Boolean(reason)} aria-label={entry.title} aria-describedby={descriptionId} onClick={() => onAdd(entry)}
                  className={cn("flex min-h-12 w-full items-center gap-3 rounded-xl border border-transparent px-2.5 py-2 text-left",
                    reason ? "cursor-not-allowed opacity-60" : "hover:border-app-border hover:bg-app-hover")}>
                  <BuiltinCardIcon id={entry.id} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-tx-primary">{entry.title}</span>
                    <span id={descriptionId} className="block truncate text-xs text-tx-tertiary">
                      {reason === "DUPLICATE" ? t("extensionCenter.workbench.pickerAdded") : reason === "LIMIT" ? t("extensionCenter.workbench.pickerLimit") : entry.description}
                    </span>
                  </span>
                </button>
              </li>;
            })}</ul>
          </section>) : <p className="py-8 text-center text-sm text-tx-secondary">{t("extensionCenter.workbench.pickerEmpty")}</p>}
        </div>
      </motion.div>
    </div>
  </>, document.body);
}
