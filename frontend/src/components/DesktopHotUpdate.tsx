import { useCallback, useEffect, useState } from "react";
import { RefreshCw, RotateCcw, X } from "lucide-react";
import {
  getDesktopHotUpdate,
  onDesktopHotUpdateStatus,
  type DesktopHotUpdateStatus,
} from "@/lib/desktopBridge";
import { runEditorSafetyFlush } from "@/lib/editorSafetyFlush";
import { toast } from "@/lib/toast";

const ROLLBACK_SEEN_KEY = "nowen-hot-update-rollback-seen";
// 与整包安装（electron/updater.js 的 preparing-install）相同的保存时间。
const RESTART_SAVE_GRACE_MS = 1800;

/** 先让编辑器保存、队列写盘，再重启到新版本。 */
export async function restartToHotUpdate(): Promise<void> {
  runEditorSafetyFlush("desktop-hot-update");
  await new Promise((resolve) => window.setTimeout(resolve, RESTART_SAVE_GRACE_MS));
  await getDesktopHotUpdate()?.apply();
}

function useRestart(): [boolean, () => void] {
  const [restarting, setRestarting] = useState(false);
  const restart = useCallback(() => {
    setRestarting(true);
    void restartToHotUpdate().finally(() => setRestarting(false));
  }, []);
  return [restarting, restart];
}

/** 桌面热更新状态：先查一次，之后跟随主进程推送。旧版本 preload 没有热更新时返回 null。 */
export function useDesktopHotUpdateStatus(): DesktopHotUpdateStatus | null {
  const [status, setStatus] = useState<DesktopHotUpdateStatus | null>(null);
  useEffect(() => {
    const bridge = getDesktopHotUpdate();
    if (!bridge) return;
    let cancelled = false;
    void bridge.status().then((next) => {
      if (!cancelled && next) setStatus(next);
    }).catch(() => undefined);
    const off = onDesktopHotUpdateStatus((next) => setStatus(next));
    return () => {
      cancelled = true;
      off();
    };
  }, []);
  return status;
}

function needsRestart(status: DesktopHotUpdateStatus | null): boolean {
  return Boolean(status && status.phase === "ready" && (status.pending || status.restartRequired));
}

/** 「设置 → 关于」更新偏好里的热更新状态与操作。 */
export function DesktopHotUpdateSection() {
  const status = useDesktopHotUpdateStatus();
  const [checking, setChecking] = useState(false);
  const [restarting, restart] = useRestart();
  const check = useCallback(() => {
    const bridge = getDesktopHotUpdate();
    if (!bridge) return;
    setChecking(true);
    void bridge.check().finally(() => setChecking(false));
  }, []);
  if (!status) return null;
  const busy = checking || status.phase === "checking" || status.phase === "downloading";
  return (
    <div data-nowen-hot-update="true" className="mt-3 border-t border-zinc-200/60 pt-3 text-[11px] dark:border-zinc-800/60">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-xs font-semibold text-zinc-800 dark:text-zinc-200">热更新</span>
        <button
          type="button"
          onClick={check}
          disabled={busy || !status.enabled}
          className="flex items-center gap-1 text-xs text-zinc-500 hover:text-accent-primary disabled:opacity-50 dark:text-zinc-400"
        >
          <RefreshCw size={12} className={busy ? "animate-spin" : ""} />
          {busy ? "检查中" : "检查热更新"}
        </button>
      </div>
      <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-zinc-400 dark:text-zinc-500">
        <span>正在运行</span>
        <span className="text-right font-mono text-zinc-700 dark:text-zinc-300">
          v{status.effectiveVersion}
          <span className="ml-1.5 font-sans text-zinc-400">{status.bundleId ? "热更新" : "安装包自带"}</span>
        </span>
        <span>安装包</span>
        <span className="text-right font-mono">v{status.shellVersion}</span>
        <span>壳版本号</span>
        <span className="truncate text-right font-mono" title={status.runtimeVersion || ""}>{status.runtimeVersion || "—"}</span>
        <span>当前状态</span>
        <span className="truncate text-right" title={status.message}>{status.message || "等待检查"}</span>
      </div>
      {status.lastRollback && (
        <p className="mt-1.5 leading-5 text-amber-600 dark:text-amber-400">
          v{status.lastRollback.version} 未能正常启动（{status.lastRollback.reason}），已自动退回并跳过这个版本。
        </p>
      )}
      {status.enabled && (
        <label className="mt-1.5 flex cursor-pointer items-center justify-between gap-3 text-zinc-500 dark:text-zinc-400">
          <span>自动下载热更新（下次启动时生效）</span>
          <input
            type="checkbox"
            role="switch"
            checked={status.autoDownload}
            onChange={(event) => void getDesktopHotUpdate()?.setAutoDownload(event.target.checked)}
            className="accent-indigo-600"
          />
        </label>
      )}
      {needsRestart(status) && (
        <button
          type="button"
          onClick={restart}
          disabled={restarting}
          className="mt-2 h-8 w-full rounded-lg bg-accent-primary text-xs font-medium text-white hover:opacity-90 disabled:opacity-60"
        >
          {restarting ? "正在保存…" : "立即重启以更新"}
        </button>
      )}
    </div>
  );
}

/** 新版本下载好后的底部提示；新包启动失败被退回时提示一次。 */
export function DesktopHotUpdateBanner() {
  const status = useDesktopHotUpdateStatus();
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [restarting, restart] = useRestart();

  useEffect(() => {
    const rollback = status?.lastRollback;
    if (!rollback) return;
    const key = `${rollback.bundleId}:${rollback.at}`;
    try {
      if (localStorage.getItem(ROLLBACK_SEEN_KEY) === key) return;
      localStorage.setItem(ROLLBACK_SEEN_KEY, key);
    } catch {
      /* 存储不可用时最多重复提示一次 */
    }
    toast.error(`更新 v${rollback.version} 未能正常启动，已自动退回之前的版本`, 8000);
  }, [status?.lastRollback]);

  if (!needsRestart(status)) return null;
  const key = status?.pending?.bundleId ?? "restart";
  if (dismissed === key) return null;
  return (
    <div
      className="fixed inset-x-0 bottom-0 z-[10000] flex justify-center pointer-events-none"
      style={{ paddingBottom: "12px" }}
    >
      <div role="status" className="pointer-events-auto flex w-[min(92vw,30rem)] items-center gap-2 rounded-lg bg-zinc-900/95 px-3 py-2 text-sm text-white shadow-lg backdrop-blur-sm dark:bg-zinc-800/95">
        <RotateCcw className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1">{status?.message}</span>
        <button
          type="button"
          onClick={restart}
          disabled={restarting}
          className="flex-shrink-0 rounded-md bg-white/20 px-2.5 py-1 text-xs font-medium transition-colors hover:bg-white/30 disabled:opacity-60"
        >
          {restarting ? "正在保存…" : "立即重启"}
        </button>
        <button
          type="button"
          onClick={() => setDismissed(key)}
          className="flex-shrink-0 rounded-md p-1 transition-colors hover:bg-white/20"
          aria-label="下次启动时再更新"
          title="下次启动时再更新"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
