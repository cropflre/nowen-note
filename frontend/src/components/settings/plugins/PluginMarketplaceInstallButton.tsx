import { useState } from "react";
import { Download } from "lucide-react";
import { useTranslation } from "react-i18next";
import { pluginApi, type RegistryPlugin } from "@/lib/pluginApi";

export function PluginMarketplaceInstallButton({ sourceId, plugin, nodeRuntimeAllowed, onInstalled }: {
  sourceId: string; plugin: RegistryPlugin; nodeRuntimeAllowed: boolean | null; onInstalled: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const needsPolicy = plugin.runtime === "node-action" && nodeRuntimeAllowed !== true;
  const install = async () => {
    if (busy || needsPolicy) return;
    setBusy(true); setError("");
    try { await pluginApi.installFromRegistry(sourceId, plugin.id, plugin.latestVersion); await onInstalled(); }
    catch (cause) {
      const coded = cause as Error & { code?: string; status?: number };
      setError(coded.status === 401 ? t("plugins.marketplace.loginRequired") : coded.message || String(cause));
    } finally { setBusy(false); }
  };
  return <div className="space-y-1 text-right">
    <button disabled={busy || needsPolicy} onClick={() => void install()} className="inline-flex items-center gap-1 rounded-md bg-indigo-600 px-2.5 py-1.5 text-white disabled:opacity-50"><Download size={12} />{t(busy ? "plugins.marketplace.installing" : "plugins.marketplace.install")}</button>
    {needsPolicy && <p className="max-w-64 text-xs text-amber-600">{t(nodeRuntimeAllowed === null ? "plugins.marketplace.policyLoading" : "plugins.marketplace.policyRequired")}</p>}
    {error && <p role="alert" className="max-w-64 text-xs text-red-600">{error}</p>}
  </div>;
}
