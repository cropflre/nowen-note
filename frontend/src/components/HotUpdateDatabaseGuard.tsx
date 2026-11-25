import { useState } from "react";
import { DatabaseZap, Download, RefreshCw } from "lucide-react";
import { getHotUpdateController, useHotUpdateSnapshot } from "@/lib/hotUpdate";

const APK_DOWNLOAD_URL = "https://github.com/cropflre/nowen-note/releases/latest";

/**
 * 本地库的版本比当前代码新时显示的保护页（DCC-013）。
 *
 * 典型原因：新的热更新包升级了数据库，之后又被回退到旧版本。旧代码绝不能读写这个库，
 * 这里不提供任何其他功能，只引导用户换回能打开数据的版本；数据始终原样保留在本机。
 */
export default function HotUpdateDatabaseGuard({ databaseVersion, supportedVersion }: { databaseVersion: number; supportedVersion: number }) {
  const controller = getHotUpdateController();
  const snapshot = useHotUpdateSnapshot();
  const [busy, setBusy] = useState(false);

  const retry = async () => {
    setBusy(true);
    try {
      const result = await controller.check({ manual: true, retryBlocked: true });
      if (result.phase === "ready") await controller.apply();
    } finally {
      setBusy(false);
    }
  };

  const openDownload = () => {
    try {
      window.open(APK_DOWNLOAD_URL, "_blank", "noopener,noreferrer");
    } catch {
      window.location.href = APK_DOWNLOAD_URL;
    }
  };

  return (
    <main
      className="min-h-screen flex items-center justify-center bg-zinc-50 dark:bg-zinc-950 p-6"
      style={{ paddingTop: "calc(var(--safe-area-top, 0px) + 24px)" }}
    >
      <div className="max-w-sm w-full bg-white dark:bg-zinc-900 rounded-2xl shadow-xl border border-zinc-200 dark:border-zinc-800 p-6 space-y-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-amber-100 dark:bg-amber-500/15 flex items-center justify-center flex-shrink-0">
            <DatabaseZap className="w-5 h-5 text-amber-600 dark:text-amber-400" aria-hidden="true" />
          </div>
          <h1 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">需要更新后才能打开本机数据</h1>
        </div>
        <p className="text-sm text-zinc-600 dark:text-zinc-300 leading-relaxed">
          这台设备上的笔记数据已被更新的版本升级过（数据版本 {databaseVersion}，当前版本最高支持 {supportedVersion}）。
          为了不损坏数据，当前版本不会读写它。你的数据仍然完整地保存在本机。
        </p>
        <button
          type="button"
          onClick={() => void retry()}
          disabled={busy}
          className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-accent-primary text-white text-sm font-medium hover:opacity-90 disabled:opacity-60"
        >
          <RefreshCw className={`w-4 h-4 ${busy ? "animate-spin" : ""}`} aria-hidden="true" />
          {busy ? "正在获取…" : "获取最新版本"}
        </button>
        <button
          type="button"
          onClick={openDownload}
          className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg border border-zinc-200 dark:border-zinc-700 text-sm text-zinc-700 dark:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-800"
        >
          <Download className="w-4 h-4" aria-hidden="true" />
          下载最新安装包
        </button>
        {snapshot.message && <p className="text-xs text-zinc-500 dark:text-zinc-400 text-center">{snapshot.message}</p>}
      </div>
    </main>
  );
}
