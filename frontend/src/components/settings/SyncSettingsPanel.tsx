import { useCallback, useEffect, useState } from "react";
import { OfflineAvailability } from "./OfflineAvailability";
import {
  AlertTriangle,
  Cloud,
  HardDrive,
  Info,
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
 * 同步是可选能力：展示已确认的当前状态，通过明确的按钮连接或关闭。
 * 本机始终优先保存数据；开启后台同步不代表全部数据已同步完成。
 */
export function SyncSettingsPanel() {
  const [settings, setSettings] = useState<SyncSettingsResponse | null>(null);
  const [diagnostics, setDiagnostics] = useState<SyncDiagnostics | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState<"login" | "bootstrap" | "resume" | "disable" | null>(null);
  const busy = action !== null;
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [diagnosticsError, setDiagnosticsError] = useState<string | null>(null);
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
      setSettingsError(null);
      const savedUrl = next.activeProfile?.serverUrl || next.profiles[0]?.serverUrl;
      if (savedUrl) {
        setServerUrl((current) => current || savedUrl);
      }
      setUnavailable(false);
      setDiagnostics(null);
      setDiagnosticsError(null);
      if (next.profiles.length > 0) {
        try {
          setDiagnostics(await fetchSyncDiagnostics());
        } catch (err) {
          setDiagnosticsError(err instanceof Error ? err.message : String(err));
        }
      }
    } catch (err) {
      if (err instanceof SyncV2DisabledError) {
        // 未启用是默认状态，不当作错误展示。
        setUnavailable(true);
      } else {
        setSettingsError(err instanceof Error ? err.message : String(err));
        setDiagnostics(null);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
    const timer = window.setInterval(() => { void reload(); }, 5000);
    return () => window.clearInterval(timer);
  }, [reload]);

  const bootstrap = async () => {
    setAction("bootstrap");
    const progress = await startSyncBootstrap();
    if (progress.status === "failed") {
      throw new Error(progress.error || "首次同步初始化失败，请重试。");
    }
    setNotice(progress.status === "ready" && progress.engineRunning
      ? "同步初始化已完成，后续修改将在后台同步。"
      : "后台同步尚未启动，请继续首次同步。未同步修改仍保留在本机。");
  };

  const handleConnect = async () => {
    if (busy) return;
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
    setAction("login");
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
        await bootstrap();
      } else {
        setNotice("登录成功。笔记仍优先保存在本机。");
      }
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      await reload();
    } finally {
      setAction(null);
    }
  };

  const handleBootstrap = async () => {
    if (busy) return;
    setAction("bootstrap");
    setError(null);
    setNotice(null);
    try {
      await bootstrap();
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      await reload();
    } finally {
      setAction(null);
    }
  };

  const handleResume = async () => {
    if (busy) return;
    const target = serverUrl.trim() || settings?.profiles[0]?.serverUrl || "";
    if (!target) return;
    setAction("resume");
    setError(null);
    setNotice(null);
    try {
      const result = await connectSyncServer({ serverUrl: target });
      setNotice(result.message);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      await reload();
    } finally {
      setAction(null);
    }
  };

  const handleDisable = async () => {
    if (busy) return;
    setAction("disable");
    setError(null);
    setNotice(null);
    try {
      const result = await disableSync();
      // 明确告知数据仍在，这是用户此刻最关心的事。
      setNotice(result.message);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      await reload();
    } finally {
      setAction(null);
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

  if (settingsError || !settings) {
    return (
      <div className="space-y-3 rounded-md border p-4 text-sm" role="alert">
        <p className="flex items-center gap-2 font-medium">
          <AlertTriangle className="h-4 w-4 text-destructive" />
          暂时无法读取同步设置
        </p>
        <p className="break-words text-xs text-muted-foreground">{settingsError}</p>
        <button type="button" onClick={() => { setLoading(true); void reload(); }} className="rounded border px-3 py-1.5 text-xs hover:bg-muted">
          重试
        </button>
      </div>
    );
  }

  const mode = settings.mode;
  const activeProfile = settings.activeProfile;
  const authorizationExpired = settings.authorizationState === "expired";
  const showLogin = !settings.authorized;
  const canResume = mode === "device-only" && settings.authorized;
  const status = authorizationExpired ? "需要重新登录"
    : canResume ? "已暂停"
      : mode === "device-only" ? "未开启"
        : showLogin ? "等待登录"
          : settings.engineRunning ? "已开启" : "待完成首次同步";
  const progressLabel = action === "login" ? "正在登录…"
    : action === "bootstrap" ? "正在初始化同步…"
      : action === "resume" ? "正在恢复同步…" : "正在关闭同步…";

  return (
    <div className="space-y-6">
      <section className="space-y-4" aria-label="多设备同步" aria-busy={busy}>
        <h3 className="text-sm font-medium">多设备同步</h3>
        <div className="space-y-3 rounded-md border p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm font-medium">
              {mode === "server" ? <Cloud className="h-4 w-4" /> : <HardDrive className="h-4 w-4" />}
              当前状态
              <span className="rounded bg-muted px-2 py-0.5 text-xs" role="status">{status}</span>
            </div>
            {mode === "server" ? (
              <button type="button" onClick={() => { void handleDisable(); }} disabled={busy} className="rounded border px-3 py-1.5 text-xs hover:bg-muted disabled:opacity-50">
                {action === "disable" ? progressLabel : "关闭同步"}
              </button>
            ) : null}
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {authorizationExpired ? "同步授权已失效，请重新登录。未同步修改仍保留在本机。"
              : mode === "device-only" ? "笔记保存在此设备上，没有服务器或网络也能继续使用。开启同步后，可在其他设备访问笔记。"
                : showLogin ? "服务器已配置，登录后才能开启同步。未同步修改仍保留在本机。"
                  : settings.engineRunning ? "后台同步已开启。笔记优先保存到本机，断网时可继续编辑，联网后自动重试。"
                    : "账号已登录，请继续完成首次同步。未同步修改仍保留在本机。"}
          </p>
          {activeProfile ? <p className="break-all text-xs text-muted-foreground">服务器：{activeProfile.serverUrl}</p> : null}
          {mode === "server" ? <p className="text-xs text-muted-foreground">关闭同步不会删除本机笔记和待同步修改，再次开启需要登录。</p> : null}
          {settings.authorized && mode === "server" && !settings.engineRunning ? (
            <button type="button" onClick={() => { void handleBootstrap(); }} disabled={busy} className="rounded bg-primary px-3 py-1.5 text-xs text-primary-foreground disabled:opacity-50">
              {action === "bootstrap" ? progressLabel : "继续首次同步"}
            </button>
          ) : null}
          {canResume ? (
            <div className="space-y-2 text-xs">
              <p className="break-all text-muted-foreground">恢复与 {settings.profiles[0]?.serverUrl || serverUrl} 的同步。</p>
              <button type="button" onClick={() => { void handleResume(); }} disabled={busy} className="rounded bg-primary px-3 py-1.5 text-primary-foreground disabled:opacity-50">
                {action === "resume" ? progressLabel : "恢复同步"}
              </button>
            </div>
          ) : null}
          {mode === "server" && !diagnostics ? (
            <button type="button" onClick={() => { void reload(); }} disabled={busy} className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-50">刷新状态</button>
          ) : null}
        </div>

        {showLogin ? (
          <form className="space-y-3 rounded-md border p-4" onSubmit={(event) => { event.preventDefault(); void handleConnect(); }}>
            <h4 className="flex items-center gap-2 text-sm font-medium"><Server className="h-4 w-4" />连接我的 Nowen Server</h4>
            <p className="text-xs leading-relaxed text-muted-foreground">填写你部署的服务器地址和账号，登录后开启同步。</p>
            <label className="block space-y-1.5 text-xs">
              <span>服务器地址</span>
              <input
                type="url"
                value={serverUrl}
                onChange={(event) => setServerUrl(event.target.value)}
                placeholder="http://192.168.1.10:3000"
                className="w-full rounded border bg-transparent px-3 py-2 text-sm"
                disabled={busy || !!twoFactorTicket}
                required
              />
            </label>
            {twoFactorTicket ? (
              <label className="block space-y-1.5 text-xs">
                <span>双重验证代码或恢复码</span>
                <input
                  type="text"
                  autoComplete="one-time-code"
                  value={twoFactorCode}
                  onChange={(event) => setTwoFactorCode(event.target.value)}
                  className="w-full rounded border bg-transparent px-3 py-2 text-sm"
                  disabled={busy}
                  required
                />
              </label>
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="block space-y-1.5 text-xs">
                  <span>账号</span>
                  <input
                    type="text"
                    autoComplete="username"
                    value={username}
                    onChange={(event) => setUsername(event.target.value)}
                    className="w-full rounded border bg-transparent px-3 py-2 text-sm"
                    disabled={busy}
                    required
                  />
                </label>
                <label className="block space-y-1.5 text-xs">
                  <span>密码</span>
                  <input
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    className="w-full rounded border bg-transparent px-3 py-2 text-sm"
                    disabled={busy}
                    required
                  />
                </label>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <button type="submit" disabled={busy} className="inline-flex items-center gap-2 rounded bg-primary px-3 py-2 text-xs text-primary-foreground disabled:opacity-50">
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                {busy ? progressLabel : twoFactorTicket ? "验证并开启同步" : "登录并开启同步"}
              </button>
              {twoFactorTicket ? (
                <button
                  type="button"
                  onClick={() => { setTwoFactorTicket(""); setTwoFactorCode(""); setNotice(null); setError(null); }}
                  disabled={busy}
                  className="rounded border px-3 py-2 text-xs disabled:opacity-50"
                >
                  返回账号密码
                </button>
              ) : null}
            </div>
          </form>
        ) : null}

        <p className="text-xs text-muted-foreground">连接后，本机已有笔记也将同步到该账号。请确认服务器与账号正确。</p>
        <OfflineAvailability offline={diagnostics?.offline} />
        {notice ? (
          <p role="status" className="flex items-start gap-2 text-xs text-muted-foreground">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {notice}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="flex items-start gap-2 break-words text-xs text-destructive">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {error}
          </p>
        ) : null}
        {diagnosticsError ? <p role="alert" className="break-words text-xs text-destructive">诊断信息暂时不可用：{diagnosticsError}</p> : null}
      </section>

      {mode === "server" && diagnostics ? (
        <SyncDiagnosticsPanel diagnostics={diagnostics} onRefresh={reload} disabled={busy} />
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
  disabled,
}: {
  diagnostics: SyncDiagnostics;
  onRefresh: () => Promise<void> | void;
  disabled: boolean;
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
          disabled={disabled}
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
