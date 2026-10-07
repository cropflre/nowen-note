import { useCallback, useEffect, useState } from "react";
import { connectSyncServer, disableSync, fetchSyncDiagnostics, fetchSyncSettings, triggerSyncNow, type SyncDiagnostics, type SyncSettingsResponse } from "@/lib/syncLocalApi";
import { getServerUrl } from "@/lib/api";
import { isMobileLocalMode, requestMobileAccountLogin } from "@/lib/mobileLocalMode";

export default function MobileSyncSettings() {
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
      setError("暂时无法读取同步设置，本机数据仍保留。请稍后重试。");
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
      setError("未能更改同步设置，本机数据仍保留。请稍后重试。");
    } finally { setBusy(false); }
  };
  return <div className="space-y-4">
    <section className="space-y-3">
      <h3 className="text-sm font-medium">同步</h3>
      {settings ? <>
        <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-app-border p-4">
          <input type="radio" name="mobile-sync-mode" className="mt-1" checked={!syncEnabled} disabled={busy}
            onChange={() => { void changeMode(false); }} />
          <span className="space-y-1">
            <span className="block text-sm font-medium">不同步，仅此设备</span>
            <span className="block text-xs text-tx-tertiary">新增和修改只保存在这台设备，不自动上传或接收更新。关闭后，服务器已有数据仍保留。</span>
          </span>
        </label>
        <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-app-border p-4">
          <input type="radio" name="mobile-sync-mode" className="mt-1" checked={syncEnabled} disabled={busy}
            onChange={() => { void changeMode(true); }} />
          <span className="space-y-1">
            <span className="block text-sm font-medium">我的 Nowen Server</span>
            <span className="block text-xs text-tx-tertiary">先保存到本机，再自动同步到你的服务器。断网照常编辑，恢复后自动补传。</span>
            {syncEnabled && <span className="block text-xs text-tx-secondary">已连接 {settings.activeProfile?.serverUrl}</span>}
          </span>
        </label>
        <p className="text-xs text-tx-tertiary">手机和电脑客户端都开启同步，并登录同一服务器的同一账号，笔记就会自动保持一致。</p>
      </> : <p className="text-sm text-tx-tertiary">{error || "正在读取同步设置…"}</p>}
    </section>
    {syncEnabled &&
    <section className="space-y-3 rounded-lg border border-app-border p-4">
      <h3 className="text-sm font-medium">同步状态</h3>
      <p className="text-sm text-tx-secondary">{diagnostics?.lastError ? "等待恢复同步 · 数据保存在本机" : diagnostics ? "自动同步已开启" : "正在读取同步状态…"}</p>
        <p className="text-xs text-tx-tertiary">待同步数量：{diagnostics?.pendingMutations ?? "—"}</p>
        <p className="text-xs text-tx-tertiary">待传输附件：{diagnostics?.pendingAttachments ?? "—"}</p>
        <p className="text-xs text-tx-tertiary">最后同步时间：{diagnostics?.lastSyncAt ? new Date(diagnostics.lastSyncAt).toLocaleString() : "尚未完成同步"}</p>
        <button type="button" disabled={busy} className="rounded-md border border-app-border px-3 py-2 text-sm disabled:opacity-50" onClick={async () => {
          setBusy(true);
          try { await triggerSyncNow(); await reload(); }
          catch { setError("暂时无法启动同步，本机数据仍保留。请稍后重试。"); }
          finally { setBusy(false); }
        }}>{busy ? "正在请求同步…" : "立即同步"}</button>
    </section>}
    {settings && error && <p className="text-xs text-tx-tertiary">{error}</p>}
  </div>;
}
