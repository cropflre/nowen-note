import React, { useEffect, useRef, useState } from "react";
import { Blocks, Pin, PinOff } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useAppActions } from "@/store/AppContext";
import { usePluginApps } from "@/hooks/usePluginApps";
import { getCurrentWorkspace } from "@/lib/api";
import { pushAppPathState, replaceAppPathState } from "@/lib/appPathNavigation";
import { loadPluginAppPins, savePluginAppPins } from "@/lib/pluginApps";
import { pluginApi, pluginAppDocumentUrl, PLUGIN_CONTRIBUTIONS_CHANGED_EVENT, type PluginAppPage, type PluginAppSession } from "@/lib/pluginApi";
import { currentUiPlatform } from "@/lib/pluginUiRegistry";
import { connectPluginAppFrame } from "@/lib/pluginAppChannel";
import type { ViewMode } from "@/types";
import PluginDashboard from "./PluginDashboard";
import PluginDataActions from "./PluginDataActions";

export function PluginAppNavigation({ showLabel }: { showLabel: boolean }) {
  const { enabled, dashboardEnabled, pages, pinned } = usePluginApps();
  const { t } = useTranslation();
  const actions = useAppActions();
  if (!enabled) return null;
  const open = (path: string) => { pushAppPathState(path); actions.setMobileSidebar(false); };
  return <>
    {[{ runtimeId: "apps", title: t("pluginApps.title"), route: "/apps" }, ...(dashboardEnabled ? [{ runtimeId: "dashboard", title: t("pluginApps.dashboard"), route: "/apps/dashboard" }] : []), ...pages.filter(pinned)].map(page => (
      <button key={page.runtimeId} type="button" title={page.title} aria-label={page.title} onClick={() => open(page.route)} className="flex w-10 min-h-10 flex-col items-center justify-center rounded-lg text-tx-secondary hover:bg-app-hover">
        <Blocks size={17} />{showLabel && <span className="max-w-full truncate text-[10px]">{page.title}</span>}
      </button>
    ))}
  </>;
}

export function PluginAppFrame({ page, compact = false }: { page: PluginAppPage; compact?: boolean }) {
  const { t } = useTranslation();
  const actions = useAppActions();
  const frame = useRef<HTMLIFrameElement>(null);
  const connection = useRef<ReturnType<typeof connectPluginAppFrame>>();
  const activeSession = useRef<PluginAppSession | null>(null);
  const [session, setSession] = useState<PluginAppSession | null>(null);
  const [error, setError] = useState(false), [ready, setReady] = useState(false), [attempt, setAttempt] = useState(0);
  const requestController = useRef<AbortController>();
  const failRef = useRef<() => void>(() => undefined);
  useEffect(() => {
    const controller = new AbortController(); requestController.current = controller;
    let active = true, created: PluginAppSession | null = null;
    const fail = () => {
      if (!active) return;
      connection.current?.close(); activeSession.current = null; setSession(null); setReady(false); setError(true);
      controller.abort();
      if (created) void pluginApi.closeAppSession(created.instanceId, created.nonce).catch(() => undefined);
    };
    failRef.current = fail;
    setError(false); setReady(false);
    const start = async () => {
      try {
        created = await pluginApi.appSession(page, { workspaceId: getCurrentWorkspace(), platform: currentUiPlatform(), theme: document.documentElement.classList.contains("dark") ? "dark" : "light" }, controller.signal);
        if (!active || controller.signal.aborted) { void pluginApi.closeAppSession(created.instanceId, created.nonce).catch(() => undefined); return; }
        const events = await pluginApi.appEvents(created.instanceId, created.nonce, controller.signal);
        if (!events.ok || !events.body) throw new Error("PLUGIN_UI_SESSION_REVOKED");
        activeSession.current = created; setSession(created);
        const reader = events.body.getReader();
        try {
          let pending = "";
          const decoder = new TextDecoder();
          while (active && !controller.signal.aborted) {
            const chunk = await reader.read(); if (chunk.done) break;
            pending += decoder.decode(chunk.value, { stream: true });
            if (pending.includes("event: revoked")) { window.dispatchEvent(new Event(PLUGIN_CONTRIBUTIONS_CHANGED_EVENT)); break; }
            if (pending.length > 2048) pending = pending.slice(-100);
          }
        } finally { reader.releaseLock(); }
        fail();
      } catch { if (!controller.signal.aborted) fail(); }
    };
    void start();
    window.addEventListener("nowen:token-changed", fail);
    window.addEventListener("nowen:workspace-changed", fail);
    window.addEventListener(PLUGIN_CONTRIBUTIONS_CHANGED_EVENT, fail);
    const visibility = () => connection.current?.event("visibility.changed", { visible: !document.hidden });
    const observer = new MutationObserver(() => connection.current?.event("theme.changed", { theme: document.documentElement.classList.contains("dark") ? "dark" : "light" }));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    document.addEventListener("visibilitychange", visibility);
    return () => {
      active = false; controller.abort(); connection.current?.close(); activeSession.current = null;
      observer.disconnect(); document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("nowen:token-changed", fail); window.removeEventListener("nowen:workspace-changed", fail); window.removeEventListener(PLUGIN_CONTRIBUTIONS_CHANGED_EVENT, fail);
      if (created) void pluginApi.closeAppSession(created.instanceId, created.nonce).catch(() => undefined);
    };
  }, [page.pluginId, page.id, attempt]);

  const loaded = () => {
    const current = activeSession.current;
    if (!current || !frame.current || connection.current && ready) { failRef.current(); return; }
    connection.current?.close();
    connection.current = connectPluginAppFrame(frame.current, current, async message => {
      const response = await pluginApi.appCall(current.instanceId, message, requestController.current?.signal);
      if (activeSession.current !== current) throw new Error("PLUGIN_UI_SESSION_REVOKED");
      if (response.pluginId !== current.pluginId || response.instanceId !== current.instanceId || response.requestId !== message.requestId || response.protocol !== "nowen.plugin-ui.v3" || response.kind !== "response") throw new Error("PLUGIN_UI_INVALID_RESPONSE");
      if (message.method === "navigation.open" && response.ok) {
        const target = (response.data as { target?: string })?.target;
        if (["all", "favorites", "files", "diary", "tasks", "mindmaps", "ai-chat", "shares"].includes(target || "")) {
          replaceAppPathState("/"); actions.setViewMode(target as ViewMode); actions.setMobileView("list");
          const noteId = (response.data as { noteId?: string }).noteId;
          if (target === "all" && typeof noteId === "string") window.dispatchEvent(new CustomEvent("nowen:open-note-link", { detail: { noteId, blockId: null, href: `nowen://note/${noteId}` } }));
        }
      }
      return response;
    }, () => failRef.current(), () => setReady(true));
  };
  return <div className="flex min-h-0 flex-1 flex-col">
    {!compact && <div className="flex items-center gap-3 border-b border-app-border p-3">
      <button onClick={() => pushAppPathState("/apps")} className="rounded px-2 py-1 hover:bg-app-hover">{t("pluginApps.back")}</button><h1 className="font-medium">{page.title}</h1>
    </div>}
    {error ? <div role="alert" className="p-6"><p>{t("pluginApps.failed")}</p><button className="mt-3 rounded border border-app-border px-3 py-2" onClick={() => { connection.current = undefined; setAttempt(value => value + 1); }}>{t("pluginApps.retry")}</button></div>
      : <>{!ready && <p role="status" className="p-4">{t("pluginApps.loading")}</p>}{session && <iframe ref={frame} title={page.title} sandbox="allow-scripts" referrerPolicy="no-referrer" allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'" src={pluginAppDocumentUrl(session)} onLoad={loaded} className="min-h-0 w-full flex-1 border-0 bg-white" />}</>}
  </div>;
}

export default function PluginApps({ pluginId, pageId, dashboard = false }: { pluginId?: string; pageId?: string; dashboard?: boolean }) {
  const { enabled, dashboardEnabled, pages, pinned } = usePluginApps();
  const { t } = useTranslation();
  const selected = pages.find(page => page.pluginId === pluginId && page.id === pageId);
  if (dashboard) return <PluginDashboard />;
  if (selected && enabled) return <PluginAppFrame key={selected.runtimeId} page={selected} />;
  return <div className="min-h-0 flex-1 overflow-y-auto p-6"><h1 className="mb-4 text-xl font-semibold">{t("pluginApps.title")}</h1>{dashboardEnabled && <button className="mb-4 rounded border border-app-border px-3 py-2" onClick={() => pushAppPathState("/apps/dashboard")}>{t("pluginApps.dashboard")}</button>}
    {!enabled || pages.length === 0 || pluginId ? <p>{t(pluginId ? "pluginApps.unavailable" : "pluginApps.empty")}</p> : <ul className="space-y-3">{pages.map(page => <li key={page.runtimeId} className="flex items-center justify-between gap-4 rounded-lg border border-app-border p-4">
      <div className="min-w-0"><button aria-label={page.title} className="mb-2 text-left" onClick={() => pushAppPathState(page.route)}><span className="block font-medium">{page.title}</span><span className="text-sm text-tx-secondary">{page.pluginId}</span></button><PluginDataActions pluginId={page.pluginId} /></div>
      <button aria-label={t(pinned(page) ? "pluginApps.unpin" : "pluginApps.pin")} onClick={() => { const pins = loadPluginAppPins(); savePluginAppPins(pinned(page) ? pins.filter(id => id !== page.runtimeId) : [...pins, page.runtimeId]); }}>{pinned(page) ? <PinOff size={18} /> : <Pin size={18} />}</button>
    </li>)}</ul>}
  </div>;
}
