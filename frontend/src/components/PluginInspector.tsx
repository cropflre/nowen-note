import React, { lazy, Suspense, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ScanSearch, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { pluginApi, PLUGIN_CONTRIBUTIONS_CHANGED_EVENT, type PluginInspector as Inspector, type PluginInspectorResource } from "@/lib/pluginApi";
import { currentUiPlatform } from "@/lib/pluginUiRegistry";
const PluginAppFrame = lazy(() => import("./PluginApps").then(module => ({ default: module.PluginAppFrame })));

function InspectorDialog({ inspectors, resource, workspaceId, onClose }: { inspectors: Inspector[]; resource: PluginInspectorResource; workspaceId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const dialog = useRef<HTMLDialogElement>(null);
  const [selected, setSelected] = useState(0);
  useEffect(() => {
    const element = dialog.current; element?.showModal();
    return () => element?.close();
  }, []);
  const page = inspectors[selected];
  return createPortal(<dialog ref={dialog} aria-label={t("pluginApps.inspectorTitle")} onCancel={onClose} onClose={onClose}
    className="fixed inset-0 m-auto h-[min(640px,90dvh)] w-[min(480px,95vw)] max-w-none rounded-xl border border-app-border bg-app-surface p-0 text-tx-primary shadow-xl backdrop:bg-black/40">
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-3 border-b border-app-border p-3">
        <label className="min-w-0 flex-1 text-sm">{t("pluginApps.inspectorTitle")}
          <select aria-label={t("pluginApps.chooseInspector")} value={selected} onChange={event => setSelected(Number(event.target.value))} className="ml-2 max-w-full rounded border border-app-border bg-app-bg p-1">
            {inspectors.map((item, index) => <option key={`${item.pluginId}/${item.inspectorId}`} value={index}>{item.title}</option>)}
          </select>
        </label>
        <button type="button" aria-label={t("pluginApps.closeInspector")} onClick={onClose} className="rounded p-1 hover:bg-app-hover"><X size={18} /></button>
      </div>
      <p className="px-3 py-2 text-xs text-tx-secondary">{t("pluginApps.inspectorReadOnly")}</p>
      <Suspense fallback={<p role="status" className="p-3">{t("pluginApps.loading")}</p>}>
        {page && <PluginAppFrame key={`${page.pluginId}/${page.inspectorId}`} page={page} compact workspaceId={workspaceId} inspector={{ id: page.inspectorId, resource }} />}
      </Suspense>
    </div>
  </dialog>, document.body);
}

export default function PluginInspector({ resource, workspaceId: scope }: { resource: PluginInspectorResource; workspaceId?: string | null }) {
  const { t } = useTranslation();
  const workspaceId = scope || "personal", identity = `${workspaceId}:${resource.type}:${resource.id}`;
  const [available, setAvailable] = useState<{ identity: string; items: Inspector[] }>();
  const [opened, setOpened] = useState<string>();
  useEffect(() => {
    let active = true, generation = 0;
    const load = async () => {
      const current = ++generation;
      setAvailable(undefined); setOpened(undefined);
      const platform = currentUiPlatform();
      if (!["web", "desktop"].includes(platform) || (window as any).Capacitor?.isNativePlatform?.()) return;
      try {
        const features = await pluginApi.features();
        const items = features.applicationV3?.inspectors ? await pluginApi.inspectors(platform, resource.type, workspaceId) : [];
        if (active && current === generation) setAvailable({ identity, items });
      } catch { /* Closed on unavailable or unauthorized hosts. */ }
    };
    void load();
    const events = [PLUGIN_CONTRIBUTIONS_CHANGED_EVENT, "nowen:token-changed", "nowen:workspace-changed"];
    events.forEach(event => window.addEventListener(event, load));
    return () => { active = false; generation++; events.forEach(event => window.removeEventListener(event, load)); };
  }, [identity, resource.type, workspaceId]);
  const inspectors = available?.identity === identity ? available.items : [];
  if (!inspectors.length) return null;
  return <>
    <button type="button" title={t("pluginApps.inspectorTitle")} aria-label={t("pluginApps.inspectorTitle")} onClick={() => setOpened(identity)} className="shrink-0 rounded p-1.5 text-tx-secondary hover:bg-app-hover"><ScanSearch size={15} /></button>
    {opened === identity && <InspectorDialog inspectors={inspectors} resource={resource} workspaceId={workspaceId} onClose={() => setOpened(undefined)} />}
  </>;
}
