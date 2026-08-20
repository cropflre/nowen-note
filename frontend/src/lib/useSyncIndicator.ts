import { useEffect, useState } from "react";
import {
  fetchSyncDiagnostics,
  fetchSyncSettings,
  SyncV2DisabledError,
} from "@/lib/syncLocalApi";

/**
 * 同步状态指示（Phase 7）。
 *
 * 措辞是这里最要紧的事，因为它直接决定用户对"数据是否安全"的认知：
 *
 *   仅本地       ✓ 已保存
 *   同步完成     ✓ 已同步
 *   正在同步     同步中…
 *   断网         离线 · 已保存到本机
 *   异常         同步遇到问题
 *
 * **本地写入成功就叫"已保存"**。远端失败只能叫"等待同步 / 同步失败"，
 * 绝不能显示"保存失败"——用户数据是否安全由本地 DB 决定，
 * 远端 ACK 只代表同步成功。
 *
 * 另一条约束：不为每次重试弹 Toast。同步是后台行为，
 * 频繁打扰会让用户以为出了大问题。
 */

export type SyncIndicatorState =
  | "local-only"
  | "synced"
  | "syncing"
  | "offline"
  | "problem";

export interface SyncIndicatorSnapshot {
  state: SyncIndicatorState;
  label: string;
  pendingMutations: number;
  conflictCount: number;
  /** Sync V2 未启用或纯本地模式时为 false，UI 可隐藏同步相关入口。 */
  syncEnabled: boolean;
}

const LABELS: Record<SyncIndicatorState, string> = {
  "local-only": "已保存",
  synced: "已同步",
  syncing: "同步中…",
  offline: "离线 · 已保存到本机",
  problem: "同步遇到问题",
};

function resolveState(input: {
  syncEnabled: boolean;
  online: boolean;
  pending: number;
  lastError: string | null;
}): SyncIndicatorState {
  if (!input.syncEnabled) return "local-only";
  // 断网优先于错误：此时"离线"比"出问题"更准确，也更让人安心。
  if (!input.online) return "offline";
  if (input.lastError === "NETWORK_UNAVAILABLE") return "offline";
  if (input.lastError) return "problem";
  if (input.pending > 0) return "syncing";
  return "synced";
}

const POLL_INTERVAL_MS = 15_000;

/**
 * 轮询同步状态。
 *
 * 用轮询而非 WebSocket 推送：状态展示对实时性要求很低，
 * 15 秒足够，而且不必为一个指示灯维护额外的连接与重连逻辑。
 */
export function useSyncIndicator(): SyncIndicatorSnapshot {
  const [snapshot, setSnapshot] = useState<SyncIndicatorSnapshot>({
    state: "local-only",
    label: LABELS["local-only"],
    pendingMutations: 0,
    conflictCount: 0,
    syncEnabled: false,
  });

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      try {
        const settings = await fetchSyncSettings();
        const syncEnabled = settings.mode === "server";

        if (!syncEnabled) {
          if (!cancelled) {
            setSnapshot({
              state: "local-only",
              label: LABELS["local-only"],
              pendingMutations: 0,
              conflictCount: 0,
              syncEnabled: false,
            });
          }
          return;
        }

        const diagnostics = await fetchSyncDiagnostics();
        const state = resolveState({
          syncEnabled,
          online: typeof navigator === "undefined" ? true : navigator.onLine,
          pending: diagnostics.pendingMutations,
          lastError: diagnostics.lastError,
        });

        if (!cancelled) {
          setSnapshot({
            state,
            label: LABELS[state],
            pendingMutations: diagnostics.pendingMutations,
            conflictCount: diagnostics.conflictCount,
            syncEnabled: true,
          });
        }
      } catch (error) {
        // Sync V2 未启用是默认状态，不是错误：静默退回"已保存"。
        if (!cancelled && error instanceof SyncV2DisabledError) {
          setSnapshot({
            state: "local-only",
            label: LABELS["local-only"],
            pendingMutations: 0,
            conflictCount: 0,
            syncEnabled: false,
          });
        }
        // 其他异常同样不打扰用户：本地保存不受影响，下次轮询会自愈。
      } finally {
        if (!cancelled) timer = setTimeout(tick, POLL_INTERVAL_MS);
      }
    };

    void tick();

    // 网络恢复时立即刷新一次，让指示灯不必等下个周期。
    const onOnline = () => { void tick(); };
    if (typeof window !== "undefined") window.addEventListener("online", onOnline);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      if (typeof window !== "undefined") window.removeEventListener("online", onOnline);
    };
  }, []);

  return snapshot;
}

export function syncIndicatorLabel(state: SyncIndicatorState): string {
  return LABELS[state];
}
