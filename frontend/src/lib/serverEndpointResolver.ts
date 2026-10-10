import type { ConnectionStatus } from "@capacitor/network";
import type { DiscoveredService, LanDiscovery } from "./lanDiscovery";
import {
  buildServerPathCandidates, cacheResolvedServerConnection, formatServerHost,
  getConfiguredApiBaseUrl, isLanServerHostname, isLoopbackServerHostname,
  normalizeServerBaseUrl, type ServerPathCandidate,
} from "./serverUrl";
import { getServerEndpointSnapshot, rememberServerInstanceId, setServerTransportEndpoint } from "./serverEndpointState";

export interface ProbedServerEndpoint {
  connection: ServerPathCandidate;
  serverInstanceId: string | null;
}

/** 未验证的地址只探测公开版本接口，不发送 token/cookie，也不跟随重定向。 */
export async function probeServerEndpoint(serverUrl: string, signal?: AbortSignal): Promise<ProbedServerEndpoint | null> {
  // Capacitor 的 GET 代理会在原生层跟随重定向；版本探测必须使用原始 Web fetch
  // 才能保证 credentials/redirect/AbortSignal 的语义，不把未验证地址当成受信服务。
  const probeFetch = ((window as Window & { CapacitorWebFetch?: typeof fetch }).CapacitorWebFetch || fetch).bind(window);
  const cachedApi = getConfiguredApiBaseUrl(serverUrl);
  const candidates = buildServerPathCandidates(serverUrl).sort((a, b) =>
    Number(b.apiBaseUrl === cachedApi) - Number(a.apiBaseUrl === cachedApi));
  for (const connection of candidates) {
    if (signal?.aborted) return null;
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal?.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(cancel, 2500);
    try {
      const response = await probeFetch(`${connection.apiBaseUrl}/version`, {
        signal: controller.signal, cache: "no-store", credentials: "omit", redirect: "error",
        headers: { Accept: "application/json" },
      });
      if (!response.ok) continue;
      const payload = await response.json() as { appVersion?: unknown; serverInstanceId?: unknown };
      if (typeof payload?.appVersion !== "string") continue;
      return { connection, serverInstanceId: typeof payload.serverInstanceId === "string" && payload.serverInstanceId
        ? payload.serverInstanceId : null };
    } catch (error) {
      if (controller.signal.aborted || error instanceof TypeError) return null;
      // HTML/非 JSON 响应可能是代理首页，继续既有兼容路径。
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
    }
  }
  return null;
}

export function discoveredServerEndpoints(service: DiscoveredService): string[] {
  if (!Number.isInteger(service.port) || service.port < 1 || service.port > 65535) return [];
  const hosts = [...new Set([service.ipv4, ...service.addresses, service.host].filter(Boolean))];
  return hosts.flatMap((host) => {
    if (!isLanServerHostname(host) || isLoopbackServerHostname(host)) return [];
    const base = normalizeServerBaseUrl(`${service.txt.https === "1" ? "https" : "http"}://${formatServerHost(host)}:${service.port}`);
    if (!base) return [];
    const url = new URL(base);
    if (!isLanServerHostname(url.hostname) || isLoopbackServerHostname(url.hostname)) return [];
    url.pathname = service.txt.path || "/";
    return [normalizeServerBaseUrl(url.toString())];
  });
}

export class ServerEndpointResolver {
  private revision = 0;
  private controller: AbortController | null = null;
  private disposed = false;

  constructor(private readonly serverUrl: string, private readonly discovery: LanDiscovery,
    private readonly probe = probeServerEndpoint) {}

  async resolve(network: ConnectionStatus): Promise<void> {
    const revision = ++this.revision;
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    const current = () => !this.disposed && revision === this.revision && !controller.signal.aborted;
    if (!current()) return;
    // LAN 地址属于上一张网络。先撤回，再在当前 Wi-Fi 上重新验证。
    setServerTransportEndpoint(this.serverUrl, this.serverUrl);
    if (!network.connected) return;
    const configured = await this.probe(this.serverUrl, controller.signal);
    if (!current()) return;
    if (configured) {
      if (configured.serverInstanceId) rememberServerInstanceId(this.serverUrl, configured.serverInstanceId);
      cacheResolvedServerConnection(configured.connection);
      return;
    }
    const settings = getServerEndpointSnapshot(this.serverUrl);
    if (!settings.automatic || network.connectionType !== "wifi" || !settings.serverInstanceId) return;
    const lan = await this.findLan(settings.serverInstanceId, controller.signal);
    if (!current() || !lan || !getServerEndpointSnapshot(this.serverUrl).automatic) return;
    cacheResolvedServerConnection(lan.endpoint.connection);
    setServerTransportEndpoint(this.serverUrl, lan.endpoint.connection.serverBaseUrl, lan.name);
  }

  private findLan(expectedId: string, signal: AbortSignal): Promise<{ endpoint: ProbedServerEndpoint; name: string } | null> {
    if (!this.discovery.isAvailable()) return Promise.resolve(null);
    return new Promise((resolve) => {
      let finished = false;
      let unsubscribe = () => {};
      const probing = new AbortController();
      const seen = new Set<string>();
      const finish = (value: { endpoint: ProbedServerEndpoint; name: string } | null) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", cancel);
        unsubscribe();
        probing.abort();
        resolve(value);
      };
      const cancel = () => finish(null);
      const timer = setTimeout(cancel, 5000);
      signal.addEventListener("abort", cancel, { once: true });
      unsubscribe = this.discovery.onUpdate((services) => {
        for (const service of services) for (const url of discoveredServerEndpoints(service)) {
          if (finished || seen.has(url) || seen.size >= 16) continue;
          seen.add(url);
          void this.probe(url, probing.signal).then((endpoint) => {
            if (endpoint?.serverInstanceId === expectedId) finish({ endpoint, name: service.name });
          }).catch(() => {});
        }
      });
      void this.discovery.start().then((result) => { if (!result.ok) finish(null); }).catch(cancel);
      if (signal.aborted) finish(null);
    });
  }

  dispose(): void {
    this.disposed = true;
    this.revision++;
    this.controller?.abort();
    setServerTransportEndpoint(this.serverUrl, this.serverUrl);
  }
}
