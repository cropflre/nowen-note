import React, { lazy, Suspense, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "@/lib/api";

const PluginSettingsTab = lazy(() => import("./settings/plugins/PluginSettingsTab"));

export default function PluginManagementPanel() {
  const { t } = useTranslation();
  const [user, setUser] = useState<{ role?: string } | null>(null);
  const [failed, setFailed] = useState(false), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true, generation = 0;
    const load = async () => {
      const current = ++generation;
      setUser(null); setFailed(false);
      try {
        const result = await api.getMe();
        if (active && current === generation) setUser(result);
      } catch { if (active && current === generation) setFailed(true); }
    };
    void load();
    window.addEventListener("nowen:token-changed", load);
    window.addEventListener("nowen:workspace-changed", load);
    return () => { active = false; generation++; window.removeEventListener("nowen:token-changed", load); window.removeEventListener("nowen:workspace-changed", load); };
  }, [attempt]);
  if (failed) return <div role="alert"><p>{t("pluginApps.managementFailed")}</p><button type="button" onClick={() => setAttempt(value => value + 1)} className="mt-3 rounded border border-app-border px-3 py-2">{t("pluginApps.retry")}</button></div>;
  const loading = <div role="status" className="flex items-center gap-2 p-4"><Loader2 size={16} className="animate-spin" />{t("pluginApps.loading")}</div>;
  if (!user) return loading;
  return <Suspense fallback={loading}><PluginSettingsTab isAdmin={user.role === "admin"} /></Suspense>;
}
