import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { getHotUpdateController, useHotUpdateSnapshot } from "@/lib/hotUpdate";
import { SwitchRow } from "./preferences/PreferenceControls";

/**
 * 「关于」页的热更新卡片（仅安卓）：分别显示正在运行的版本、安装包版本和壳版本号，
 * 可以手动检查更新、立即重启生效，以及关闭 Wi-Fi 下的自动下载。
 */
export default function HotUpdateStatusCard() {
  const controller = getHotUpdateController();
  const snapshot = useHotUpdateSnapshot();
  const [checking, setChecking] = useState(false);
  if (snapshot.phase === "unsupported") return null;

  const busy = checking || snapshot.phase === "checking" || snapshot.phase === "downloading";
  const runningLabel = snapshot.currentBundleId ? "热更新" : "安装包自带";
  const lastCheck = snapshot.lastCheckAt ? new Date(snapshot.lastCheckAt).toLocaleString() : "尚未检查";

  const check = () => {
    setChecking(true);
    void controller.check({ manual: true }).finally(() => setChecking(false));
  };

  return (
    <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-800/30 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">应用更新</h3>
        <button
          type="button"
          onClick={check}
          disabled={busy || snapshot.phase === "disabled"}
          className="flex items-center gap-1 text-xs text-zinc-500 dark:text-zinc-400 hover:text-accent-primary disabled:opacity-50"
        >
          <RefreshCw size={12} className={busy ? "animate-spin" : ""} />
          {busy ? "检查中" : "检查更新"}
        </button>
      </div>

      <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-xs">
        <span className="text-zinc-500 dark:text-zinc-400">正在运行</span>
        <span className="font-mono text-zinc-900 dark:text-zinc-100">
          v{snapshot.currentVersion}
          <span className="ml-2 font-sans text-zinc-400">{runningLabel}</span>
        </span>
        <span className="text-zinc-500 dark:text-zinc-400">安装包</span>
        <span className="font-mono text-zinc-900 dark:text-zinc-100">
          {snapshot.runtime?.versionName ? `v${snapshot.runtime.versionName}` : "—"}
        </span>
        <span className="text-zinc-500 dark:text-zinc-400">壳版本号</span>
        <span className="font-mono text-zinc-900 dark:text-zinc-100 break-all">{snapshot.runtime?.runtimeVersion || "—"}</span>
        <span className="text-zinc-500 dark:text-zinc-400">上次检查</span>
        <span className="text-zinc-900 dark:text-zinc-100">{lastCheck}</span>
      </div>

      {snapshot.message && <p className="text-xs text-zinc-600 dark:text-zinc-300">{snapshot.message}</p>}

      {snapshot.phase === "ready" && snapshot.pending && (
        <button
          type="button"
          onClick={() => void controller.apply()}
          className="w-full px-3 py-2 rounded-lg bg-accent-primary text-white text-sm font-medium hover:opacity-90"
        >
          立即重启以更新
        </button>
      )}

      <div className="-mx-4 border-t border-zinc-200 dark:border-zinc-800">
        <SwitchRow
          title="自动下载更新"
          description="连接 Wi-Fi 时在后台下载，下次打开应用时生效；移动网络下只在手动检查时下载。"
          checked={snapshot.autoDownload}
          onChange={(enabled) => controller.setAutoDownload(enabled)}
          disabled={snapshot.phase === "disabled"}
        />
      </div>
    </div>
  );
}
