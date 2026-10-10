import { useEffect } from "react";
import { api } from "@/lib/api";
import { SYNC_SNAPSHOT_APPLIED_EVENT } from "@/lib/syncEngine";
import { installOfflineAttachmentRecoveryCapture } from "@/lib/offlineAttachmentRecovery";
import { useNetworkStatus } from "@/hooks/useNetworkStatus";
import { useAppActions } from "@/store/AppContext";
import { isAndroidNativeRuntime } from "@/lib/mobileLocalMode";

/**
 * Web / Electron 使用的旧离线队列 Runtime。
 *
 * Android Native 无论是设备本地模式还是已登录账号，都由
 * mobileLocalFirstRuntime + Native SQLite + MobileSyncEngine 管理持久化/同步。
 * Android 再挂载这里会产生第二套 /health 探测、syncNow() 和附件恢复链路，
 * 导致重复请求、状态竞争以及“本地模式仍在访问服务器”的噪声。
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
  if (isAndroidNativeRuntime()) return null;
  return <ServerOfflineSyncRuntime />;
}
