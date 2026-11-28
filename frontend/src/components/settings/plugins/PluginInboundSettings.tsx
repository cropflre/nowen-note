import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getBaseUrl } from "@/lib/api.impl";
import { pluginApi, type InstalledPlugin } from "@/lib/pluginApi";

export function PluginInboundSettings({ plugin }: { plugin: InstalledPlugin }) {
  const { t } = useTranslation();
  const [configured, setConfigured] = useState<string[]>([]);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void pluginApi.inboundWebhooks(plugin.id).then((rows) => { if (active) setConfigured(rows.map((row) => row.hookId)); }).catch((cause) => { if (active) setError(String(cause.message || cause)); });
    return () => { active = false; };
  }, [plugin.id]);
  const change = async (hookId: string, remove: boolean) => {
    if (configured.includes(hookId) && !window.confirm(t(remove ? "plugins.inbound.revokeConfirm" : "plugins.inbound.rotateConfirm"))) return;
    setBusy(true); setError("");
    try {
      if (remove) { await pluginApi.removeInboundWebhook(plugin.id, hookId); setUrls((current) => { const next = { ...current }; delete next[hookId]; return next; }); }
      else { const result = await pluginApi.createInboundWebhook(plugin.id, hookId); setUrls((current) => ({ ...current, [hookId]: new URL(result.path, new URL(getBaseUrl(), window.location.origin)).href })); }
      setConfigured((await pluginApi.inboundWebhooks(plugin.id)).map((row) => row.hookId));
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  return (
    <div className="space-y-2.5 text-xs">
      <div>
        <h4 className="font-bold text-tx-primary">{t("plugins.inbound.title")}</h4>
        <p className="mt-0.5 text-tx-secondary">{t("plugins.inbound.description")}</p>
      </div>
      {error && <p role="alert" className="rounded-xl border border-rose-400/35 bg-rose-500/10 px-3 py-1.5 font-medium text-rose-600 dark:text-rose-300">{error}</p>}
      {plugin.contributes?.inboundWebhooks?.map((hook) => {
        const isConfigured = configured.includes(hook.id);
        return (
          <div key={hook.id} className="space-y-2.5 rounded-xl border border-app-border/80 bg-app-surface/75 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-mono font-semibold text-tx-primary">{hook.id}</span>
              <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${isConfigured ? "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300" : "bg-app-hover text-tx-tertiary"}`}>
                {isConfigured ? t("plugins.inbound.configured") : t("plugins.inbound.unconfigured")}
              </span>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                disabled={busy || plugin.status !== "enabled"}
                className="rounded-xl border border-purple-500/30 bg-purple-500/10 px-3 py-1.5 font-semibold text-purple-700 transition-colors hover:bg-purple-500/15 disabled:opacity-40 dark:text-purple-300"
                onClick={() => void change(hook.id, false)}
              >
                {t(isConfigured ? "plugins.inbound.rotate" : "plugins.inbound.create")}
              </button>
              {isConfigured && (
                <button
                  disabled={busy}
                  className="rounded-xl border border-rose-400/35 bg-rose-500/10 px-3 py-1.5 font-semibold text-rose-600 transition-colors hover:bg-rose-500/15 disabled:opacity-40 dark:text-rose-300"
                  onClick={() => void change(hook.id, true)}
                >
                  {t("plugins.inbound.revoke")}
                </button>
              )}
            </div>
            {urls[hook.id] && (
              <div className="space-y-1">
                <p className="text-[11px] font-medium text-amber-700 dark:text-amber-300">{t("plugins.inbound.showOnce")}</p>
                <input
                  aria-label={t("plugins.inbound.url")}
                  readOnly
                  value={urls[hook.id]}
                  onFocus={(event) => event.target.select()}
                  className="w-full rounded-xl border border-app-border/80 bg-app-elevated px-3 py-1.5 font-mono text-xs text-tx-primary outline-none focus:border-purple-400"
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
