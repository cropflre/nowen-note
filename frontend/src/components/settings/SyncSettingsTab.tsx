/**
 * 同步设置 Tab 容器（Phase 7 接线）。
 *
 * 把「同步设置」与「冲突中心」组合成设置页的一个入口。
 * 单独拆一个容器而不是直接塞进 SettingsModal，原因：
 * - deviceId 需要在两个子组件间共享（冲突解决要标记是哪台设备的选择）；
 * - Sync V2 关闭时整个区域都不该渲染，判定逻辑集中在这里更清楚；
 * - SettingsModal 已经很长，不该继续堆同步相关状态。
 */

import { useEffect, useState } from "react";

import { ConflictCenter } from "@/components/settings/ConflictCenter";
import { SyncSettingsPanel } from "@/components/settings/SyncSettingsPanel";
import {
  SyncV2DisabledError,
  fetchSyncDiagnostics,
} from "@/lib/syncLocalApi";

export default function SyncSettingsTab() {
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [disabled, setDisabled] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const diag = await fetchSyncDiagnostics();
        if (!cancelled) setDeviceId(diag.deviceId ?? null);
      } catch (error) {
        // Flag 关闭是默认状态，不是错误：安静地不渲染同步 UI。
        if (!cancelled && error instanceof SyncV2DisabledError) setDisabled(true);
      }
    })();
    return () => { cancelled = true; };
  }, [reloadKey]);

  if (disabled) {
    return (
      <div className="text-sm text-muted-foreground">
        当前版本未启用多设备同步。笔记全部保存在此设备。
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <SyncSettingsPanel />
      {/* 冲突解决后刷新 deviceId 与诊断，避免显示已处理的冲突数 */}
      <ConflictCenter
        deviceId={deviceId}
        onResolved={() => setReloadKey((n) => n + 1)}
      />
    </div>
  );
}
