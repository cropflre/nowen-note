/**
 * 编辑器同步状态徽标（Phase 7 接线）。
 *
 * 刻意与既有的"保存状态"指示器**分开**渲染，而不是把同步状态混进去。
 *
 * 原因（第二十条铁律）：
 *   本地写入成功 = 已保存
 *   远端 ACK     = 已同步
 * 这两件事不是同一个状态机。把它们合并后，一次网络抖动就会让
 * 用户看到"保存失败"，而实际上笔记早已安全落在本机 SQLite。
 *
 * 显示规则：
 * - 未启用同步：完全不渲染。纯本地用户不需要看到任何同步字样，
 *   保存指示器的"已保存"已经说明了一切；
 * - Android 始终展示轻量同步文字；其它端在已同步且无冲突时隐藏。
 *
 * 不弹 Toast，不做动画抖动 —— 同步是后台行为。状态切换时图标只做一次
 * 原地交叉淡入（AnimatedSwap），不旋转、不闪烁。
 */

import { AlertTriangle, Check, CloudOff, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";

import { AnimatedSwap } from "@/components/ui/animated-swap";
import { cn } from "@/lib/utils";
import { useSyncIndicator } from "@/lib/useSyncIndicator";
import { isAndroidNativeRuntime } from "@/lib/mobileLocalMode";
import { useNoteSyncReceipt } from "@/lib/useNoteSyncReceipt";

export default function SyncStatusBadge({ className, saving = false, noteId, remotePending = false }: {
  className?: string;
  saving?: boolean;
  noteId?: string;
  /** The open editor knows a newer persisted version it has not applied yet. */
  remotePending?: boolean;
}) {
  const { t } = useTranslation();
  const sync = useSyncIndicator(saving);
  const android = isAndroidNativeRuntime();
  const receipt = useNoteSyncReceipt(noteId, sync.syncEnabled);

  // 未启用同步：不占用任何空间。
  if (!sync.syncEnabled) return null;
  if (noteId) {
    // A receipt only confirms this device's own write; never show it as current
    // while a newer version from another device is still waiting to be applied.
    const phase = saving ? "saving"
      : remotePending && receipt !== "conflict" && receipt !== "error" ? "remotePending" : receipt;
    const warning = phase === "conflict" || phase === "error";
    return (
      <span role="status" aria-live="polite" title={t("syncBadge.receiptHint")}
        className={cn("flex shrink-0 items-center gap-1 whitespace-nowrap px-1.5 py-1 rounded-md text-[11px]",
          warning ? "text-amber-600 dark:text-amber-400" : "text-tx-tertiary", className)}>
        <AnimatedSwap swapKey={warning ? "warning" : phase === "confirmed" ? "confirmed" : "pending"}>
          {warning ? <AlertTriangle size={12} /> : phase === "confirmed" ? <Check size={12} /> : <RefreshCw size={12} />}
        </AnimatedSwap>
        <span>{t(`syncBadge.receipt.${phase}`)}</span>
      </span>
    );
  }
  if (saving) return null;

  // 一切正常时保持安静。有冲突则必须提示，即使状态是 synced ——
  // 冲突不会自动消失，用户需要去处理。
  if (!android && sync.state === "synced" && sync.conflictCount === 0) return null;

  const isConflict = sync.conflictCount > 0;
  const iconKey = isConflict || sync.state === "problem"
    ? "warning"
    : sync.state === "offline"
      ? "offline"
      : sync.state === "synced" ? "synced" : "syncing";
  const icon = iconKey === "warning"
    ? <AlertTriangle size={12} />
    : iconKey === "offline"
      ? <CloudOff size={12} />
      : iconKey === "synced" ? <Check size={12} /> : <RefreshCw size={12} />;

  const stateLabel = sync.state === "syncing" && sync.pendingMutations === 0
    ? t("syncBadge.waitingFirst")
    : t(`syncBadge.state.${sync.state}`);
  const label = isConflict
    ? t("syncBadge.conflicts", { count: sync.conflictCount })
    : android && sync.pendingMutations > 0
      ? t("syncBadge.pending", { count: sync.pendingMutations })
      : sync.state === "syncing" && sync.pendingMutations > 0
        ? t("syncBadge.syncing", { count: sync.pendingMutations })
        : stateLabel;

  return (
    <span
      title={
        isConflict
          ? t("syncBadge.conflictHint")
          : t("syncBadge.savedHint", { status: stateLabel })
      }
      className={cn(
        "flex shrink-0 items-center gap-1 whitespace-nowrap px-1.5 py-1 rounded-md text-[11px]",
        isConflict || sync.state === "problem"
          ? "text-amber-600 dark:text-amber-400"
          : "text-tx-tertiary",
        className,
      )}
    >
      <AnimatedSwap swapKey={iconKey}>{icon}</AnimatedSwap>
      <span className={android ? undefined : "hidden sm:inline"}>{label}</span>
    </span>
  );
}
