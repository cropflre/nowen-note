import React, { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence } from "framer-motion";
import { useTranslation } from "react-i18next";
import { AlertTriangle, ArrowDown, ArrowUp, GripVertical, Pencil, Plus, RotateCcw, Trash2, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { confirm, prompt } from "@/components/ui/confirm";
import { pluginApi, PLUGIN_CONTRIBUTIONS_CHANGED_EVENT, type PluginDashboardWidget } from "@/lib/pluginApi";
import { currentUiPlatform } from "@/lib/pluginUiRegistry";
import { getCurrentWorkspace } from "@/lib/api";
import { pushAppPathState } from "@/lib/appPathNavigation";
import { toast } from "@/lib/toast";
import {
  addCardError, addDashboardLayout, dashboardStorageKey, defaultDashboardPlacements, deleteDashboardLayout, layoutNameError,
  loadDashboardLayouts, moveDashboardWidget, parseDashboardLayouts, pushLayoutHistory, renameDashboardLayout, replaceActiveItems,
  resolveDashboardCard, saveDashboardLayouts, DASHBOARD_LIMITS, type DashboardLayouts, type WidgetPlacement, type WidgetSize,
} from "@/lib/pluginDashboard";
import { cn } from "@/lib/utils";
import { PluginAppFrame } from "./PluginApps";
import { BuiltinCardBody } from "./dashboard/BuiltinCards";
import { BuiltinCardIcon, builtinCardText } from "./dashboard/dashboardUi";
import { pickerEntries, WidgetPicker, type PickerEntry } from "./dashboard/WidgetPicker";

const SIZE_CLASS: Record<WidgetSize, string> = { small: "", medium: "md:col-span-2", large: "md:col-span-2 xl:col-span-3" };

export default function PluginDashboard() {
  const { t } = useTranslation();
  const [widgets, setWidgets] = useState<PluginDashboardWidget[]>([]), [widgetsScope, setWidgetsScope] = useState<number | null>(null);
  const [layouts, setLayouts] = useState<DashboardLayouts | null>(null), [layoutsKey, setLayoutsKey] = useState<string | null>(null);
  const [history, setHistory] = useState<DashboardLayouts[]>([]);
  const [busy, setBusy] = useState(false), [error, setError] = useState(false), [unsaved, setUnsaved] = useState(false);
  const [layoutName, setLayoutName] = useState(""), [layoutNameProblem, setLayoutNameProblem] = useState<string | null>(null);
  const [activeApp, setActiveApp] = useState<string | null>(null);
  const [editing, setEditing] = useState(false), [pickerOpen, setPickerOpen] = useState(false);
  const [dragging, setDragging] = useState<number | null>(null), [dropTarget, setDropTarget] = useState<number | null>(null);
  const [watchAttempt, setWatchAttempt] = useState(0), [scope, setScope] = useState(0), [refreshTick, setRefreshTick] = useState(0);
  const [mobile, setMobile] = useState(() => matchMedia("(max-width: 767px)").matches);
  // Only widgets loaded for the current account/workspace may seed that scope's default layout.
  const widgetsLoaded = widgetsScope === scope;
  // Layouts are device-local and isolated per server, account, workspace and screen class.
  // Recomputed every render; workspace/account changes bump `scope`, which re-renders.
  const storageKey = dashboardStorageKey(getCurrentWorkspace(), mobile);
  const layoutsRef = useRef(layouts); layoutsRef.current = layouts;
  const widgetsRef = useRef(widgets); widgetsRef.current = widgets;
  const refreshRef = useRef<() => void>(() => undefined), lastRefresh = useRef(0), dragged = useRef<number | null>(null);
  const handles = useRef(new Map<string, HTMLButtonElement>());

  useEffect(() => {
    const reset = () => { setScope((value) => value + 1); setEditing(false); setPickerOpen(false); setActiveApp(null); setHistory([]); setUnsaved(false); };
    window.addEventListener("nowen:workspace-changed", reset); window.addEventListener("nowen:token-changed", reset);
    return () => { window.removeEventListener("nowen:workspace-changed", reset); window.removeEventListener("nowen:token-changed", reset); };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await pluginApi.widgetEvents(getCurrentWorkspace(), controller.signal);
        if (!response.ok || !response.body) throw new Error();
        const reader = response.body.getReader(), decoder = new TextDecoder(); let pending = "";
        try {
          while (!controller.signal.aborted) {
            const chunk = await reader.read(); if (chunk.done) break;
            pending += decoder.decode(chunk.value, { stream: true });
            const events = pending.split("\n\n"); pending = events.pop() || "";
            for (const event of events) {
              if (event.includes("event: changed")) window.dispatchEvent(new Event(PLUGIN_CONTRIBUTIONS_CHANGED_EVENT));
              if (event.includes("event: revoked")) throw new Error();
            }
          }
        } finally { reader.releaseLock(); }
        if (!controller.signal.aborted) throw new Error();
      } catch { if (!controller.signal.aborted) { setWidgets([]); setActiveApp(null); setError(true); } }
    })();
    return () => controller.abort();
  }, [watchAttempt, scope]);
  useEffect(() => {
    const query = matchMedia("(max-width: 767px)"); const change = () => setMobile(query.matches);
    query.addEventListener("change", change); return () => query.removeEventListener("change", change);
  }, []);
  useEffect(() => {
    let active = true, generation = 0;
    const load = async (invalidate = false) => {
      if (!invalidate && Date.now() - lastRefresh.current < 2000) return;
      lastRefresh.current = Date.now(); const current = ++generation; setBusy(true);
      if (invalidate) { setWidgets([]); setWidgetsScope(null); setActiveApp(null); }
      try {
        const features = await pluginApi.features();
        const items = features.applicationV3?.dashboardWidgets ? await pluginApi.widgets(currentUiPlatform(), getCurrentWorkspace()) : [];
        if (active && generation === current) { setWidgets(items); setError(false); }
      } catch { if (active && generation === current) { setWidgets([]); setActiveApp(null); setError(true); } }
      finally { if (active && generation === current) { setBusy(false); setWidgetsScope(scope); } }
    };
    refreshRef.current = () => { void load(); };
    const changed = () => { void load(true); };
    const focus = () => { void load(); };
    void load(true);
    window.addEventListener(PLUGIN_CONTRIBUTIONS_CHANGED_EVENT, changed); window.addEventListener("focus", focus);
    return () => { active = false; generation++; window.removeEventListener(PLUGIN_CONTRIBUTIONS_CHANGED_EVENT, changed); window.removeEventListener("focus", focus); };
  }, [scope]);
  // Load once per storage key; widget refreshes must not overwrite an unsaved in-memory layout.
  useEffect(() => {
    if (!widgetsLoaded || layoutsKey === storageKey) return;
    setLayouts(loadDashboardLayouts(storageKey, defaultDashboardPlacements(widgetsRef.current)));
    setLayoutsKey(storageKey); setHistory([]); setUnsaved(false); setActiveApp(null);
  }, [storageKey, widgetsLoaded, layoutsKey]);
  // Another tab saved this layout: adopt it instead of silently overwriting it later.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== storageKey || !event.newValue) return;
      let parsed: DashboardLayouts | null = null;
      try { parsed = parseDashboardLayouts(JSON.parse(event.newValue)); } catch { parsed = null; }
      if (!parsed) return;
      setLayouts(parsed); setLayoutsKey(storageKey); setHistory([]); setUnsaved(false); setActiveApp(null);
      toast.info(t("extensionCenter.workbench.syncedFromOtherTab"));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [storageKey, t]);

  const ready = layoutsKey === storageKey && layouts !== null;
  const selected = ready ? layouts.layouts.find((layout) => layout.name === layouts.active) : undefined;
  const widgetMap = useMemo(() => new Map(widgets.map((widget) => [widget.runtimeId, widget])), [widgets]);
  const entries = useMemo(() => pickerEntries(widgets, t), [widgets, t]);
  const persist = (next: DashboardLayouts) => { setLayouts(next); setUnsaved(!saveDashboardLayouts(storageKey, next)); };
  const commit = (next: DashboardLayouts) => { const previous = layoutsRef.current; if (previous) setHistory((items) => pushLayoutHistory(items, previous)); persist(next); };
  const updateItems = (items: WidgetPlacement[]) => { if (layoutsRef.current) commit(replaceActiveItems(layoutsRef.current, items)); };
  const undo = () => {
    const previous = history[history.length - 1]; if (!previous) return;
    setHistory((items) => items.slice(0, -1)); persist(previous); setActiveApp(null);
  };
  const move = (from: number, to: number, focusId?: string) => {
    if (!selected) return;
    const next = moveDashboardWidget(selected.items, from, to);
    if (next === selected.items) return;
    updateItems(next);
    if (focusId) requestAnimationFrame(() => handles.current.get(focusId)?.focus());
  };
  const addLayout = () => {
    const current = layoutsRef.current; if (!current) return;
    const problem = layoutNameError(layoutName, current);
    if (problem) { setLayoutNameProblem(t(`extensionCenter.workbench.nameError.${problem}`)); return; }
    const next = addDashboardLayout(current, layoutName);
    if (!next) { setLayoutNameProblem(t("extensionCenter.workbench.layoutLimit")); return; }
    commit(next); setLayoutName(""); setLayoutNameProblem(null); setActiveApp(null);
  };
  const renameLayout = async () => {
    const current = layoutsRef.current; if (!current) return;
    const value = await prompt({
      title: t("extensionCenter.workbench.renameLayout"), defaultValue: current.active,
      confirmText: t("extensionCenter.workbench.renameConfirm"), cancelText: t("extensionCenter.confirm.cancel"),
      validate: (candidate) => { const problem = layoutNameError(candidate, current, current.active); return problem ? t(`extensionCenter.workbench.nameError.${problem}`) : null; },
    });
    const latest = layoutsRef.current;
    if (value === null || !latest) return;
    const next = renameDashboardLayout(latest, latest.active, value);
    if (next) commit(next);
  };
  const deleteLayout = async () => {
    const current = layoutsRef.current; if (!current || current.layouts.length <= 1) return;
    const accepted = await confirm({ title: t("pluginApps.deleteLayout"), description: t("extensionCenter.workbench.deleteLayoutBody", { name: current.active }), confirmText: t("pluginApps.deleteLayout"), cancelText: t("extensionCenter.confirm.cancel"), danger: true });
    const latest = layoutsRef.current;
    if (!accepted || !latest) return;
    const next = deleteDashboardLayout(latest, latest.active);
    if (next) { commit(next); setActiveApp(null); }
  };
  const resetLayout = async () => {
    const accepted = await confirm({ title: t("pluginApps.resetLayout"), description: t("extensionCenter.workbench.resetLayoutBody"), confirmText: t("pluginApps.resetLayout"), cancelText: t("extensionCenter.confirm.cancel") });
    const latest = layoutsRef.current;
    if (!accepted || !latest) return;
    commit(replaceActiveItems(latest, defaultDashboardPlacements(widgetsRef.current))); setActiveApp(null);
  };
  const addCard = (entry: PickerEntry) => {
    if (!selected || addCardError(selected.items, entry.id)) return;
    updateItems([...selected.items, { id: entry.id, hidden: false, size: entry.defaultSize }]);
    setPickerOpen(false);
  };
  const refreshAll = () => { refreshRef.current(); setWatchAttempt((value) => value + 1); setRefreshTick((value) => value + 1); };
  const visibleCount = selected?.items.filter((item) => !item.hidden).length ?? 0;

  return <section aria-labelledby="dashboard-heading" className="space-y-4">
    <div className="flex flex-wrap items-start gap-3">
      <div className="mr-auto min-w-0">
        <h2 id="dashboard-heading" className="text-lg font-semibold text-tx-primary">{t("extensionCenter.workbench.title")}</h2>
        <p className="mt-1 max-w-2xl text-sm text-tx-secondary">{editing ? t("extensionCenter.workbench.editHint") : t("pluginApps.localLayout")}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <select aria-label={t("pluginApps.layout")} value={layouts?.active || ""} disabled={!ready}
          onChange={(event) => { if (layoutsRef.current) { commit({ ...layoutsRef.current, active: event.target.value }); setActiveApp(null); } }}
          className="min-h-11 rounded-md border border-app-border bg-app-surface px-2 text-sm text-tx-primary md:min-h-9">
          {ready && layouts.layouts.map((layout) => <option key={layout.name} value={layout.name}>{layout.name}</option>)}
        </select>
        <Button variant={editing ? "default" : "outline"} size="sm" aria-pressed={editing} className="min-h-11 md:min-h-9"
          onClick={() => { setEditing((value) => !value); setPickerOpen(false); setLayoutNameProblem(null); }}>
          {editing ? t("pluginApps.finishLayout") : t("pluginApps.editLayout")}
        </Button>
        {!editing && <Button variant="outline" size="sm" disabled={busy} className="min-h-11 md:min-h-9" onClick={refreshAll}>{t("pluginApps.refresh")}</Button>}
      </div>
    </div>

    {editing && ready && <div className="space-y-3 rounded-2xl border border-dashed border-accent-primary/40 bg-accent-primary/5 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" className="min-h-11 md:min-h-9" disabled={!selected} onClick={() => setPickerOpen(true)}><Plus size={14} className="mr-1" />{t("pluginApps.addCard")}</Button>
        <Button size="sm" variant="outline" className="min-h-11 md:min-h-9" disabled={!history.length} onClick={undo}><Undo2 size={14} className="mr-1" />{t("extensionCenter.workbench.undo")}</Button>
        <span className="text-xs text-tx-tertiary">{t("extensionCenter.workbench.cardCount", { count: selected?.items.length ?? 0, max: DASHBOARD_LIMITS.cards })}</span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input aria-label={t("pluginApps.layoutName")} placeholder={t("pluginApps.layoutName")} maxLength={DASHBOARD_LIMITS.layoutName} value={layoutName}
          onChange={(event) => { setLayoutName(event.target.value); setLayoutNameProblem(null); }}
          onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addLayout(); } }}
          className="min-h-11 min-w-0 flex-1 rounded-md border border-app-border bg-app-surface px-2.5 text-sm text-tx-primary md:min-h-9 sm:max-w-56" />
        <Button size="sm" variant="outline" className="min-h-11 md:min-h-9" disabled={!layoutName.trim() || layouts.layouts.length >= DASHBOARD_LIMITS.layouts} onClick={addLayout}>{t("pluginApps.addLayout")}</Button>
        <Button size="sm" variant="ghost" className="min-h-11 md:min-h-9" onClick={() => void renameLayout()}><Pencil size={14} className="mr-1" />{t("extensionCenter.workbench.renameLayout")}</Button>
        <Button size="sm" variant="ghost" className="min-h-11 md:min-h-9" onClick={() => void resetLayout()}><RotateCcw size={14} className="mr-1" />{t("pluginApps.resetLayout")}</Button>
        <Button size="sm" variant="ghost" className="min-h-11 md:min-h-9" disabled={layouts.layouts.length <= 1} onClick={() => void deleteLayout()}><Trash2 size={14} className="mr-1" />{t("pluginApps.deleteLayout")}</Button>
      </div>
      {layoutNameProblem && <span role="alert" className="block text-xs text-red-700 dark:text-red-300">{layoutNameProblem}</span>}
    </div>}

    {unsaved && <div role="alert" className="flex flex-wrap items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/5 px-3 py-2.5 text-sm text-amber-800 dark:text-amber-200">
      <AlertTriangle size={16} className="shrink-0" /><span className="min-w-0 flex-1">{t("extensionCenter.workbench.unsaved")}</span>
      <Button size="sm" variant="outline" onClick={() => { if (layoutsRef.current) setUnsaved(!saveDashboardLayouts(storageKey, layoutsRef.current)); }}>{t("extensionCenter.workbench.retrySave")}</Button>
    </div>}
    {error && <div role="alert" className="rounded-xl border border-red-500/30 bg-red-500/5 px-3 py-2.5 text-sm text-red-800 dark:text-red-200">{t("pluginApps.failed")}</div>}
    {!ready && <div role="status" className="text-sm text-tx-tertiary">{t("pluginApps.loading")}</div>}

    {ready && selected && (editing ? selected.items.length === 0 : visibleCount === 0) && <div className="rounded-2xl border border-dashed border-app-border px-4 py-10 text-center">
      <span className="block text-sm text-tx-secondary">{t("extensionCenter.workbench.emptyLayout")}</span>
      {/* In edit mode the toolbar already offers "Add cards". */}
      {!editing && <Button size="sm" variant="outline" className="mt-3 min-h-11 md:min-h-9" onClick={() => { setEditing(true); setPickerOpen(true); }}>{t("pluginApps.addCard")}</Button>}
    </div>}

    {ready && selected && <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
      {selected.items.map((item, index) => {
        if (item.hidden && !editing) return null;
        const resolution = resolveDashboardCard(item, widgetMap);
        // Do not flash "unavailable" while plugin widgets are still loading.
        if (resolution.type === "dormant" && resolution.reason === "PLUGIN_UNAVAILABLE" && !widgetsLoaded) return null;
        const title = resolution.type === "builtin" ? builtinCardText(resolution.kind, t).title
          : resolution.type === "plugin" ? resolution.widget.title : t("extensionCenter.workbench.dormantTitle");
        const live = resolution.type !== "dormant";
        return <article key={item.id} {...(live ? { "data-widget-id": item.id } : { "data-dormant-widget-id": item.id })}
          draggable={editing}
          onDragStart={(event) => { if (!editing) return; dragged.current = index; setDragging(index); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", item.id); }}
          onDragOver={(event) => { if (dragged.current === null) return; event.preventDefault(); event.dataTransfer.dropEffect = "move"; if (dropTarget !== index) setDropTarget(index); }}
          onDrop={(event) => { event.preventDefault(); const from = dragged.current; dragged.current = null; setDragging(null); setDropTarget(null); if (from !== null && from !== index) move(from, index); }}
          onDragEnd={() => { dragged.current = null; setDragging(null); setDropTarget(null); }}
          className={cn("min-w-0 rounded-2xl border bg-app-surface p-4 shadow-sm transition-interactive duration-fast ease-standard", SIZE_CLASS[item.size],
            editing ? "border-dashed border-app-border" : "border-app-border",
            !live && "bg-app-hover/40", dragging === index && "opacity-50",
            dropTarget === index && dragging !== index && "ring-2 ring-accent-primary")}>
          <header className="mb-3 flex items-center gap-2">
            {editing && <button type="button" ref={(element) => { if (element) handles.current.set(item.id, element); else handles.current.delete(item.id); }}
              aria-label={t("extensionCenter.workbench.dragHandle", { name: title })}
              onKeyDown={(event) => {
                if (event.key === "ArrowUp" || event.key === "ArrowLeft") { event.preventDefault(); move(index, index - 1, item.id); }
                if (event.key === "ArrowDown" || event.key === "ArrowRight") { event.preventDefault(); move(index, index + 1, item.id); }
              }}
              className="inline-flex h-11 w-8 shrink-0 cursor-grab items-center justify-center rounded-md text-tx-tertiary hover:bg-app-hover hover:text-tx-primary md:h-8">
              <GripVertical size={15} />
            </button>}
            <BuiltinCardIcon id={item.id} dormant={!live} />
            <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-tx-primary">{title}</h2>
            {item.hidden && <span className="shrink-0 rounded-full bg-app-hover px-2 py-0.5 text-[11px] text-tx-secondary">{t("extensionCenter.workbench.hiddenBadge")}</span>}
          </header>
          {editing && <div className="mb-3 flex flex-wrap items-center gap-1.5 text-xs">
            <Button type="button" size="icon" variant="outline" aria-label={t("pluginApps.moveUp")} disabled={index === 0} onClick={() => move(index, index - 1)} className="h-11 w-11 md:h-8 md:w-8"><ArrowUp size={14} /></Button>
            <Button type="button" size="icon" variant="outline" aria-label={t("pluginApps.moveDown")} disabled={index === selected.items.length - 1} onClick={() => move(index, index + 1)} className="h-11 w-11 md:h-8 md:w-8"><ArrowDown size={14} /></Button>
            <select aria-label={t("pluginApps.cardSize")} value={item.size} onChange={(event) => updateItems(selected.items.map((other) => (other === item ? { ...other, size: event.target.value as WidgetSize } : other)))}
              className="min-h-11 rounded-md border border-app-border bg-app-surface px-2 text-xs text-tx-primary md:min-h-8">
              {(["small", "medium", "large"] as const).map((size) => <option value={size} key={size}>{t(`pluginApps.${size}`)}</option>)}
            </select>
            <Button type="button" size="sm" variant="outline" className="min-h-11 md:min-h-8" onClick={() => { updateItems(selected.items.map((other) => (other === item ? { ...other, hidden: !other.hidden } : other))); setActiveApp(null); }}>
              {t(item.hidden ? "pluginApps.showCard" : "pluginApps.hideCard")}
            </Button>
            <Button type="button" size="sm" variant="outline" className="min-h-11 text-red-600 dark:text-red-300 md:min-h-8" onClick={() => { updateItems(selected.items.filter((other) => other !== item)); setActiveApp(null); }}>
              {t("pluginApps.removeCard")}
            </Button>
          </div>}
          {!item.hidden && (resolution.type === "builtin"
            ? <BuiltinCardBody kind={resolution.kind} refreshKey={`${storageKey}:${refreshTick}`} onDataChanged={() => setRefreshTick((value) => value + 1)} />
            : resolution.type === "plugin" ? (() => {
              const widget = resolution.widget;
              return <>{widget.error ? <p role="alert">{t("pluginApps.unavailable")}</p> : widget.type === "statistic" ? <p className="my-4 text-3xl font-semibold">{widget.preview?.total ?? 0}</p> : widget.type === "status" ? <p>{t("pluginApps.statusSummary", { open: widget.preview?.open || 0, done: widget.preview?.done || 0 })}</p> : widget.type === "list" ? <ul className="mb-3 space-y-2">{widget.preview?.items.map((row) => <li key={row.id} className="truncate">{row.title}</li>)}</ul> : null}
                {widget.type === "app" ? activeApp === item.id ? <div className="flex h-[440px] flex-col"><button className="mb-2 self-end text-xs" onClick={() => setActiveApp(null)}>{t("pluginApps.stopCard")}</button><PluginAppFrame page={widget.page} compact /></div> : <Button size="sm" variant="outline" className="min-h-11 md:min-h-9" onClick={() => setActiveApp(item.id)}>{t("pluginApps.startCard")}</Button> : <Button size="sm" variant="outline" className="min-h-11 md:min-h-9" onClick={() => pushAppPathState(widget.page.route)}>{t("pluginApps.openApp")}</Button>}
              </>;
            })()
              : <div className="space-y-2 text-sm text-tx-secondary">
                <span className="block">{resolution.reason === "UNKNOWN_BUILTIN" ? t("extensionCenter.workbench.dormantBuiltin") : error ? t("extensionCenter.workbench.dormantLoadFailed") : t("extensionCenter.workbench.dormantPlugin")}</span>
                <span className="block break-all font-mono text-[11px] text-tx-tertiary">{item.id}</span>
                {resolution.reason === "PLUGIN_UNAVAILABLE" && <Button size="sm" variant="outline" className="min-h-11 md:min-h-8" onClick={() => pushAppPathState("/apps/manage")}>{t("extensionCenter.workbench.dormantManage")}</Button>}
              </div>)}
        </article>;
      })}
    </div>}

    <AnimatePresence>
      {pickerOpen && selected && <WidgetPicker entries={entries} items={selected.items} onAdd={addCard} onClose={() => setPickerOpen(false)} />}
    </AnimatePresence>
  </section>;
}
