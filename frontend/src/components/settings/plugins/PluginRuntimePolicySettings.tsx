import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { pluginApi } from "@/lib/pluginApi";

export function PluginRuntimePolicySettings({ onPolicyChange }: { onPolicyChange?: (allowed: boolean | null) => void }) {
  const { t } = useTranslation();
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    onPolicyChange?.(null);
    void pluginApi.getRuntimePolicy().then((policy) => { if (active) { setAllowed(policy.allowNodeRuntime); onPolicyChange?.(policy.allowNodeRuntime); } }).catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { active = false; };
  }, [onPolicyChange]);
  const change = async (enabled: boolean) => {
    if (enabled && !window.confirm(t("plugins.runtimePolicy.confirm"))) return;
    setBusy(true); setError("");
    try { const policy = await pluginApi.setRuntimePolicy(enabled); setAllowed(policy.allowNodeRuntime); onPolicyChange?.(policy.allowNodeRuntime); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  return <div className="rounded-xl border p-3 dark:border-zinc-800">
    <label className="flex items-center justify-between gap-3 text-sm font-medium">
      {t("plugins.runtimePolicy.title")}
      <input type="checkbox" checked={allowed === true} disabled={allowed === null || busy} onChange={(event) => void change(event.target.checked)} />
    </label>
    <p className="mt-1 text-xs text-zinc-500">{t("plugins.runtimePolicy.description")}</p>
    {error && <p role="alert" className="mt-2 text-xs text-red-600">{error}</p>}
  </div>;
}
