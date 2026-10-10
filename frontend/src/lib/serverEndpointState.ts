export const SERVER_ENDPOINT_CHANGED_EVENT = "nowen:server-endpoint-changed";
export const SERVER_ENDPOINT_PREFERENCES_CHANGED_EVENT = "nowen:server-endpoint-preferences-changed";
const PREFERENCES_KEY = "nowen-server-endpoint-preferences-v1";

interface EndpointPreferences {
  automatic: boolean;
  serverInstanceId: string | null;
}

export interface ServerEndpointSnapshot extends EndpointPreferences {
  serverUrl: string;
  endpointUrl: string;
  kind: "configured" | "lan";
  name?: string;
}

// 仅保存当前运行时的路径；重启/网络变化后必须重新确认 LAN 身份。
let active: { serverUrl: string; endpointUrl: string; name?: string } | null = null;

function readPreferences(): Record<string, EndpointPreferences> {
  try { return JSON.parse(localStorage.getItem(PREFERENCES_KEY) || "{}"); } catch { return {}; }
}

export function getServerEndpointSnapshot(serverUrl: string): ServerEndpointSnapshot {
  const saved = readPreferences()?.[serverUrl];
  const automatic = saved?.automatic !== false;
  const selected = automatic && active?.serverUrl === serverUrl ? active : null;
  return {
    serverUrl,
    endpointUrl: selected?.endpointUrl || serverUrl,
    kind: selected && selected.endpointUrl !== serverUrl ? "lan" : "configured",
    name: selected?.name,
    automatic,
    serverInstanceId: typeof saved?.serverInstanceId === "string" ? saved.serverInstanceId : null,
  };
}

export function getServerTransportUrl(serverUrl: string): string {
  return getServerEndpointSnapshot(serverUrl).endpointUrl;
}

export function setServerTransportEndpoint(serverUrl: string, endpointUrl: string, name?: string): void {
  const before = getServerTransportUrl(serverUrl);
  active = endpointUrl === serverUrl ? null : { serverUrl, endpointUrl, name };
  if (before !== getServerTransportUrl(serverUrl) && typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(SERVER_ENDPOINT_CHANGED_EVENT, { detail: { serverUrl } }));
  }
}

function savePreferences(serverUrl: string, saved: EndpointPreferences): void {
  const all = readPreferences();
  try { localStorage.setItem(PREFERENCES_KEY, JSON.stringify({ ...all, [serverUrl]: saved })); } catch { /* optional cache */ }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(SERVER_ENDPOINT_PREFERENCES_CHANGED_EVENT, { detail: { serverUrl } }));
  }
}

/** 身份只能从用户配置的服务器取得；LAN 的自报身份不能建立首次信任。 */
export function rememberServerInstanceId(serverUrl: string, serverInstanceId: string): boolean {
  if (!serverUrl || !serverInstanceId) return false;
  const current = getServerEndpointSnapshot(serverUrl);
  if (current.serverInstanceId) return current.serverInstanceId === serverInstanceId;
  savePreferences(serverUrl, { automatic: current.automatic, serverInstanceId });
  return true;
}

export function setAutomaticServerEndpoint(serverUrl: string, automatic: boolean): void {
  const current = getServerEndpointSnapshot(serverUrl);
  // 先复原路径，保证 WebSocket 能收到真实的端点变化。
  if (!automatic) setServerTransportEndpoint(serverUrl, serverUrl);
  savePreferences(serverUrl, { automatic, serverInstanceId: current.serverInstanceId });
}
