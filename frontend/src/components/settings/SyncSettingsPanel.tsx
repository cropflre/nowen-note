import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  Cloud,
  CloudOff,
  Copy,
  HardDrive,
  Info,
  Loader2,
  RefreshCw,
  Server,
} from "lucide-react";
import { OfflineAvailability } from "./OfflineAvailability";
import { formatAppDateTime } from "@/lib/dateTime";
import { SYNC_SNAPSHOT_APPLIED_EVENT } from "@/lib/syncEngine";
import {
  connectSyncServer,
  disableSync,
  fetchSyncDiagnostics,
  fetchSyncSettings,
  loginSyncServer,
  startSyncBootstrap,
  SyncV2DisabledError,
  triggerSyncNow,
  type SyncDiagnostics,
  type SyncSettingsResponse,
} from "@/lib/syncLocalApi";

function notifyWorkspaceSyncRefresh(): void {
  try {
    window.dispatchEvent(new Event(SYNC_SNAPSHOT_APPLIED_EVENT));
    window.dispatchEvent(new CustomEvent("nowen:knowledge-tree-changed", { detail: { reason: "sync-v2" } }));
  } catch { /* ignore in non-browser tests */ }
}

/**
 * 同步是可选能力：展示一目了然的当前状态，提供一键同步/连接/关闭，
 * 将设备 ID、游标等工程师字段默认收入「高级诊断」折叠区。
 */
export function SyncSettingsPanel() {
  const { i18n } = useTranslation();
  const [settings, setSettings] = useState<SyncSettingsResponse | null>(null);
  const [diagnostics, setDiagnostics] = useState<SyncDiagnostics | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState<"login" | "bootstrap" | "resume" | "disable" | "sync" | null>(null);
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
  const [copiedDiagnostic, setCopiedDiagnostic] = useState(false);

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
      setDiagnosticsError(null);
      setDiagnostics((current) => current?.profileId === (next.activeProfile?.id ?? null) ? current : null);
      if (next.profiles.length > 0) {
        try {
          setDiagnostics(await fetchSyncDiagnostics());
        } catch (err) {
          setDiagnosticsError(err instanceof Error ? err.message : String(err));
        }
      }
    } catch (err) {
      if (err instanceof SyncV2DisabledError) {
        setUnavailable(true);
      } else {
        setSettingsError(err instanceof Error ? err.message : String(err));
        setDiagnostics(null);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  const activeAttachmentTransfer = Boolean(
    diagnostics?.offline
    && ((diagnostics.offline.attachments.pendingDownloads ?? 0) > 0 || diagnostics.offline.verificationPending),
  );
  const pollMs = activeAttachmentTransfer ? 2500 : 5000;

  useEffect(() => {
    void reload();
    const timer = window.setInterval(() => { void reload(); }, pollMs);
    return () => window.clearInterval(timer);
  }, [reload, pollMs]);

  const bootstrap = async () => {
    setAction("bootstrap");
    const progress = await startSyncBootstrap();
    if (progress.status === "failed") {
      throw new Error(progress.error || "首次同步初始化失败，请重试。");
    }
    notifyWorkspaceSyncRefresh();
    setNotice(progress.status === "ready" && progress.engineRunning
      ? "同步初始化已完成，笔记已同步到本机，后续修改将在后台自动同步。"
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
        notifyWorkspaceSyncRefresh();
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
      notifyWorkspaceSyncRefresh();
      setNotice(result.message);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      await reload();
    } finally {
      setAction(null);
    }
  };

  const handleSyncNow = async () => {
    if (busy) return;
    setAction("sync");
    setError(null);
    setNotice(null);
    try {
      const result = await triggerSyncNow();
      notifyWorkspaceSyncRefresh();
      if (!result.engineRunning && result.message) {
        setNotice(result.message);
      } else {
        setNotice("已触发一轮同步检查。");
      }
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
      setNotice(result.message);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      await reload();
    } finally {
      setAction(null);
    }
  };

  const handleCopyDiagnostic = async () => {
    if (!diagnostics) return;
    const payload = JSON.stringify({
      deviceId: diagnostics.deviceId,
      localCursor: diagnostics.localCursor,
      pendingMutations: diagnostics.pendingMutations,
      conflictCount: diagnostics.conflictCount,
      lastSyncAt: diagnostics.lastSyncAt,
      lastSeenAt: diagnostics.lastSeenAt,
      lastError: diagnostics.lastError,
      diagnostic: diagnostics.lastErrorDiagnostic ?? null,
    }, null, 2);
    try {
      await navigator.clipboard.writeText(payload);
      setCopiedDiagnostic(true);
      window.setTimeout(() => setCopiedDiagnostic(false), 2000);
    } catch { /* ignore clipboard failure */ }
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
      <div className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">
        当前版本尚未开启多设备同步。你的笔记完整保存在此设备中，可正常使用全部功能。
      </div>
    );
  }

  if (settingsError || !settings) {
    return (
      <div className="space-y-3 rounded-xl border p-4 text-sm" role="alert">
        <p className="flex items-center gap-2 font-medium">
          <AlertTriangle className="h-4 w-4 text-destructive" />
          暂时无法读取同步设置
        </p>
        <p className="break-words text-xs text-muted-foreground">{settingsError}</p>
        <button type="button" onClick={() => { setLoading(true); void reload(); }} className="rounded-lg border px-3 py-1.5 text-xs hover:bg-muted">
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
      : action === "resume" ? "正在恢复同步…"
        : action === "sync" ? "正在同步…" : "正在关闭同步…";

  const hasSyncError = Boolean(mode === "server" && diagnostics?.lastError);
  const formattedLastSync = diagnostics?.lastSyncAt
    ? formatAppDateTime(diagnostics.lastSyncAt, undefined, undefined, i18n.language)
    : "尚未同步";
  const diagnosticDetail = diagnostics?.lastErrorDiagnostic;
  const diagnosticSummary = diagnosticDetail
    ? Object.entries(diagnosticDetail)
      .filter(([, value]) => typeof value === "string" && value.length > 0)
      .map(([key, value]) => `${key}=${value}`)
      .join(" · ")
    : "";

  const statusToneClass = authorizationExpired || hasSyncError
    ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
    : mode === "server" && settings.engineRunning
      ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
      : "bg-muted text-muted-foreground";

  return (
    <div className="space-y-4">
      <section className="space-y-4" aria-label="多设备同步" aria-busy={busy}>
        {/* 主状态卡：状态 + 一键操作 + 3 项通俗概览 */}
        <div className="space-y-4 rounded-xl border border-app-border bg-app-surface p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted/80">
                {authorizationExpired || hasSyncError ? (
                  <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                ) : mode === "server" && settings.engineRunning ? (
                  activeAttachmentTransfer ? (
                    <Loader2 className="h-4 w-4 animate-spin text-accent-primary" />
                  ) : (
                    <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                  )
                ) : mode === "server" ? (
                  <Cloud className="h-4 w-4 text-accent-primary" />
                ) : canResume ? (
                  <CloudOff className="h-4 w-4 text-muted-foreground" />
                ) : (
                  <HardDrive className="h-4 w-4 text-muted-foreground" />
                )}
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-semibold">多设备同步</h3>
                  <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${statusToneClass}`} role="status">
                    {status}
                  </span>
                </div>
                {activeProfile ? (
                  <p className="mt-0.5 break-all text-xs text-muted-foreground">{activeProfile.serverUrl}</p>
                ) : null}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {mode === "server" && settings.engineRunning ? (
                <button
                  type="button"
                  onClick={() => { void handleSyncNow(); }}
                  disabled={busy}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
                >
                  {action === "sync" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                  {action === "sync" ? progressLabel : "立即同步"}
                </button>
              ) : null}
              {mode === "server" ? (
                <button
                  type="button"
                  onClick={() => { void handleDisable(); }}
                  disabled={busy}
                  className="rounded-lg border px-3 py-1.5 text-xs hover:bg-muted disabled:opacity-50"
                >
                  {action === "disable" ? progressLabel : "关闭同步"}
                </button>
              ) : null}
            </div>
          </div>

          <p className="text-xs leading-relaxed text-muted-foreground">
            {authorizationExpired ? "同步授权已失效，请重新登录。未同步修改仍保留在本机。"
              : mode === "device-only" ? "笔记保存在此设备上，没有服务器或网络也能继续使用。开启同步后，可在其他设备访问笔记。"
                : showLogin ? "服务器已配置，登录后才能开启同步。未同步修改仍保留在本机。"
                  : settings.engineRunning ? "已连接并自动在后台同步。所有修改先保存在本机，断网也能正常写，联网后自动汇总。"
                    : "账号已登录，请点击下方按钮完成首次同步。未同步修改仍保留在本机。"}
          </p>

          {settings.authorized && mode === "server" && !settings.engineRunning ? (
            <button
              type="button"
              onClick={() => { void handleBootstrap(); }}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3.5 py-2 text-xs font-medium text-primary-foreground disabled:opacity-50"
            >
              {action === "bootstrap" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              {action === "bootstrap" ? progressLabel : "继续首次同步"}
            </button>
          ) : null}

          {canResume ? (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-muted/50 px-3 py-2.5 text-xs">
              <span className="break-all text-muted-foreground">
                上次连接：{settings.profiles[0]?.serverUrl || serverUrl}
              </span>
              <button
                type="button"
                onClick={() => { void handleResume(); }}
                disabled={busy}
                className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
              >
                {action === "resume" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                {action === "resume" ? progressLabel : "恢复同步"}
              </button>
            </div>
          ) : null}

          {/* 简明三格概览（人话、本地时区） */}
          {mode === "server" && diagnostics ? (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <div className="rounded-lg bg-muted/40 px-3 py-2">
                <p className="text-[11px] text-muted-foreground">上次同步</p>
                <p className="mt-0.5 text-xs font-medium">{formattedLastSync}</p>
              </div>
              <div className="rounded-lg bg-muted/40 px-3 py-2">
                <p className="text-[11px] text-muted-foreground">待上传修改</p>
                <p className="mt-0.5 text-xs font-medium">
                  {diagnostics.pendingMutations > 0 ? `${diagnostics.pendingMutations} 条等待上传` : "已全部上传"}
                </p>
              </div>
              <div className="rounded-lg bg-muted/40 px-3 py-2">
                <p className="text-[11px] text-muted-foreground">冲突检查</p>
                <p className={`mt-0.5 text-xs font-medium ${diagnostics.conflictCount > 0 ? "text-amber-600 dark:text-amber-400" : ""}`}>
                  {diagnostics.conflictCount > 0 ? `${diagnostics.conflictCount} 项待处理` : "无冲突"}
                </p>
              </div>
            </div>
          ) : null}

          {mode === "server" && !diagnostics ? (
            <button type="button" onClick={() => { void reload(); }} disabled={busy} className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-50">
              刷新状态
            </button>
          ) : null}

          {/* 出错时直接醒目展示人话原因 + 复制诊断，无需展开折叠区 */}
          {hasSyncError && diagnostics?.lastError ? (
            <div role="alert" className="space-y-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs">
              <div className="flex items-start justify-between gap-2">
                <p className="flex items-start gap-2 text-destructive">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>{SYNC_ERROR_LABELS[diagnostics.lastError] || `同步遇到错误（${diagnostics.lastError}）`}</span>
                </p>
                <button
                  type="button"
                  onClick={() => { void handleCopyDiagnostic(); }}
                  className="inline-flex shrink-0 items-center gap-1 rounded border px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  {copiedDiagnostic ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                  {copiedDiagnostic ? "已复制" : "复制诊断"}
                </button>
              </div>
              {diagnosticSummary ? (
                <p className="break-all font-mono text-[11px] text-muted-foreground">
                  脱敏明细：{diagnosticSummary}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>

        {/* 一步登录表单（仅未授权时显示） */}
        {showLogin ? (
          <form className="space-y-3 rounded-xl border border-app-border bg-app-surface p-4" onSubmit={(event) => { event.preventDefault(); void handleConnect(); }}>
            <div className="space-y-1">
              <h4 className="flex items-center gap-2 text-sm font-medium">
                <Server className="h-4 w-4" />
                连接我的 Nowen Server
              </h4>
              <p className="text-xs leading-relaxed text-muted-foreground">
                输入服务器地址和账号，一步完成登录并开启自动同步。连接后，本机已有笔记也将同步到该账号。
              </p>
            </div>
            <label className="block space-y-1.5 text-xs">
              <span>服务器地址</span>
              <input
                type="url"
                value={serverUrl}
                onChange={(event) => setServerUrl(event.target.value)}
                placeholder="http://192.168.1.10:3000"
                className="w-full rounded-lg border bg-transparent px-3 py-2 text-sm"
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
                  className="w-full rounded-lg border bg-transparent px-3 py-2 text-sm"
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
                    className="w-full rounded-lg border bg-transparent px-3 py-2 text-sm"
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
                    className="w-full rounded-lg border bg-transparent px-3 py-2 text-sm"
                    disabled={busy}
                    required
                  />
                </label>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <button type="submit" disabled={busy} className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-xs font-medium text-primary-foreground disabled:opacity-50">
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                {busy ? progressLabel : twoFactorTicket ? "验证并开启同步" : "登录并开启同步"}
              </button>
              {twoFactorTicket ? (
                <button
                  type="button"
                  onClick={() => { setTwoFactorTicket(""); setTwoFactorCode(""); setNotice(null); setError(null); }}
                  disabled={busy}
                  className="rounded-lg border px-3 py-2 text-xs disabled:opacity-50"
                >
                  返回账号密码
                </button>
              ) : null}
            </div>
          </form>
        ) : null}

        {/* 离线附件进度卡：仅已开启同步或有离线副本数据时展示 */}
        {(mode === "server" || diagnostics?.offline?.supported) ? (
          <OfflineAvailability offline={diagnostics?.offline} />
        ) : null}

        {notice ? (
          <p role="status" className="flex items-start gap-2 rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {notice}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="flex items-start gap-2 break-words rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {error}
          </p>
        ) : null}
        {diagnosticsError ? (
          <p role="alert" className="break-words text-xs text-destructive">诊断信息暂时不可用：{diagnosticsError}</p>
        ) : null}
      </section>

      {mode === "server" && diagnostics ? (
        <SyncDiagnosticsPanel
          diagnostics={diagnostics}
          locale={i18n.language}
          onRefresh={reload}
          onCopy={handleCopyDiagnostic}
          copied={copiedDiagnostic}
          disabled={busy}
        />
      ) : null}
    </div>
  );
}

/**
 * 同步诊断（默认折叠，供排查问题时展开查看与一键复制）。
 * 只展示标识符与计数，不含任何笔记正文或凭据。
 */
const SYNC_ERROR_LABELS: Record<string, string> = {
  DATA_STRUCTURE: "目录或引用结构与本机约束不一致（已停止自动重试，本机与服务器数据均未改动）",
  AUTH_EXPIRED: "登录授权已失效，请重新登录同步服务器",
  NETWORK_UNAVAILABLE: "暂时无法连接同步服务器，联网后会自动重试",
  INVALID_PAYLOAD: "同步数据格式不兼容，建议将客户端与服务端升级至一致版本",
  ACCESS_REVOKED: "工作区访问权限已变更或撤销，本机副本已保留",
  SCOPE_FORBIDDEN: "当前账号缺少目标工作区的同步权限",
  SERVER_ERROR: "同步服务器暂时异常，稍后会自动重试",
};

function SyncDiagnosticsPanel({
  diagnostics,
  locale,
  onRefresh,
  onCopy,
  copied,
  disabled,
}: {
  diagnostics: SyncDiagnostics;
  locale: string;
  onRefresh: () => Promise<void> | void;
  onCopy: () => Promise<void> | void;
  copied: boolean;
  disabled: boolean;
}) {
  const rows: Array<[string, string]> = [
    ["设备 ID", diagnostics.deviceId || "—"],
    ["同步服务器", diagnostics.serverUrl || "—"],
    ["本地游标", String(diagnostics.localCursor)],
    ["待同步条目", String(diagnostics.pendingMutations)],
    ["未解决冲突", String(diagnostics.conflictCount)],
    ["最近同步", diagnostics.lastSyncAt ? formatAppDateTime(diagnostics.lastSyncAt, undefined, undefined, locale) : "—"],
    ["最近通信", diagnostics.lastSeenAt ? formatAppDateTime(diagnostics.lastSeenAt, undefined, undefined, locale) : "—"],
    ["最近错误", diagnostics.lastError || "无"],
  ];

  return (
    <details className="group rounded-xl border border-app-border bg-app-surface/40 text-xs">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-4 py-3 text-muted-foreground hover:text-foreground">
        <span className="flex items-center gap-1.5 font-medium">
          <ChevronDown className="h-3.5 w-3.5 transition-transform group-open:rotate-180" aria-hidden="true" />
          高级诊断信息
        </span>
        <span className="text-[11px]">排查同步问题时展开</span>
      </summary>

      <div className="space-y-3 border-t border-app-border px-4 py-3">
        <div className="flex flex-wrap items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => { void onCopy(); }}
            disabled={disabled}
            className="inline-flex items-center gap-1 rounded border px-2.5 py-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
          >
            {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
            {copied ? "已复制" : "复制诊断"}
          </button>
          <button
            type="button"
            onClick={() => { void onRefresh(); }}
            disabled={disabled}
            className="inline-flex items-center gap-1 rounded border px-2.5 py-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
          >
            <RefreshCw className="h-3 w-3" />
            刷新
          </button>
        </div>

        <dl className="grid grid-cols-1 gap-x-4 gap-y-1.5 sm:grid-cols-2">
          {rows.map(([label, value]) => (
            <div key={label} className="flex justify-between gap-2">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="truncate font-mono" title={value}>{value}</dd>
            </div>
          ))}
        </dl>

        {diagnostics.pendingSample.length > 0 ? (
          <details className="rounded-lg border p-2.5 text-xs">
            <summary className="cursor-pointer text-muted-foreground">
              {diagnostics.pendingMutations > diagnostics.pendingSample.length
                ? `待同步明细（展示前 ${diagnostics.pendingSample.length} / 共 ${diagnostics.pendingMutations} 条）`
                : `待同步明细（${diagnostics.pendingSample.length}）`}
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
      </div>
    </details>
  );
}
