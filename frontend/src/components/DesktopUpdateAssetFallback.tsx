import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, ExternalLink, X } from "lucide-react";
import { isDesktop, onUpdaterStatus } from "@/lib/desktopBridge";
import type { DesktopUpdateSnapshot } from "@/lib/updateExperience";
import {
  DESKTOP_RELEASES_URL,
  describeMissingUpdateAsset,
  isMissingUpdateAssetFailure,
} from "@/lib/updateAssetFailure";

export default function DesktopUpdateAssetFallback() {
  const [failure, setFailure] = useState<DesktopUpdateSnapshot | null>(null);

  useEffect(() => {
    if (!isDesktop()) return;
    return onUpdaterStatus((payload) => {
      const snapshot = payload as DesktopUpdateSnapshot;
      if (isMissingUpdateAssetFailure(snapshot)) {
        setFailure(snapshot);
      } else if (snapshot.status !== "error") {
        setFailure(null);
      }
    });
  }, []);

  if (!failure || typeof document === "undefined") return null;

  return createPortal(
    <aside
      role="alert"
      data-nowen-update-asset-fallback="true"
      className="fixed bottom-5 left-1/2 z-[155] w-[min(560px,calc(100vw-2rem))] -translate-x-1/2 rounded-2xl border border-amber-300/70 bg-app-elevated p-4 shadow-2xl dark:border-amber-700/70"
    >
      <button
        type="button"
        onClick={() => setFailure(null)}
        className="absolute right-2.5 top-2.5 rounded-lg p-1.5 text-tx-tertiary hover:bg-app-hover hover:text-tx-primary"
        aria-label="关闭手动下载提示"
      >
        <X size={15} />
      </button>
      <div className="flex items-start gap-3 pr-8">
        <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-amber-500/12 text-amber-600 dark:text-amber-400">
          <AlertTriangle size={19} />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-tx-primary">更新文件未正确发布</h3>
          <p className="mt-1 text-xs leading-5 text-tx-secondary">
            {describeMissingUpdateAsset(failure)}
          </p>
          <div className="mt-3 flex justify-end">
            <a
              href={DESKTOP_RELEASES_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-accent-primary px-4 text-xs font-medium text-white hover:opacity-90"
            >
              前往 Release 页面手动下载
              <ExternalLink size={13} />
            </a>
          </div>
        </div>
      </div>
    </aside>,
    document.body,
  );
}
