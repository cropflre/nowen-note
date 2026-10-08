import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { connectSyncServer, disableSync, fetchSyncDiagnostics, fetchSyncSettings, triggerSyncNow, type SyncDiagnostics, type SyncSettingsResponse } from "@/lib/syncLocalApi";
import { getServerUrl } from "@/lib/api";
import { isMobileLocalMode, requestMobileAccountLogin } from "@/lib/mobileLocalMode";

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
      setDiagnostics(next.mode === "server" ? await fetchSyncDiagnostics() : null);
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
      <h3 className="text-sm font-medium">{t("mobileSync.title")}</h3>
      {settings ? <>
        <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-app-border p-4">
          <input type="radio" name="mobile-sync-mode" className="mt-1" checked={!syncEnabled} disabled={busy}
            onChange={() => { void changeMode(false); }} />
          <span className="space-y-1">
            <span className="block text-sm font-medium">{t("mobileSync.deviceOnly")}</span>
            <span className="block text-xs text-tx-tertiary">{t("mobileSync.deviceOnlyHint")}</span>
          </span>
        </label>
        <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-app-border p-4">
          <input type="radio" name="mobile-sync-mode" className="mt-1" checked={syncEnabled} disabled={busy}
            onChange={() => { void changeMode(true); }} />
          <span className="space-y-1">
            <span className="block text-sm font-medium">{t("mobileSync.ownServer")}</span>
            <span className="block text-xs text-tx-tertiary">{t("mobileSync.ownServerHint")}</span>
            {syncEnabled && <span className="block text-xs text-tx-secondary">{t("mobileSync.connected", { url: settings.activeProfile?.serverUrl || "" })}</span>}
          </span>
        </label>
        <p className="text-xs text-tx-tertiary">{t("mobileSync.devicesHint")}</p>
      </> : <p className="text-sm text-tx-tertiary">{error ? t(error) : t("mobileSync.loadingSettings")}</p>}
    </section>
    {syncEnabled &&
    <section className="space-y-3 rounded-lg border border-app-border p-4">
      <h3 className="text-sm font-medium">{t("mobileSync.statusTitle")}</h3>
      <p className="text-sm text-tx-secondary">{diagnostics?.lastError ? t("mobileSync.waitingRecovery") : diagnostics ? t("mobileSync.enabled") : t("mobileSync.loadingStatus")}</p>
        <p className="text-xs text-tx-tertiary">{t("mobileSync.pendingChanges", { pending: diagnostics?.pendingMutations ?? "—" })}</p>
        <p className="text-xs text-tx-tertiary">{t("mobileSync.pendingAttachments", { pending: diagnostics?.pendingAttachments ?? "—" })}</p>
        <p className="text-xs text-tx-tertiary">{t("mobileSync.lastSync", { time: diagnostics?.lastSyncAt ? new Date(diagnostics.lastSyncAt).toLocaleString(i18n.language) : t("mobileSync.neverSynced") })}</p>
        <button type="button" disabled={busy} className="rounded-md border border-app-border px-3 py-2 text-sm disabled:opacity-50" onClick={async () => {
          setBusy(true);
          try { await triggerSyncNow(); await reload(); }
          catch { setError("mobileSync.startFailed"); }
          finally { setBusy(false); }
        }}>{busy ? t("mobileSync.requestingSync") : t("mobileSync.syncNow")}</button>
    </section>}
    {settings && error && <p className="text-xs text-tx-tertiary">{t(error)}</p>}
  </div>;
}
