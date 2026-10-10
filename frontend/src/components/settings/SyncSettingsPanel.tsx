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
  loginSyncServer,
  startSyncBootstrap,
  SyncV2DisabledError,
  type SyncDiagnostics,
  type SyncSettingsResponse,
} from "@/lib/syncLocalApi";

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
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [twoFactorTicket, setTwoFactorTicket] = useState("");
  const [twoFactorCode, setTwoFactorCode] = useState("");

  const reload = useCallback(async () => {
    try {
      const next = await fetchSyncSettings();
      setSettings(next);
      if (next.activeProfile?.serverUrl) {
        setServerUrl((current) => current || next.activeProfile!.serverUrl);
      }
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
    if (!twoFactorTicket && (!username.trim() || !password)) {
      setError("请输入同步服务器的账号和密码");
      return;
    }
    if (twoFactorTicket && !twoFactorCode.trim()) {
      setError("请输入双重验证代码");
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await loginSyncServer(twoFactorTicket
        ? { serverUrl: trimmed, ticket: twoFactorTicket, code: twoFactorCode.trim() }
        : { serverUrl: trimmed, username: username.trim(), password });
      if (result.requiresTwoFactor) {
        setTwoFactorTicket(result.ticket);
        setTwoFactorCode("");
        setNotice(`账号 ${result.username} 需要双重验证。`);
        return;
      }
      setPassword("");
      setTwoFactorTicket("");
      setTwoFactorCode("");
      if (result.bootstrapRequired) {
        const progress = await startSyncBootstrap();
        setNotice(progress.engineRunning
          ? "登录授权成功，首次同步已完成并开始后台同步。"
          : "登录授权成功，首次同步已完成。数据仍优先保存在本机。");
      } else {
        setNotice(result.message);
      }
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      await reload();
    } finally {
      setBusy(false);
    }
  };

  const handleBootstrap = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const progress = await startSyncBootstrap();
      setNotice(progress.engineRunning
        ? "首次同步已完成，同步引擎正在运行。"
        : "首次同步已完成。数据仍优先保存在本机。");
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      await reload();
    } finally {
      setBusy(false);
    }
  };

  const handleResume = async () => {
    const target = serverUrl.trim() || settings?.profiles[0]?.serverUrl || "";
    if (!target) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await connectSyncServer({ serverUrl: target });
      setNotice(result.message);
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
  const activeProfile = settings?.activeProfile;
  const authorizationExpired = settings?.authorizationState === "expired";
  const showLogin = !settings?.authorized;
  const canResume = mode === "device-only" && settings?.authorized;

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

            {settings?.authorized && activeProfile ? (
              <span className="mt-2 flex flex-col gap-2 text-xs">
                <span className="flex items-center gap-2">
                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
                  {settings.engineRunning ? "已授权并正在同步" : "已授权，等待首次同步完成"} {activeProfile.serverUrl}
                </span>
                {!settings.engineRunning ? (
                  <button
                    type="button"
                    onClick={() => { void handleBootstrap(); }}
                    disabled={busy}
                    className="w-fit rounded bg-primary px-3 py-1 text-xs text-primary-foreground disabled:opacity-50"
                  >
                    继续首次同步
                  </button>
                ) : null}
              </span>
            ) : null}

            {canResume ? (
              <span className="mt-2 flex flex-col gap-2 text-xs">
                <span>账号授权仍有效，可恢复与 {settings.profiles[0]?.serverUrl || serverUrl} 的同步。</span>
                <button
                  type="button"
                  onClick={() => { void handleResume(); }}
                  disabled={busy}
                  className="w-fit rounded bg-primary px-3 py-1 text-xs text-primary-foreground disabled:opacity-50"
                >
                  恢复同步
                </button>
              </span>
            ) : null}

            {showLogin ? (
              <span className="mt-2 flex flex-col gap-2">
                {authorizationExpired ? (
                  <span className="text-xs text-destructive">同步授权已失效，请重新登录。未同步修改仍保留在本机。</span>
                ) : null}
                <input
                  type="url"
                  value={serverUrl}
                  onChange={(event) => setServerUrl(event.target.value)}
                  placeholder="http://192.168.1.10:3000"
                  className="flex-1 rounded border px-2 py-1 text-xs"
                  disabled={busy}
                />
                {twoFactorTicket ? (
                  <input
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    value={twoFactorCode}
                    onChange={(event) => setTwoFactorCode(event.target.value)}
                    placeholder="双重验证代码或恢复码"
                    className="rounded border px-2 py-1 text-xs"
                    disabled={busy}
                  />
                ) : (
                  <>
                    <input
                      type="text"
                      autoComplete="username"
                      value={username}
                      onChange={(event) => setUsername(event.target.value)}
                      placeholder="账号"
                      className="rounded border px-2 py-1 text-xs"
                      disabled={busy}
                    />
                    <input
                      type="password"
                      autoComplete="current-password"
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      placeholder="密码"
                      className="rounded border px-2 py-1 text-xs"
                      disabled={busy}
                    />
                  </>
                )}
                <span className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => { void handleConnect(); }}
                    disabled={busy}
                    className="rounded bg-primary px-3 py-1 text-xs text-primary-foreground disabled:opacity-50"
                  >
                    {twoFactorTicket ? "验证并开始同步" : "登录并开始同步"}
                  </button>
                  {twoFactorTicket ? (
                    <button
                      type="button"
                      onClick={() => { setTwoFactorTicket(""); setTwoFactorCode(""); }}
                      disabled={busy}
                      className="rounded border px-3 py-1 text-xs disabled:opacity-50"
                    >
                      返回账号密码
                    </button>
                  ) : null}
                </span>
              </span>
            ) : null}
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
        <SyncDiagnosticsPanel diagnostics={diagnostics} onRefresh={reload} />
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
