import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Cloud,
  HardDrive,
  Loader2,
  RefreshCw,
  Server,
} from "lucide-react";
import {
  connectSyncServer,
  disableSync,
  fetchSyncDiagnostics,
  fetchSyncSettings,
  SyncV2DisabledError,
  type SyncDiagnostics,
  type SyncSettingsResponse,
} from "@/lib/syncLocalApi";
import { ConflictCenter } from "@/components/settings/ConflictCenter";

/**
 * 同步设置（Phase 7）。
 *
 * 产品层只呈现两个选项：
 *   ● 不同步，仅此设备
 *   ○ 我的 Nowen Server
 *
 * 刻意**不**暴露 Full / Lite / SQLite / Server Mode。这些是实现细节，
 * 让用户理解它们除了增加困惑没有任何好处——底层数据模式永远是 Local，
 * 同步只是一项可选能力。
 */
export function SyncSettingsPanel() {
  const [settings, setSettings] = useState<SyncSettingsResponse | null>(null);
  const [diagnostics, setDiagnostics] = useState<SyncDiagnostics | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [serverUrl, setServerUrl] = useState("");

  const reload = useCallback(async () => {
    try {
      const next = await fetchSyncSettings();
      setSettings(next);
      setUnavailable(false);
      if (next.mode === "server") {
        setDiagnostics(await fetchSyncDiagnostics());
      } else {
        setDiagnostics(null);
      }
    } catch (err) {
      if (err instanceof SyncV2DisabledError) {
        // 未启用是默认状态，不当作错误展示。
        setUnavailable(true);
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const handleConnect = async () => {
    const trimmed = serverUrl.trim();
    if (!/^https?:\/\//i.test(trimmed)) {
      setError("服务器地址需要以 http:// 或 https:// 开头");
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await connectSyncServer({ serverUrl: trimmed });
      setNotice("已连接。本设备的笔记会在后台同步，期间可以正常使用。");
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleDisable = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await disableSync();
      // 明确告知数据仍在，这是用户此刻最关心的事。
      setNotice(result.message);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        正在读取同步设置…
      </div>
    );
  }

  if (unavailable) {
    return (
      <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
        当前版本尚未开启多设备同步。你的笔记完整保存在此设备中，可正常使用全部功能。
      </div>
    );
  }

  const mode = settings?.mode ?? "device-only";

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <h3 className="text-sm font-medium">同步</h3>

        <label className="flex cursor-pointer items-start gap-3 rounded-md border p-3">
          <input
            type="radio"
            name="nowen-sync-mode"
            className="mt-1"
            checked={mode === "device-only"}
            onChange={() => { void handleDisable(); }}
            disabled={busy}
          />
          <span className="flex-1">
            <span className="flex items-center gap-2 text-sm font-medium">
              <HardDrive className="h-4 w-4" />
              不同步，仅此设备
            </span>
            <span className="mt-1 block text-xs text-muted-foreground">
              数据完整保存在这台设备上。没有服务器、没有网络也能创建、编辑、搜索和导入导出。
            </span>
          </span>
        </label>

        <label className="flex cursor-pointer items-start gap-3 rounded-md border p-3">
          <input
            type="radio"
            name="nowen-sync-mode"
            className="mt-1"
            checked={mode === "server"}
            onChange={() => { /* 由下方按钮确认，避免误触即连接 */ }}
            disabled={busy}
          />
          <span className="flex-1">
            <span className="flex items-center gap-2 text-sm font-medium">
              <Server className="h-4 w-4" />
              我的 Nowen Server
            </span>
            <span className="mt-1 block text-xs text-muted-foreground">
              依然优先保存到本机，随后在后台同步到你的服务器。断网时可继续编辑，恢复后自动补传。
            </span>

            {mode === "server" && settings?.activeProfile ? (
              <span className="mt-2 flex items-center gap-2 text-xs">
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
                已连接 {settings.activeProfile.serverUrl}
              </span>
            ) : (
              <span className="mt-2 flex flex-col gap-2 sm:flex-row">
                <input
                  type="url"
                  value={serverUrl}
                  onChange={(event) => setServerUrl(event.target.value)}
                  placeholder="http://192.168.1.10:3000"
                  className="flex-1 rounded border px-2 py-1 text-xs"
                  disabled={busy}
                />
                <button
                  type="button"
                  onClick={() => { void handleConnect(); }}
                  disabled={busy}
                  className="rounded bg-primary px-3 py-1 text-xs text-primary-foreground disabled:opacity-50"
                >
                  连接
                </button>
              </span>
            )}
          </span>
        </label>

        {notice ? (
          <p className="flex items-start gap-2 text-xs text-emerald-700">
            <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {notice}
          </p>
        ) : null}
        {error ? (
          <p className="flex items-start gap-2 text-xs text-destructive">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {error}
          </p>
        ) : null}
      </section>

      {mode === "server" && diagnostics ? (
        <>
          <ConflictCenter
            deviceId={diagnostics.deviceId}
            onResolved={() => { void reload(); }}
          />
          <SyncDiagnosticsPanel diagnostics={diagnostics} onRefresh={reload} />
        </>
      ) : null}
    </div>
  );
}

/**
 * 同步诊断。
 *
 * 真实用户反馈同步问题时，这一页是唯一能定位的依据。
 * 只展示标识符与计数，不含任何笔记正文或凭据。
 */
function SyncDiagnosticsPanel({
  diagnostics,
  onRefresh,
}: {
  diagnostics: SyncDiagnostics;
  onRefresh: () => Promise<void> | void;
}) {
  const rows: Array<[string, string]> = [
    ["设备 ID", diagnostics.deviceId || "—"],
    ["同步服务器", diagnostics.serverUrl || "—"],
    ["本地游标", String(diagnostics.localCursor)],
    ["待同步条目", String(diagnostics.pendingMutations)],
    ["未解决冲突", String(diagnostics.conflictCount)],
    ["最近同步", diagnostics.lastSyncAt || "—"],
    ["最近通信", diagnostics.lastSeenAt || "—"],
    ["最近错误", diagnostics.lastError || "无"],
  ];

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-medium">
          <Cloud className="h-4 w-4" />
          同步诊断
        </h3>
        <button
          type="button"
          onClick={() => { void onRefresh(); }}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          刷新
        </button>
      </div>

      <dl className="grid grid-cols-1 gap-x-4 gap-y-1 rounded-md border p-3 text-xs sm:grid-cols-2">
        {rows.map(([label, value]) => (
          <div key={label} className="flex justify-between gap-2">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="truncate font-mono" title={value}>{value}</dd>
          </div>
        ))}
      </dl>

      {diagnostics.pendingSample.length > 0 ? (
        <details className="rounded-md border p-3 text-xs">
          <summary className="cursor-pointer text-muted-foreground">
            待同步明细（{diagnostics.pendingSample.length}）
          </summary>
          <ul className="mt-2 space-y-1">
            {diagnostics.pendingSample.map((item) => (
              <li key={`${item.entityType}-${item.entityId}`} className="font-mono">
                {item.entityType} · {item.operation} · 重试 {item.retryCount}
                {item.lastError ? ` · ${item.lastError}` : ""}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-muted-foreground">
            这些修改已保存在本机，等待上传。即使长时间未同步也不会丢失。
          </p>
        </details>
      ) : null}
    </section>
  );
}
