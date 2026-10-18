import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { pluginApi, PLUGIN_CONTRIBUTIONS_CHANGED_EVENT, type PluginDashboardWidget } from "@/lib/pluginApi";
import { currentUiPlatform } from "@/lib/pluginUiRegistry";
import { getCurrentWorkspace } from "@/lib/api";
import { pushAppPathState } from "@/lib/appPathNavigation";
import { dashboardStorageKey, loadDashboardLayouts, saveDashboardLayouts, moveDashboardWidget, type DashboardLayouts, type WidgetPlacement, type WidgetSize } from "@/lib/pluginDashboard";
import { PluginAppFrame } from "./PluginApps";

export default function PluginDashboard() {
  const { t } = useTranslation();
  const [widgets, setWidgets] = useState<PluginDashboardWidget[]>([]), [layouts, setLayouts] = useState<DashboardLayouts | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(false), [layoutName, setLayoutName] = useState("");
  const [activeApp, setActiveApp] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [watchAttempt, setWatchAttempt] = useState(0);
  const [mobile, setMobile] = useState(() => matchMedia("(max-width: 767px)").matches);
  const storageKey = dashboardStorageKey(getCurrentWorkspace(), mobile), keyRef = useRef(storageKey); keyRef.current = storageKey;
  const refreshRef = useRef<() => void>(() => undefined), lastRefresh = useRef(0), dragged = useRef<number | null>(null);
  const defaults = (items: PluginDashboardWidget[]) => items.map(widget => ({ id: widget.runtimeId, hidden: false, size: widget.defaultSize }));
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
  }, [watchAttempt]);
  useEffect(() => {
    const query = matchMedia("(max-width: 767px)"); const change = () => setMobile(query.matches);
    query.addEventListener("change", change); return () => query.removeEventListener("change", change);
  }, []);
  useEffect(() => { setLayouts(widgets.length ? loadDashboardLayouts(storageKey, defaults(widgets)) : null); setActiveApp(null); }, [storageKey]);
  useEffect(() => {
    let active = true, generation = 0;
    const load = async (invalidate = false) => {
      if (!invalidate && Date.now() - lastRefresh.current < 2000) return;
      lastRefresh.current = Date.now(); const current = ++generation; setBusy(true);
      if (invalidate) { setWidgets([]); setActiveApp(null); }
      try {
        const features = await pluginApi.features();
        const items = features.applicationV3?.dashboardWidgets ? await pluginApi.widgets(currentUiPlatform(), getCurrentWorkspace()) : [];
        if (active && generation === current) { setWidgets(items); setLayouts(previous => previous || loadDashboardLayouts(keyRef.current, defaults(items))); setError(false); }
      } catch { if (active && generation === current) { setWidgets([]); setActiveApp(null); setError(true); } }
      finally { if (active && generation === current) setBusy(false); }
    };
    refreshRef.current = () => { void load(); };
    const changed = () => { void load(true); };
    const focus = () => { void load(); };
    void load(true);
    window.addEventListener(PLUGIN_CONTRIBUTIONS_CHANGED_EVENT, changed); window.addEventListener("focus", focus);
    return () => { active = false; generation++; window.removeEventListener(PLUGIN_CONTRIBUTIONS_CHANGED_EVENT, changed); window.removeEventListener("focus", focus); };
  }, []);
  const commit = (next: DashboardLayouts) => { setLayouts(next); if (!saveDashboardLayouts(storageKey, next)) setError(true); };
  const selected = layouts?.layouts.find(layout => layout.name === layouts.active);
  const update = (items: WidgetPlacement[]) => { if (layouts && selected) commit({ ...layouts, layouts: layouts.layouts.map(layout => layout === selected ? { ...layout, items } : layout) }); };
  const addLayout = () => {
    const name = layoutName.trim();
    if (!layouts || !name || name.length > 40 || layouts.layouts.length >= 5 || layouts.layouts.some(layout => layout.name === name)) return;
    commit({ active: name, layouts: [...layouts.layouts, { name, items: [] }] }); setLayoutName(""); setActiveApp(null);
  };
  return <section className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
    <div className="mb-4 flex flex-wrap items-center gap-3"><h1 className="mr-auto text-xl font-semibold">{t("pluginApps.dashboard")}</h1><button aria-pressed={editing} onClick={() => setEditing(value => !value)} className="rounded border border-app-border px-3 py-2">{t(editing ? "pluginApps.finishLayout" : "pluginApps.editLayout")}</button><button disabled={busy} onClick={() => { refreshRef.current(); setWatchAttempt(value => value + 1); }} className="rounded border border-app-border px-3 py-2">{t("pluginApps.refresh")}</button></div>
    <p className="mb-4 text-sm text-tx-secondary">{t("pluginApps.localLayout")}</p>
    {error && <p role="alert">{t("pluginApps.failed")}</p>}
    <div className="mb-4 flex flex-wrap gap-2">
      <select aria-label={t("pluginApps.layout")} value={layouts?.active || ""} onChange={event => { if (layouts) { commit({ ...layouts, active: event.target.value }); setActiveApp(null); } }}>{layouts?.layouts.map(layout => <option key={layout.name}>{layout.name}</option>)}</select>
      {editing && <><input aria-label={t("pluginApps.layoutName")} maxLength={40} value={layoutName} onChange={event => setLayoutName(event.target.value)} className="rounded border border-app-border bg-app-surface px-2" />
      <button onClick={addLayout} disabled={!layoutName.trim() || (layouts?.layouts.length || 0) >= 5}>{t("pluginApps.addLayout")}</button>
      <button onClick={() => { if (window.confirm(t("pluginApps.resetLayout"))) { update(defaults(widgets).slice(0, 6)); setActiveApp(null); } }}>{t("pluginApps.resetLayout")}</button>
      <button disabled={(layouts?.layouts.length || 0) <= 1} onClick={() => { if (layouts && window.confirm(t("pluginApps.deleteLayout"))) { const next = layouts.layouts.filter(layout => layout.name !== layouts.active); commit({ active: next[0].name, layouts: next }); setActiveApp(null); } }}>{t("pluginApps.deleteLayout")}</button></>}
    </div>
    {editing && <details className="mb-4"><summary>{t("pluginApps.addCard")}</summary><div className="mt-2 flex flex-wrap gap-2">{widgets.map(widget => <button key={widget.runtimeId} disabled={!selected || selected.items.length >= 12 || selected.items.some(item => item.id === widget.runtimeId)} onClick={() => update([...(selected?.items || []), { id: widget.runtimeId, hidden: false, size: widget.defaultSize }])} className="rounded border border-app-border px-3 py-2">{widget.title}</button>)}</div></details>}
    {busy && <p role="status">{t("pluginApps.loading")}</p>}
    {!busy && widgets.length === 0 && <p>{t("pluginApps.empty")}</p>}
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
      {selected?.items.map((item, index) => {
        const widget = widgets.find(widget => widget.runtimeId === item.id); if (!widget || item.hidden && !editing) return null;
        return <article key={item.id} data-widget-id={item.id} draggable={editing} onDragStart={event => { dragged.current = index; event.dataTransfer.setData("text/plain", item.id); }} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); if (dragged.current !== null) update(moveDashboardWidget(selected.items, dragged.current, index)); dragged.current = null; }} className={`min-w-0 rounded-xl border border-app-border bg-app-surface p-4 ${item.size === "large" ? "md:col-span-2 xl:col-span-3" : item.size === "medium" ? "md:col-span-2" : ""}`}>
          <h2 className="mb-2 font-medium">{widget.title}</h2>
          {editing && <div className="mb-3 flex flex-wrap gap-2 text-xs [&>button]:min-h-8 [&>select]:min-h-8"><button aria-label={t("pluginApps.moveUp")} disabled={index === 0} onClick={() => update(moveDashboardWidget(selected.items, index, index - 1))}>↑</button><button aria-label={t("pluginApps.moveDown")} disabled={index === selected.items.length - 1} onClick={() => update(moveDashboardWidget(selected.items, index, index + 1))}>↓</button>
            <select aria-label={t("pluginApps.cardSize")} value={item.size} onChange={event => update(selected.items.map(other => other === item ? { ...other, size: event.target.value as WidgetSize } : other))}>{["small", "medium", "large"].map(size => <option value={size} key={size}>{t(`pluginApps.${size}`)}</option>)}</select>
            <button onClick={() => { update(selected.items.map(other => other === item ? { ...other, hidden: !other.hidden } : other)); setActiveApp(null); }}>{t(item.hidden ? "pluginApps.showCard" : "pluginApps.hideCard")}</button>
            <button onClick={() => { update(selected.items.filter(other => other !== item)); setActiveApp(null); }}>{t("pluginApps.removeCard")}</button>
          </div>}
          {!item.hidden && <>{widget.error ? <p role="alert">{t("pluginApps.unavailable")}</p> : widget.type === "statistic" ? <p className="my-4 text-3xl font-semibold">{widget.preview?.total ?? 0}</p> : widget.type === "status" ? <p>{t("pluginApps.statusSummary", { open: widget.preview?.open || 0, done: widget.preview?.done || 0 })}</p> : widget.type === "list" ? <ul className="mb-3 space-y-2">{widget.preview?.items.map(row => <li key={row.id} className="truncate">{row.title}</li>)}</ul> : null}
            {widget.type === "app" ? activeApp === item.id ? <div className="flex h-[440px] flex-col"><button className="mb-2 self-end text-xs" onClick={() => setActiveApp(null)}>{t("pluginApps.stopCard")}</button><PluginAppFrame page={widget.page} compact /></div> : <button onClick={() => setActiveApp(item.id)} className="rounded border border-app-border px-3 py-2">{t("pluginApps.startCard")}</button> : <button onClick={() => pushAppPathState(widget.page.route)} className="rounded border border-app-border px-3 py-2">{t("pluginApps.openApp")}</button>}
          </>}
        </article>;
      })}
    </div>
  </section>;
}
