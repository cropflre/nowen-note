import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle,
  CheckCircle2,
  CircleOff,
  Container,
  HardDrive,
  Loader2,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  X,
} from "lucide-react";
import { getBaseUrl } from "@/lib/api.impl";

interface SystemUpdateStatus {
  current: {
    version: string;
    schemaVersion: number | null;
    codeSchemaVersion: number | null;
    image: string | null;
    imageId: string | null;
    digest: string | null;
    health: string | null;
  };
  latest: null | {
    available: true;
    version: string;
    tag: string;
    name: string;
    htmlUrl: string;
    publishedAt: string;
  };
  deployment: { type: string; label: string; onlineUpdateEligible: boolean };
  updater: { configured: boolean; available: boolean; error: string | null; details: any };
  updateAvailable: boolean;
  canPreflight: boolean;
  migrationRisk: {
    level: string;
    message: string;
    rollbackMode: string;
    dataRollbackAutomatic: boolean;
  };
  blockers: Array<{ code: string; message: string }>;
  warnings: Array<{ code: string; message: string }>;
  manualGuidance: { title: string; steps: string[] };
}

interface UpdatePreflight {
  ok: true;
  noOp: boolean;
  preflightId?: string;
  expiresAt?: string;
  currentVersion?: string;
  targetVersion?: string;
  updater: {
    targetImage: string;
    targetImageId: string;
    targetDigest: string | null;
    currentImage: string;
    currentImageId: string;
    currentDigest: string | null;
    architecture: string;
    imageSize: number | null;
    disk: { freeBytes: number | null; minimumRequiredBytes: number };
    warnings: Array<{ code: string; message: string }>;
  };
  backup?: {
    filename: string;
    size: number;
    checksum: string;
    schemaVersion: number | null;
    sameVolume: boolean;
  };
  warnings?: Array<{ code: string; message: string }>;
  migrationRisk?: SystemUpdateStatus["migrationRisk"];
}

interface UpdateJob {
  id: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  phase: string;
  targetVersion: string;
  sourceVersion: string | null;
  cancellable: boolean;
  error: string | null;
  rollbackError: string | null;
  rollbackMode: string;
  rollbackDataSafe: false;
  logs: Array<{ at: string; phase: string; message: string; level: "info" | "warn" | "error" }>;
}

class ApiError extends Error {
  code?: string;
  status?: number;
  payload?: any;
}

function formatBytes(value: number | null | undefined): string {
  if (!value || value < 1) return "未知";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size >= 10 || unit === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`;
}

function shortDigest(value: string | null | undefined): string {
  if (!value) return "—";
  const digest = value.includes("@") ? value.split("@")[1] : value;
  return digest.length > 24 ? `${digest.slice(0, 18)}…${digest.slice(-6)}` : digest;
}

function phaseText(phase: string): string {
  const map: Record<string, string> = {
    queued: "等待执行",
    preparing_replacement: "重新校验镜像",
    entering_maintenance: "准备短暂维护",
    stopping_container: "停止旧容器",
    replacing_container: "创建新容器",
    waiting_health: "等待健康检查",
    verifying_version: "验证服务端版本",
    observing_stability: "稳定性观察",
    completed: "升级完成",
    cancelled: "已取消",
    failed_before_replace: "升级失败（旧容器未受影响）",
    failed_after_replace: "新容器失败",
    rolling_back_image: "正在回滚镜像",
    restoring_previous_container: "恢复旧容器",
    verifying_rollback: "验证回滚结果",
    rolled_back: "已恢复旧镜像",
    rollback_failed: "自动回滚失败",
    interrupted: "任务被中断",
  };
  return map[phase] || phase;
}

async function apiJson<T>(path: string, init?: RequestInit, options?: { interactive?: boolean; sudoToken?: string }): Promise<T> {
  const token = localStorage.getItem("nowen-token");
  const response = await fetch(`${getBaseUrl()}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options?.interactive ? { "X-Requested-With": "Nowen-System-Update" } : {}),
      ...(options?.sudoToken ? { "X-Sudo-Token": options.sudoToken } : {}),
      ...(init?.headers || {}),
    },
  });
  const text = await response.text();
  let payload: any = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { error: text }; }
  if (!response.ok) {
    const error = new ApiError(payload?.error || `HTTP ${response.status}`);
    error.code = payload?.code;
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload as T;
}

function PasswordDialog({
  open,
  busy,
  error,
  onClose,
  onSubmit,
}: {
  open: boolean;
  busy: boolean;
  error: string;
  onClose: () => void;
  onSubmit: (password: string) => void;
}) {
  const [password, setPassword] = useState("");
  useEffect(() => {
    if (open) setPassword("");
  }, [open]);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-[170] flex items-center justify-center bg-black/45 p-4 backdrop-blur-sm">
      <section className="relative w-full max-w-sm rounded-2xl border border-zinc-200 bg-white p-5 shadow-2xl dark:border-zinc-800 dark:bg-zinc-900">
        <button type="button" onClick={onClose} disabled={busy} className="absolute right-3 top-3 rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800" aria-label="关闭">
          <X size={16} />
        </button>
        <div className="flex items-center gap-2 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
          <ShieldCheck size={17} className="text-amber-500" />
          管理员二次验证
        </div>
        <p className="mt-2 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
          在线升级会短暂中断服务。请输入当前管理员密码获取 5 分钟有效的 sudo 授权。
        </p>
        <form
          className="mt-4 space-y-3"
          onSubmit={(event: React.FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            if (password && !busy) onSubmit(password);
          }}
        >
          <input
            autoFocus
            type="password"
            value={password}
            onChange={(event: React.ChangeEvent<HTMLInputElement>) => setPassword(event.target.value)}
            placeholder="当前管理员密码"
            autoComplete="current-password"
            className="w-full rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm outline-none focus:border-accent-primary dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
          />
          {error && <p className="text-xs text-red-500">{error}</p>}
          <button type="submit" disabled={!password || busy} className="flex w-full items-center justify-center gap-2 rounded-xl bg-accent-primary px-3 py-2 text-sm font-medium text-white disabled:opacity-50">
            {busy && <Loader2 size={14} className="animate-spin" />}
            验证并继续
          </button>
        </form>
      </section>
    </div>,
    document.body,
  );
}

export default function DockerUpdateCenter() {
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [status, setStatus] = useState<SystemUpdateStatus | null>(null);
  const [hidden, setHidden] = useState(false);
  const [loading, setLoading] = useState(false);
  const [actionError, setActionError] = useState("");
  const [preflight, setPreflight] = useState<UpdatePreflight | null>(null);
  const [job, setJob] = useState<UpdateJob | null>(null);
  const [confirmVersion, setConfirmVersion] = useState("");
  const [riskAccepted, setRiskAccepted] = useState(false);
  const [connectionLost, setConnectionLost] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [passwordError, setPasswordError] = useState("");
  const pendingSudoAction = useRef<((sudoToken: string) => Promise<void>) | null>(null);

  useEffect(() => {
    let frame = 0;
    const findHost = () => {
      frame = 0;
      const title = Array.from(document.querySelectorAll<HTMLHeadingElement>("h3")).find((node) => node.textContent?.trim() === "版本信息");
      const card = title?.closest<HTMLElement>("div.rounded-xl") || null;
      setHost((current) => current === card ? current : card);
    };
    const schedule = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(findHost);
    };
    schedule();
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      if (frame) cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);

  const loadStatus = useCallback(async () => {
    try {
      const next = await apiJson<SystemUpdateStatus>("/settings/system-update/status");
      setStatus(next);
      setHidden(false);
      const active = next.updater.details?.activeJob as UpdateJob | null | undefined;
      if (active && ["queued", "running"].includes(active.status)) setJob(active);
    } catch (error) {
      if ((error as ApiError).status === 403) {
        setHidden(true);
        return;
      }
      setActionError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  useEffect(() => {
    if (!host) return;
    void loadStatus();
  }, [host, loadStatus]);

  useEffect(() => {
    if (!job || !["queued", "running"].includes(job.status)) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const next = await apiJson<UpdateJob>(`/settings/system-update/jobs/${encodeURIComponent(job.id)}`);
        if (cancelled) return;
        setJob(next);
        setConnectionLost(false);
        if (!["queued", "running"].includes(next.status)) {
          await loadStatus();
          if (next.status === "completed") window.setTimeout(() => window.location.reload(), 4_000);
          return;
        }
      } catch {
        if (!cancelled) setConnectionLost(true);
      }
      if (!cancelled) window.setTimeout(poll, 2_000);
    };
    const timer = window.setTimeout(poll, 800);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [job?.id, job?.status, loadStatus]);

  const withSudo = useCallback((action: (sudoToken: string) => Promise<void>) => {
    pendingSudoAction.current = action;
    setPasswordError("");
    setPasswordOpen(true);
  }, []);

  const submitPassword = useCallback(async (password: string) => {
    setPasswordBusy(true);
    setPasswordError("");
    try {
      const result = await apiJson<{ sudoToken: string }>("/auth/sudo", {
        method: "POST",
        body: JSON.stringify({ password }),
      });
      const action = pendingSudoAction.current;
      pendingSudoAction.current = null;
      setPasswordOpen(false);
      if (action) await action(result.sudoToken);
    } catch (error) {
      setPasswordError(error instanceof Error ? error.message : String(error));
    } finally {
      setPasswordBusy(false);
    }
  }, []);

  const beginPreflight = useCallback(() => {
    const targetVersion = status?.latest?.version;
    if (!targetVersion) return;
    withSudo(async (sudoToken) => {
      setLoading(true);
      setActionError("");
      setPreflight(null);
      try {
        const result = await apiJson<UpdatePreflight>(
          "/settings/system-update/preflight",
          { method: "POST", body: JSON.stringify({ targetVersion }) },
          { interactive: true, sudoToken },
        );
        if (result.noOp) {
          setPreflight(null);
          setActionError("当前实例已运行目标镜像 Digest，无需重复升级。");
          await loadStatus();
        } else {
          setPreflight(result);
          setConfirmVersion("");
          setRiskAccepted(false);
        }
      } catch (error) {
        setActionError(error instanceof Error ? error.message : String(error));
      } finally {
        setLoading(false);
      }
    });
  }, [status?.latest?.version, withSudo]);

  const applyUpdate = useCallback(() => {
    if (!preflight?.preflightId || !preflight.currentVersion || !preflight.targetVersion) return;
    withSudo(async (sudoToken) => {
      setLoading(true);
      setActionError("");
      try {
        const next = await apiJson<UpdateJob>(
          "/settings/system-update/apply",
          {
            method: "POST",
            body: JSON.stringify({
              preflightId: preflight.preflightId,
              currentVersion: preflight.currentVersion,
              targetVersion: preflight.targetVersion,
              confirmVersion,
            }),
          },
          { interactive: true, sudoToken },
        );
        setJob(next);
      } catch (error) {
        setActionError(error instanceof Error ? error.message : String(error));
      } finally {
        setLoading(false);
      }
    });
  }, [confirmVersion, preflight, withSudo]);

  const cancelJob = useCallback(() => {
    if (!job?.id) return;
    withSudo(async (sudoToken) => {
      setLoading(true);
      try {
        const next = await apiJson<UpdateJob>(
          `/settings/system-update/jobs/${encodeURIComponent(job.id)}/cancel`,
          { method: "POST", body: "{}" },
          { interactive: true, sudoToken },
        );
        setJob(next);
      } catch (error) {
        setActionError(error instanceof Error ? error.message : String(error));
      } finally {
        setLoading(false);
      }
    });
  }, [job?.id, withSudo]);

  const active = job && ["queued", "running"].includes(job.status);
  const latestVersion = status?.latest?.version || "";
  const confirmReady =
    !!preflight?.preflightId &&
    confirmVersion === preflight.targetVersion &&
    riskAccepted &&
    !active &&
    !loading;

  const summaryRows = useMemo(() => {
    if (!status) return [];
    return [
      ["部署类型", status.deployment.label],
      ["镜像 Tag", status.current.image || "—"],
      ["当前 Digest", shortDigest(status.current.digest)],
      ["更新代理", status.updater.available ? "已连接" : status.updater.configured ? "不可达" : "未启用"],
    ];
  }, [status]);

  if (!host || hidden) return <PasswordDialog open={passwordOpen} busy={passwordBusy} error={passwordError} onClose={() => setPasswordOpen(false)} onSubmit={submitPassword} />;

  return (
    <>
      {createPortal(
        <div data-nowen-docker-update="true" className="mt-3 space-y-3 border-t border-zinc-200/60 pt-3 dark:border-zinc-800/60">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-zinc-800 dark:text-zinc-200">
              <Container size={14} />
              Docker 服务端在线升级
            </div>
            <button type="button" onClick={() => void loadStatus()} disabled={loading || !!active} className="rounded-lg p-1 text-zinc-400 hover:bg-zinc-200/60 disabled:opacity-40 dark:hover:bg-zinc-700/50" title="刷新升级状态">
              <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
            </button>
          </div>

          {!status ? (
            <div className="flex items-center gap-2 text-xs text-zinc-400"><Loader2 size={13} className="animate-spin" />读取部署状态…</div>
          ) : (
            <>
              <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[11px]">
                {summaryRows.map(([label, value]) => (
                  <React.Fragment key={label}>
                    <span className="text-zinc-400 dark:text-zinc-500">{label}</span>
                    <span className="truncate text-right font-mono text-zinc-600 dark:text-zinc-300" title={value}>{value}</span>
                  </React.Fragment>
                ))}
              </div>

              {status.canPreflight && !preflight && !active && (
                <button type="button" onClick={beginPreflight} disabled={loading} className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent-primary px-3 py-2 text-xs font-medium text-white disabled:opacity-50">
                  {loading ? <Loader2 size={13} className="animate-spin" /> : <ShieldCheck size={13} />}
                  预检并备份，准备升级到 v{latestVersion}
                </button>
              )}

              {!status.canPreflight && !active && (
                <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-900/40">
                  <div className="flex items-start gap-2">
                    {status.updateAvailable ? <CircleOff size={14} className="mt-0.5 shrink-0 text-amber-500" /> : <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-emerald-500" />}
                    <div className="min-w-0">
                      <p className="text-xs font-medium text-zinc-700 dark:text-zinc-200">{status.manualGuidance.title}</p>
                      <div className="mt-1 space-y-1 text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">
                        {status.blockers.map((item) => <p key={item.code}>{item.message}</p>)}
                        {status.manualGuidance.steps.map((step, index) => <code key={`${index}-${step}`} className="block break-all rounded bg-zinc-200/60 px-1.5 py-1 font-mono text-[10px] dark:bg-zinc-800">{step}</code>)}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {preflight && !preflight.noOp && !active && (
                <div className="space-y-3 rounded-xl border border-amber-300/70 bg-amber-50/60 p-3 dark:border-amber-800/70 dark:bg-amber-950/20">
                  <div className="flex items-start gap-2">
                    <AlertTriangle size={15} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
                    <div>
                      <p className="text-xs font-semibold text-amber-800 dark:text-amber-200">预检通过，等待最终确认</p>
                      <p className="mt-1 text-[11px] leading-relaxed text-amber-700/90 dark:text-amber-300/80">
                        将从 v{preflight.currentVersion} 升级到 v{preflight.targetVersion}。失败时自动恢复旧镜像，但不会自动覆盖数据库；完整备份会保留。
                      </p>
                    </div>
                  </div>
                  <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px] text-zinc-600 dark:text-zinc-300">
                    <span className="text-zinc-400">目标 Digest</span><span className="truncate text-right font-mono">{shortDigest(preflight.updater.targetDigest)}</span>
                    <span className="text-zinc-400">架构</span><span className="text-right font-mono">{preflight.updater.architecture}</span>
                    <span className="text-zinc-400">目标镜像大小</span><span className="text-right">{formatBytes(preflight.updater.imageSize)}</span>
                    <span className="text-zinc-400">升级前备份</span><span className="truncate text-right" title={preflight.backup?.filename}>{preflight.backup?.filename || "—"}</span>
                    <span className="text-zinc-400">备份大小</span><span className="text-right">{formatBytes(preflight.backup?.size)}</span>
                  </div>
                  {(preflight.warnings || []).map((warning) => (
                    <p key={warning.code} className="text-[11px] leading-relaxed text-amber-700 dark:text-amber-300">• {warning.message}</p>
                  ))}
                  <label className="flex items-start gap-2 text-[11px] leading-relaxed text-zinc-600 dark:text-zinc-300">
                    <input type="checkbox" checked={riskAccepted} onChange={(event: React.ChangeEvent<HTMLInputElement>) => setRiskAccepted(event.target.checked)} className="mt-0.5 h-3.5 w-3.5 accent-amber-600" />
                    <span>我理解数据库迁移兼容性目前无法自动证明，自动回滚仅恢复旧镜像，必要时需使用升级前备份人工恢复数据。</span>
                  </label>
                  <input
                    value={confirmVersion}
                    onChange={(event: React.ChangeEvent<HTMLInputElement>) => setConfirmVersion(event.target.value.trim())}
                    placeholder={`输入 ${preflight.targetVersion} 确认升级`}
                    className="w-full rounded-lg border border-amber-300 bg-white px-2.5 py-1.5 font-mono text-xs outline-none focus:border-amber-500 dark:border-amber-800 dark:bg-zinc-950"
                  />
                  <div className="flex gap-2">
                    <button type="button" onClick={() => setPreflight(null)} disabled={loading} className="flex-1 rounded-lg border border-zinc-300 px-3 py-1.5 text-xs text-zinc-600 dark:border-zinc-700 dark:text-zinc-300">取消</button>
                    <button type="button" onClick={applyUpdate} disabled={!confirmReady} className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40">
                      {loading && <Loader2 size={12} className="animate-spin" />}
                      立即升级
                    </button>
                  </div>
                </div>
              )}

              {job && (
                <div className="space-y-2 rounded-xl border border-zinc-200 bg-zinc-50/70 p-3 dark:border-zinc-800 dark:bg-zinc-900/40">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                      {active ? <Loader2 size={14} className="shrink-0 animate-spin text-accent-primary" /> : job.status === "completed" ? <CheckCircle2 size={14} className="shrink-0 text-emerald-500" /> : <RotateCcw size={14} className="shrink-0 text-amber-500" />}
                      <span className="truncate text-xs font-medium text-zinc-700 dark:text-zinc-200">{phaseText(job.phase)}</span>
                    </div>
                    {job.cancellable && active && (
                      <button type="button" onClick={cancelJob} disabled={loading} className="text-[11px] text-zinc-500 hover:text-red-500">安全取消</button>
                    )}
                  </div>
                  {connectionLost && active && (
                    <p className="text-[11px] text-amber-600 dark:text-amber-400">主服务正在重建，连接暂时中断；页面会继续轮询独立更新代理。</p>
                  )}
                  {job.error && <p className="text-[11px] leading-relaxed text-red-500">{job.error}</p>}
                  {job.phase === "rolled_back" && (
                    <p className="text-[11px] leading-relaxed text-amber-600 dark:text-amber-400">旧镜像已恢复。升级前完整备份仍保留；数据未被自动恢复。</p>
                  )}
                  <div className="max-h-36 space-y-1 overflow-y-auto rounded-lg bg-zinc-950 p-2 font-mono text-[10px] leading-relaxed text-zinc-300">
                    {job.logs.slice(-18).map((entry, index) => (
                      <div key={`${entry.at}-${index}`} className={entry.level === "error" ? "text-red-300" : entry.level === "warn" ? "text-amber-300" : ""}>
                        <span className="text-zinc-600">{new Date(entry.at).toLocaleTimeString()}</span> {entry.message}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {status.updater.available && status.current.health && (
                <div className="flex items-center justify-between text-[10px] text-zinc-400 dark:text-zinc-500">
                  <span className="flex items-center gap-1"><HardDrive size={11} />Schema {status.current.schemaVersion}/{status.current.codeSchemaVersion}</span>
                  <span>容器健康：{status.current.health}</span>
                </div>
              )}
            </>
          )}

          {actionError && <p className="text-[11px] leading-relaxed text-red-500">{actionError}</p>}
        </div>,
        host,
      )}
      <PasswordDialog
        open={passwordOpen}
        busy={passwordBusy}
        error={passwordError}
        onClose={() => {
          if (!passwordBusy) {
            pendingSudoAction.current = null;
            setPasswordOpen(false);
          }
        }}
        onSubmit={submitPassword}
      />
    </>
  );
}
