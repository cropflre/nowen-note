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
  return <div className="space-y-2 text-xs">
    <h4 className="font-semibold">{t("plugins.inbound.title")}</h4>
    <p className="text-zinc-500">{t("plugins.inbound.description")}</p>
    {error && <p role="alert" className="text-red-600">{error}</p>}
    {plugin.contributes?.inboundWebhooks?.map((hook) => <div key={hook.id} className="space-y-2 rounded-lg border p-2 dark:border-zinc-800">
      <div>{hook.id} · {configured.includes(hook.id) ? t("plugins.inbound.configured") : t("plugins.inbound.unconfigured")}</div>
      <div className="flex gap-2">
        <button disabled={busy || plugin.status !== "enabled"} className="rounded border px-2 py-1 disabled:opacity-40" onClick={() => void change(hook.id, false)}>{t(configured.includes(hook.id) ? "plugins.inbound.rotate" : "plugins.inbound.create")}</button>
        {configured.includes(hook.id) && <button disabled={busy} className="rounded border px-2 py-1 text-red-600" onClick={() => void change(hook.id, true)}>{t("plugins.inbound.revoke")}</button>}
      </div>
      {urls[hook.id] && <div><p>{t("plugins.inbound.showOnce")}</p><input aria-label={t("plugins.inbound.url")} readOnly value={urls[hook.id]} onFocus={(event) => event.target.select()} className="mt-1 w-full rounded border bg-transparent p-1.5 font-mono dark:border-zinc-700" /></div>}
    </div>)}
  </div>;
}
