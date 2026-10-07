import { useEffect, useState } from "react";
import { getServerUrl, isNativeCapacitor, SERVER_URL_CHANGED_EVENT } from "@/lib/api";
import { isMobileLocalMode } from "@/lib/mobileLocalMode";
import {
  getServerEndpointSnapshot, setAutomaticServerEndpoint,
  SERVER_ENDPOINT_CHANGED_EVENT, SERVER_ENDPOINT_PREFERENCES_CHANGED_EVENT,
} from "@/lib/serverEndpointState";

export default function ServerConnectionSettings() {
  const [connection, setConnection] = useState(() => getServerEndpointSnapshot(getServerUrl()));
  useEffect(() => {
    const refresh = () => setConnection(getServerEndpointSnapshot(getServerUrl()));
    const events = [SERVER_ENDPOINT_CHANGED_EVENT, SERVER_ENDPOINT_PREFERENCES_CHANGED_EVENT, SERVER_URL_CHANGED_EVENT];
    events.forEach((event) => window.addEventListener(event, refresh));
    return () => events.forEach((event) => window.removeEventListener(event, refresh));
  }, []);
  if (!isNativeCapacitor() || isMobileLocalMode() || !connection.serverUrl) return null;
  return <section className="space-y-3 rounded-lg border p-4">
    <h3 className="text-sm font-medium">服务器连接</h3>
    <dl className="space-y-2 text-sm">
      <div><dt className="text-xs text-muted-foreground">服务器</dt>
        <dd>{connection.name || "Nowen Note"}{connection.serverInstanceId
          ? <span className="ml-2 text-xs text-muted-foreground" title={connection.serverInstanceId}>{connection.serverInstanceId.slice(0, 8)}</span>
          : null}</dd></div>
      <div><dt className="text-xs text-muted-foreground">当前连接</dt>
        <dd className="break-all">{connection.endpointUrl}<span className="ml-2 text-xs text-muted-foreground">
          {connection.kind === "lan" ? "局域网" : "已保存地址"}</span></dd></div>
      <div><dt className="text-xs text-muted-foreground">公网 / 常用地址</dt>
        <dd className="break-all">{connection.serverUrl}</dd></div>
    </dl>
    <label className="flex cursor-pointer items-center gap-2 text-sm">
      <input type="checkbox" checked={connection.automatic}
        onChange={(event) => setAutomaticServerEndpoint(connection.serverUrl, event.target.checked)} />
      自动选择最佳连接地址
    </label>
    <p className="text-xs text-muted-foreground">常用地址不可达时，仅在 Wi-Fi 下尝试经过服务器身份验证的局域网地址。</p>
    {!connection.serverInstanceId && connection.automatic
      ? <p className="text-xs text-muted-foreground">请先通过已保存地址连接一次，确认服务器身份后即可自动切换。</p> : null}
  </section>;
}
