import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { connectSyncServer, disableSync, fetchSyncDiagnostics, fetchSyncSettings, triggerSyncNow, type SyncDiagnostics, type SyncSettingsResponse } from "@/lib/syncLocalApi";
import { getServerUrl } from "@/lib/api";
import { formatAppDateTime } from "@/lib/dateTime";
import { isMobileLocalMode, requestMobileAccountLogin } from "@/lib/mobileLocalMode";
import { OfflineAvailability } from "./OfflineAvailability";

export default function MobileSyncSettings() {
  const { t, i18n } = useTranslation();
  const [diagnostics, setDiagnostics] = useState<SyncDiagnostics | null>(null);
  const [settings, setSettings] = useState<SyncSettingsResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const syncEnabled = settings?.mode === "server";
  const reload = useCallback(async () => {
    try {
      const next = await fetchSyncSettings();
      setSettings(next);
      setDiagnostics(await fetchSyncDiagnostics());
      setError(null);
    } catch {
      setError("mobileSync.settingsReadFailed");
    }
  }, []);
  useEffect(() => {
    void reload();
    const timer = window.setInterval(() => { void reload(); }, 5000);
    return () => window.clearInterval(timer);
  }, [reload]);
  const changeMode = async (enabled: boolean) => {
    if (enabled && (isMobileLocalMode() || !settings?.authorized)) {
      requestMobileAccountLogin();
      window.location.reload();
      return;
    }
    setBusy(true); setError(null);
    try {
      if (enabled) await connectSyncServer({ serverUrl: settings?.profiles[0]?.serverUrl || getServerUrl() });
      else await disableSync();
      await reload();
    } catch {
      setError("mobileSync.settingsChangeFailed");
    } finally { setBusy(false); }
  };
  return <div className="space-y-4">
    <section className="space-y-3">
      <h3 className="text-sm font-semibold tracking-tight">{t("mobileSync.title")}</h3>
      {settings ? <>
        <label className={`flex cursor-pointer items-start gap-3 rounded-2xl border p-4 shadow-sm backdrop-blur-md transition-all ${!syncEnabled ? "border-indigo-500/50 bg-indigo-500/[0.06] ring-1 ring-indigo-500/20" : "border-app-border/80 bg-app-surface/80 hover:border-app-border"}`}>
          <input type="radio" name="mobile-sync-mode" className="mt-1 accent-indigo-500" checked={!syncEnabled} disabled={busy}
            onChange={() => { void changeMode(false); }} />
          <span className="space-y-1">
            <span className="block text-sm font-semibold">{t("mobileSync.deviceOnly")}</span>
            <span className="block text-xs text-tx-tertiary">{t("mobileSync.deviceOnlyHint")}</span>
          </span>
        </label>
        <label className={`flex cursor-pointer items-start gap-3 rounded-2xl border p-4 shadow-sm backdrop-blur-md transition-all ${syncEnabled ? "border-indigo-500/50 bg-indigo-500/[0.06] ring-1 ring-indigo-500/20" : "border-app-border/80 bg-app-surface/80 hover:border-app-border"}`}>
          <input type="radio" name="mobile-sync-mode" className="mt-1 accent-indigo-500" checked={syncEnabled} disabled={busy}
            onChange={() => { void changeMode(true); }} />
          <span className="space-y-1">
            <span className="block text-sm font-semibold">{t("mobileSync.ownServer")}</span>
            <span className="block text-xs text-tx-tertiary">{t("mobileSync.ownServerHint")}</span>
            {syncEnabled && <span className="mt-1 inline-block rounded-full bg-emerald-500/12 px-2.5 py-0.5 text-xs font-medium text-emerald-700 dark:text-emerald-300">{t("mobileSync.connected", { url: settings.activeProfile?.serverUrl || "" })}</span>}
          </span>
        </label>
        <p className="text-xs text-tx-tertiary">{t("mobileSync.devicesHint")}</p>
      </> : <p className="rounded-2xl border border-app-border/70 bg-app-surface/70 px-4 py-3 text-sm text-tx-tertiary backdrop-blur-sm">{error ? t(error) : t("mobileSync.loadingSettings")}</p>}
    </section>
    <OfflineAvailability offline={diagnostics?.offline} />
    {settings?.authorizationState === "expired" && <div className="space-y-2.5 rounded-2xl border border-amber-400/40 bg-amber-500/[0.08] p-4 text-xs backdrop-blur-sm">
      <p className="font-medium text-amber-800 dark:text-amber-200">{t("offlineAvailability.authExpired")}</p>
      <button type="button" className="rounded-xl bg-gradient-to-r from-indigo-500 to-violet-500 px-3.5 py-2 font-medium text-white shadow-sm shadow-indigo-500/20 transition-all hover:brightness-105 active:scale-[0.98]" onClick={() => { requestMobileAccountLogin(); window.location.reload(); }}>{t("auth.loginButton")}</button>
    </div>}
    {syncEnabled &&
    <section className="space-y-3 rounded-2xl border border-app-border/80 bg-app-surface/85 p-4 shadow-sm backdrop-blur-md">
      <h3 className="text-sm font-semibold tracking-tight">{t("mobileSync.statusTitle")}</h3>
      <p className="text-sm font-medium text-tx-secondary">{diagnostics?.lastError ? t("mobileSync.waitingRecovery") : diagnostics ? t("mobileSync.enabled") : t("mobileSync.loadingStatus")}</p>
      <div className="space-y-1 rounded-xl border border-app-border/60 bg-app-bg/60 p-3 tabular-nums">
        <p className="text-xs text-tx-tertiary">{t("mobileSync.pendingChanges", { pending: diagnostics?.pendingMutations ?? "—" })}</p>
        <p className="text-xs text-tx-tertiary">{t("mobileSync.pendingAttachments", { pending: diagnostics?.pendingAttachments ?? "—" })}</p>
        <p className="text-xs text-tx-tertiary">{t("mobileSync.lastSync", { time: diagnostics?.lastSyncAt ? formatAppDateTime(diagnostics.lastSyncAt, undefined, undefined, i18n.language) : t("mobileSync.neverSynced") })}</p>
      </div>
      <button type="button" disabled={busy} className="rounded-xl border border-app-border/90 bg-app-bg/80 px-4 py-2 text-sm font-medium shadow-xs transition-all hover:border-indigo-400/50 hover:bg-indigo-500/[0.06] active:scale-[0.98] disabled:opacity-50" onClick={async () => {
        setBusy(true);
        try { await triggerSyncNow(); await reload(); }
        catch { setError("mobileSync.startFailed"); }
        finally { setBusy(false); }
      }}>{busy ? t("mobileSync.requestingSync") : t("mobileSync.syncNow")}</button>
    </section>}
    {settings && error && <p className="text-xs text-tx-tertiary">{t(error)}</p>}
  </div>;
}
