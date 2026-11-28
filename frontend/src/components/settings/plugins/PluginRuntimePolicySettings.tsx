import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ShieldAlert } from "lucide-react";
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
  return (
    <div className="rounded-2xl border border-app-border/80 bg-app-elevated/80 p-4 shadow-xs backdrop-blur-sm">
      <label className="flex cursor-pointer items-center justify-between gap-3 text-sm font-semibold text-tx-primary">
        <span className="flex items-center gap-2.5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-amber-500/12 text-amber-600 ring-1 ring-amber-500/20 dark:text-amber-300">
            <ShieldAlert size={15} />
          </span>
          <span>{t("plugins.runtimePolicy.title")}</span>
        </span>
        <span className="relative inline-flex shrink-0 items-center">
          <input
            type="checkbox"
            checked={allowed === true}
            disabled={allowed === null || busy}
            onChange={(event) => void change(event.target.checked)}
            className="peer sr-only"
          />
          <span
            aria-hidden="true"
            className="h-6 w-11 rounded-full bg-app-border/90 p-0.5 transition-all peer-checked:bg-gradient-to-r peer-checked:from-purple-500 peer-checked:to-pink-500 peer-focus-visible:ring-2 peer-focus-visible:ring-purple-500/40 peer-disabled:opacity-50"
          >
            <span className="block h-5 w-5 rounded-full bg-white shadow-sm transition-transform duration-200 peer-checked:translate-x-5" />
          </span>
        </span>
      </label>
      <p className="mt-2 text-xs leading-relaxed text-tx-secondary">{t("plugins.runtimePolicy.description")}</p>
      {error && <p role="alert" className="mt-2 rounded-xl border border-rose-400/35 bg-rose-500/10 px-3 py-1.5 text-xs font-medium text-rose-600 dark:text-rose-300">{error}</p>}
    </div>
  );
}
