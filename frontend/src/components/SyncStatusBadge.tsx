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
 * - 已同步且无待推送：也不渲染。一切正常时保持安静是最好的反馈；
 * - 仅在同步中 / 离线 / 有问题 / 有冲突时才出现。
 *
 * 不弹 Toast，不做动画抖动 —— 同步是后台行为。
 */

import { AlertTriangle, CloudOff, RefreshCw } from "lucide-react";

import { cn } from "@/lib/utils";
import { useSyncIndicator } from "@/lib/useSyncIndicator";

export default function SyncStatusBadge({ className }: { className?: string }) {
  const sync = useSyncIndicator();

  // 未启用同步：不占用任何空间。
  if (!sync.syncEnabled) return null;

  // 一切正常时保持安静。有冲突则必须提示，即使状态是 synced ——
  // 冲突不会自动消失，用户需要去处理。
  if (sync.state === "synced" && sync.conflictCount === 0) return null;

  const isConflict = sync.conflictCount > 0;
  const icon = isConflict || sync.state === "problem"
    ? <AlertTriangle size={12} />
    : sync.state === "offline"
      ? <CloudOff size={12} />
      : <RefreshCw size={12} className="animate-spin" />;

  const label = isConflict
    ? `${sync.conflictCount} 个冲突待处理`
    : sync.state === "syncing" && sync.pendingMutations > 0
      // 带上数量让用户知道进度，而不是一个永远转不完的圈。
      ? `同步中… ${sync.pendingMutations}`
      : sync.label;

  return (
    <span
      title={
        isConflict
          ? "有内容在多台设备上被同时修改，两个版本都已保留，请到 设置 → 同步 处理"
          : `${sync.label} · 笔记已保存在此设备`
      }
      className={cn(
        "flex shrink-0 items-center gap-1 whitespace-nowrap px-1.5 py-1 rounded-md text-[11px]",
        isConflict || sync.state === "problem"
          ? "text-amber-600 dark:text-amber-400"
          : "text-tx-tertiary",
        className,
      )}
    >
      {icon}
      <span className="hidden sm:inline">{label}</span>
    </span>
  );
}
