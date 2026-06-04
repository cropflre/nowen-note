import { useNetworkStatus } from "@/hooks/useNetworkStatus";
import { WifiOff, CloudUpload, Check, Loader2 } from "lucide-react";
import { useState } from "react";

export default function OfflineIndicator() {
  const { isOnline, wasOffline, pendingCount, flush } = useNetworkStatus();
  const [syncing, setSyncing] = useState(false);

  if (isOnline && pendingCount === 0 && !wasOffline) return null;

  const handleFlush = async () => {
    if (!isOnline || syncing) return;
    setSyncing(true);
    try {
      await flush(true);
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="fixed bottom-4 right-4 z-[9999] flex flex-col items-end gap-2 pointer-events-none">
      {wasOffline && isOnline && (
        <div className="pointer-events-auto flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-green-500/90 text-white text-xs shadow-lg animate-in fade-in slide-in-from-bottom-2 duration-300">
          <Check className="w-3.5 h-3.5" />
          <span>已恢复连接</span>
        </div>
      )}

      {!isOnline && (
        <div className="pointer-events-auto flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-amber-500/90 text-white text-xs shadow-lg">
          <WifiOff className="w-3.5 h-3.5" />
          <span>本地优先</span>
        </div>
      )}

      {pendingCount > 0 && (
        <button
          onClick={handleFlush}
          disabled={!isOnline || syncing}
          className="pointer-events-auto flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-blue-500/90 hover:bg-blue-600/90 disabled:opacity-60 text-white text-xs shadow-lg transition-colors cursor-pointer disabled:cursor-default"
          title={isOnline ? "点击立即同步" : "等待网络恢复后自动同步"}
        >
          {syncing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CloudUpload className="w-3.5 h-3.5" />}
          <span>待同步 {pendingCount} 条</span>
        </button>
      )}
    </div>
  );
}
