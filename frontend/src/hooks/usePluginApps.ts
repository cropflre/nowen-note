import { useCallback, useEffect, useState } from "react";
import { pluginApi, PLUGIN_CONTRIBUTIONS_CHANGED_EVENT, type PluginAppPage } from "@/lib/pluginApi";
import { currentUiPlatform } from "@/lib/pluginUiRegistry";
import { loadPluginAppPins } from "@/lib/pluginApps";

export function usePluginApps() {
  const [enabled, setEnabled] = useState(false), [pages, setPages] = useState<PluginAppPage[]>([]);
  const [pins, setPins] = useState<string[]>(loadPluginAppPins);
  // The Extension Center (discover / manage / workbench) only needs a reachable server on web or
  // desktop; V3 app pages and dashboard widgets keep their own switches.
  const [centerEnabled, setCenterEnabled] = useState(false);
  useEffect(() => {
    let generation = 0, active = true;
    const load = async () => {
      const current = ++generation;
      setPins(loadPluginAppPins());
      const platform = currentUiPlatform();
      if (platform !== "web" && platform !== "desktop" || (window as Window & { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.()) { setEnabled(false); setCenterEnabled(false); setPages([]); return; }
      try {
        const features = await pluginApi.features();
        if (active && current === generation) setCenterEnabled(true);
        const allowed = features.applicationV3?.appPages === true;
        const result = allowed ? await pluginApi.apps(platform) : [];
        if (active && current === generation) { setEnabled(allowed); setPages(result); }
      } catch { if (active && current === generation) { setEnabled(false); setPages([]); } }
    };
    const reset = () => { generation++; setEnabled(false); setCenterEnabled(false); setPages([]); void load(); };
    const contributionsChanged = () => { generation++; setPages([]); void load(); };
    const pinChange = () => setPins(loadPluginAppPins());
    void load();
    window.addEventListener(PLUGIN_CONTRIBUTIONS_CHANGED_EVENT, contributionsChanged);
    window.addEventListener("nowen:token-changed", reset);
    window.addEventListener("nowen:workspace-changed", reset);
    window.addEventListener("focus", load);
    window.addEventListener("nowen:plugin-app-pins-changed", pinChange);
    return () => {
      active = false; generation++;
      window.removeEventListener(PLUGIN_CONTRIBUTIONS_CHANGED_EVENT, contributionsChanged);
      window.removeEventListener("nowen:token-changed", reset);
      window.removeEventListener("nowen:workspace-changed", reset);
      window.removeEventListener("focus", load);
      window.removeEventListener("nowen:plugin-app-pins-changed", pinChange);
    };
  }, []);
  const pinned = useCallback((page: PluginAppPage) => pins.includes(page.runtimeId), [pins]);
  // The workbench has built-in cards, so it is available wherever the Extension Center is;
  // plugin widgets inside it still follow the V3 dashboard switch (checked by PluginDashboard).
  return { enabled, centerEnabled, dashboardEnabled: centerEnabled, pages, pins, pinned };
}
