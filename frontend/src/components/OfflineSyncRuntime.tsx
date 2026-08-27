import { useEffect } from "react";
import { api } from "@/lib/api";
import { SYNC_SNAPSHOT_APPLIED_EVENT } from "@/lib/syncEngine";
import { installOfflineAttachmentRecoveryCapture } from "@/lib/offlineAttachmentRecovery";
import { useNetworkStatus } from "@/hooks/useNetworkStatus";
import { useAppActions } from "@/store/AppContext";
import { isMobileLocalMode } from "@/lib/mobileLocalMode";

/**
 * Web / Electron / 服务端账号模式使用的旧离线队列 Runtime。
 *
 * Android 设备本地模式已经拥有 Native SQLite + Native Repository + Mobile Sync Engine。
 * 纯本地模式不能同时启动这套 Web Runtime，否则会继续探测 /health、触发 syncNow()
 * 和旧附件恢复链路，造成“本地模式仍在请求服务器”的噪声与状态竞争。
 */
function ServerOfflineSyncRuntime() {
  const actions = useAppActions();
  useNetworkStatus({ signalRecovery: false });

  useEffect(() => installOfflineAttachmentRecoveryCapture(), []);

  useEffect(() => {
    const handleSnapshot = () => {
      actions.refreshNotes();
      actions.refreshNotebooks();
      api.getTags().then(actions.setTags).catch((error) => {
        console.warn("[OfflineSyncRuntime] refresh tags after sync failed:", error);
      });
    };
    window.addEventListener(SYNC_SNAPSHOT_APPLIED_EVENT, handleSnapshot);
    return () => window.removeEventListener(SYNC_SNAPSHOT_APPLIED_EVENT, handleSnapshot);
  }, [actions]);

  return null;
}

export default function OfflineSyncRuntime() {
  if (isMobileLocalMode()) return null;
  return <ServerOfflineSyncRuntime />;
}
