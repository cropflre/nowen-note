import { useCallback, useEffect, useState } from "react";
import { pluginApi, PLUGIN_CONTRIBUTIONS_CHANGED_EVENT, type PluginAppPage } from "@/lib/pluginApi";
import { currentUiPlatform } from "@/lib/pluginUiRegistry";
import { loadPluginAppPins } from "@/lib/pluginApps";

export function usePluginApps() {
  const [enabled, setEnabled] = useState(false), [pages, setPages] = useState<PluginAppPage[]>([]);
  const [pins, setPins] = useState<string[]>(loadPluginAppPins);
  const [dashboardEnabled, setDashboardEnabled] = useState(false);
  useEffect(() => {
    let generation = 0, active = true;
    const load = async () => {
      const current = ++generation;
      setPins(loadPluginAppPins());
      const platform = currentUiPlatform();
      if (platform !== "web" && platform !== "desktop" || (window as Window & { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.()) { setEnabled(false); setPages([]); return; }
      try {
        const features = await pluginApi.features();
        const allowed = features.applicationV3?.appPages === true;
        const result = allowed ? await pluginApi.apps(platform) : [];
        if (active && current === generation) { setEnabled(allowed); setDashboardEnabled(allowed && features.applicationV3?.dashboardWidgets === true); setPages(result); }
      } catch { if (active && current === generation) { setEnabled(false); setPages([]); } }
    };
    const reset = () => { generation++; setEnabled(false); setPages([]); void load(); };
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
  return { enabled, dashboardEnabled: enabled && dashboardEnabled, pages, pins, pinned };
}
