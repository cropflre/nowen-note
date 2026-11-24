import { useEffect, useState } from "react";
import { RefreshCw, X } from "lucide-react";
import { getHotUpdateController, useHotUpdateSnapshot } from "@/lib/hotUpdate";

/**
 * 安卓热更新的常驻入口：按计划检查更新；新版本下载完成后，在底部提示"重启以更新"。
 * 不点也没关系，下次打开应用时自动生效。其他平台什么都不渲染。
 */
export default function AndroidHotUpdateCenter() {
  const controller = getHotUpdateController();
  const snapshot = useHotUpdateSnapshot();
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);

  useEffect(() => controller.startScheduler(), [controller]);

  if (snapshot.phase !== "ready" || !snapshot.pending) return null;
  const key = snapshot.pending.bundleId ?? "builtin";
  if (dismissed === key) return null;

  const apply = () => {
    setApplying(true);
    void controller.apply().finally(() => setApplying(false));
  };

  return (
    <div
      className="fixed inset-x-0 bottom-0 z-[10000] flex justify-center pointer-events-none"
      style={{ paddingBottom: "calc(var(--safe-area-bottom, 0px) + 12px)" }}
    >
      <div
        role="status"
        className="pointer-events-auto w-[min(92vw,28rem)] flex items-center gap-2 px-3 py-2 rounded-lg bg-zinc-900/95 dark:bg-zinc-800/95 text-white text-sm shadow-lg backdrop-blur-sm"
      >
        <RefreshCw className="w-4 h-4 flex-shrink-0" aria-hidden="true" />
        <span className="flex-1 min-w-0">{snapshot.message}</span>
        <button
          type="button"
          onClick={apply}
          disabled={applying}
          className="flex-shrink-0 px-2.5 py-1 rounded-md bg-white/20 hover:bg-white/30 disabled:opacity-60 transition-colors text-xs font-medium"
        >
          {applying ? "正在重启…" : "立即重启"}
        </button>
        <button
          type="button"
          onClick={() => setDismissed(key)}
          className="flex-shrink-0 p-1 rounded-md hover:bg-white/20 transition-colors"
          aria-label="下次打开时再更新"
          title="下次打开时再更新"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}
