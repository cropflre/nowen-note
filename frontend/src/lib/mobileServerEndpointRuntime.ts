import type { ConnectionStatus, NetworkPlugin } from "@capacitor/network";
import { getLanDiscovery } from "./lanDiscovery";
import { ServerEndpointResolver } from "./serverEndpointResolver";
import { getServerEndpointSnapshot, SERVER_ENDPOINT_PREFERENCES_CHANGED_EVENT } from "./serverEndpointState";

/** 地址变化不派发 server-url-changed，也不重建账号、SQLite 或 SyncProfile。 */
export function createMobileServerEndpointRuntime(serverUrl: string, network: NetworkPlugin, onReady: () => void) {
  const resolver = new ServerEndpointResolver(serverUrl, getLanDiscovery());
  let disposed = false;
  let status: ConnectionStatus = { connected: false, connectionType: "none" };
  let selection = Promise.resolve();
  let retryAfter = 0;
  let automatic = getServerEndpointSnapshot(serverUrl).automatic;
  let networkRevision = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  const select = (next: ConnectionStatus) => {
    if (disposed) return Promise.resolve();
    clearTimeout(retryTimer);
    retryTimer = undefined;
    networkRevision++;
    status = next;
    retryAfter = Date.now() + 15_000;
    const pending = resolver.resolve(next).catch(() => {});
    selection = pending;
    void pending.then(() => { if (!disposed && selection === pending && next.connected) onReady(); });
    return pending;
  };
  const refresh = () => {
    if (disposed) return Promise.resolve();
    const revision = ++networkRevision;
    const pending = network.getStatus().then((next) => {
      if (!disposed && revision === networkRevision) return select(next);
    }).catch(() => {});
    selection = pending;
    return pending;
  };
  const preferencesChanged = (event: Event) => {
    if ((event as CustomEvent<{ serverUrl: string }>).detail.serverUrl !== serverUrl) return;
    const enabled = getServerEndpointSnapshot(serverUrl).automatic;
    if (enabled === automatic) return;
    automatic = enabled;
    void select(status);
  };
  window.addEventListener(SERVER_ENDPOINT_PREFERENCES_CHANGED_EVENT, preferencesChanged);
  // 不等待网络探测，不阻塞 Native 本地库和首屏的初始化。
  void refresh();
  return {
    beforeSync: async () => {
      let pending: Promise<void>;
      do { pending = selection; await pending; } while (!disposed && pending !== selection);
    },
    networkChanged: select,
    refresh,
    recover: () => {
      if (disposed || !status.connected || retryTimer) return;
      retryTimer = setTimeout(() => { retryTimer = undefined; void select(status); }, Math.max(0, retryAfter - Date.now()));
    },
    dispose: () => {
      disposed = true;
      clearTimeout(retryTimer);
      window.removeEventListener(SERVER_ENDPOINT_PREFERENCES_CHANGED_EVENT, preferencesChanged);
      resolver.dispose();
    },
  };
}
