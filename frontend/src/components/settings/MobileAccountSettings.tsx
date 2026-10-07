import { useState } from "react";
import { AccountLoginHistoryDialog } from "@/components/AccountLoginHistory";
import { broadcastLogout } from "@/lib/api";
import { isMobileLocalMode, requestMobileAccountLogin } from "@/lib/mobileLocalMode";

export default function MobileAccountSettings({ accountLabel }: { accountLabel?: string }) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const localOnly = isMobileLocalMode();

  return <section className="space-y-3 rounded-lg border border-app-border p-4">
    <h3 className="text-sm font-medium">当前账号</h3>
    <p className="text-sm text-tx-secondary">
      {localOnly ? "未登录" : accountLabel || "当前登录账号"}
    </p>
    {localOnly ? <>
      <p className="text-xs text-tx-tertiary">数据保存在这台设备。登录并开启同步后，本机数据会自动上传到你的服务器。</p>
      <button type="button" className="rounded-md border border-app-border px-3 py-2 text-sm" onClick={() => {
        requestMobileAccountLogin();
        window.location.reload();
      }}>登录并同步</button>
    </> : <div className="flex flex-wrap gap-2">
      <button type="button" className="rounded-md border border-app-border px-3 py-2 text-sm" onClick={() => setHistoryOpen(true)}>登录记录</button>
      <button type="button" className="rounded-md border border-app-border px-3 py-2 text-sm text-accent-danger" onClick={async () => {
        if (!window.confirm("退出当前账号？本机数据会保留，重新登录同一账号后可继续使用。")) return;
        await broadcastLogout("user_logout");
        window.location.reload();
      }}>退出登录</button>
    </div>}
    <AccountLoginHistoryDialog open={historyOpen} onClose={() => setHistoryOpen(false)} />
  </section>;
}
