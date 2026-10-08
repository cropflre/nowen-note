import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiscoveredService, LanDiscovery } from "../lanDiscovery";
import { discoveredServerEndpoints, probeServerEndpoint, ServerEndpointResolver } from "../serverEndpointResolver";
import { getServerEndpointSnapshot, rememberServerInstanceId, setAutomaticServerEndpoint, setServerTransportEndpoint } from "../serverEndpointState";
import { buildServerPathCandidates, getConfiguredApiBaseUrl, getResolvedApiBaseUrl, getResolvedWebSocketUrl } from "../serverUrl";
import { getOfflineQueueStorageKey } from "../offlineScope";

const publicUrl = "https://notes.example.com/notes";
const lanUrl = "http://192.168.1.10:3001";
const wifi = { connected: true, connectionType: "wifi" as const };
const cellular = { connected: true, connectionType: "cellular" as const };
const service = (ip = "192.168.1.10"): DiscoveredService => ({
  name: "NAS", host: "", port: 3001, addresses: [ip], ipv4: ip, txt: {}, lastSeen: 0,
});
const result = (url: string, id: string | null = "instance-1", mode = "standard") => ({
  connection: buildServerPathCandidates(url).find((candidate) => candidate.mode === mode)!, serverInstanceId: id,
});
function discovery(initial = [service()]) {
  let current = initial;
  let update = (_services: DiscoveredService[]) => {};
  const off = vi.fn();
  const client: LanDiscovery = {
    isAvailable: () => true, stop: vi.fn(async () => {}),
    start: vi.fn(async () => ({ ok: true, available: true })),
    onUpdate: (cb) => { update = cb; cb(current); return off; },
  };
  return { client, off, update: (services: DiscoveredService[]) => { current = services; update(services); } };
}
let resolver: ServerEndpointResolver | undefined;
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); });
afterEach(() => {
  resolver?.dispose(); resolver = undefined;
  setServerTransportEndpoint(publicUrl, publicUrl);
  vi.useRealTimers(); vi.unstubAllGlobals();
  delete (window as any).Capacitor;
  delete (window as any).CapacitorWebFetch;
});

describe("verified mobile endpoint selection", () => {
  it("learns identity from a reachable configured endpoint and keeps that route", async () => {
    const lan = discovery();
    resolver = new ServerEndpointResolver(publicUrl, lan.client, vi.fn(async (url) => result(url)));
    await resolver.resolve(wifi);
    expect(getServerEndpointSnapshot(publicUrl)).toMatchObject({ endpointUrl: publicUrl, serverInstanceId: "instance-1" });
    expect(lan.client.start).not.toHaveBeenCalled();
  });

  it("switches only to the same instance and preserves logical account, token, offline scope and proxy paths", async () => {
    Object.assign(window, { Capacitor: { isNativePlatform: () => true } });
    localStorage.setItem("nowen-server-url", publicUrl);
    const token = `header.${btoa(JSON.stringify({ userId: "alice" }))}.signature`;
    localStorage.setItem("nowen-token", token);
    const scope = getOfflineQueueStorageKey();
    rememberServerInstanceId(publicUrl, "instance-1");
    const lan = discovery();
    resolver = new ServerEndpointResolver(publicUrl, lan.client,
      vi.fn(async (url) => url === publicUrl ? null : result(url, "instance-1", "public-concat")));
    await resolver.resolve(wifi);
    expect(getServerEndpointSnapshot(publicUrl)).toMatchObject({ endpointUrl: lanUrl, kind: "lan", name: "NAS" });
    expect(getConfiguredApiBaseUrl(publicUrl)).toBe(`${publicUrl}/api`);
    expect(getResolvedApiBaseUrl(publicUrl)).toBe(`${lanUrl}/publicapi`);
    expect(getResolvedWebSocketUrl(publicUrl)).toBe("ws://192.168.1.10:3001/publicws");
    expect(localStorage.getItem("nowen-server-url")).toBe(publicUrl);
    expect(localStorage.getItem("nowen-token")).toBe(token);
    expect(getOfflineQueueStorageKey()).toBe(scope);
    expect(lan.off).toHaveBeenCalledOnce();
    await resolver.resolve(cellular);
    expect(getResolvedApiBaseUrl(publicUrl)).toBe(`${publicUrl}/api`);
    expect(lan.client.start).toHaveBeenCalledOnce();
  });

  it.each(["another-instance", null])("rejects LAN identity %s without learning it", async (id) => {
    vi.useFakeTimers();
    rememberServerInstanceId(publicUrl, "instance-1");
    const lan = discovery();
    resolver = new ServerEndpointResolver(publicUrl, lan.client, vi.fn(async (url) => url === publicUrl ? null : result(url, id)));
    const pending = resolver.resolve(wifi);
    await vi.advanceTimersByTimeAsync(5000);
    await pending;
    expect(getServerEndpointSnapshot(publicUrl)).toMatchObject({ endpointUrl: publicUrl, serverInstanceId: "instance-1" });
    expect(lan.off).toHaveBeenCalledOnce();
  });

  it("never establishes first trust from discovery, or overwrites a pinned identity", async () => {
    const lan = discovery();
    const probe = vi.fn(async (url: string) => url === publicUrl ? null : result(url));
    resolver = new ServerEndpointResolver(publicUrl, lan.client, probe);
    await resolver.resolve(wifi);
    expect(lan.client.start).not.toHaveBeenCalled();
    expect(getServerEndpointSnapshot(publicUrl).serverInstanceId).toBeNull();
    rememberServerInstanceId(publicUrl, "instance-1");
    probe.mockImplementation(async (url) => result(url, "new-instance"));
    await resolver.resolve(wifi);
    expect(getServerEndpointSnapshot(publicUrl).serverInstanceId).toBe("instance-1");
  });

  it("rediscovers a changed LAN IP instead of persisting the previous route", async () => {
    rememberServerInstanceId(publicUrl, "instance-1");
    const lan = discovery();
    resolver = new ServerEndpointResolver(publicUrl, lan.client, vi.fn(async (url) => url === publicUrl ? null : result(url)));
    await resolver.resolve(wifi);
    lan.update([service("192.168.1.20")]);
    await resolver.resolve(wifi);
    expect(getServerEndpointSnapshot(publicUrl).endpointUrl).toBe("http://192.168.1.20:3001");
    expect(lan.client.start).toHaveBeenCalledTimes(2);
    resolver.dispose();
    expect(getServerEndpointSnapshot(publicUrl).endpointUrl).toBe(publicUrl);
  });

  it("does not commit a late Wi-Fi result after switching to cellular", async () => {
    rememberServerInstanceId(publicUrl, "instance-1");
    const lan = discovery();
    let complete!: (value: ReturnType<typeof result>) => void;
    const probe = vi.fn((url: string) => url === publicUrl ? Promise.resolve(null)
      : new Promise<ReturnType<typeof result>>((resolve) => { complete = resolve; }));
    resolver = new ServerEndpointResolver(publicUrl, lan.client, probe);
    const old = resolver.resolve(wifi);
    for (let i = 0; i < 4; i++) await Promise.resolve();
    expect(complete).toBeTypeOf("function");
    await resolver.resolve(cellular);
    complete(result(lanUrl));
    await old;
    await Promise.resolve();
    expect(getServerEndpointSnapshot(publicUrl).endpointUrl).toBe(publicUrl);
    expect(lan.off).toHaveBeenCalledOnce();
  });

  it("disabling automatic selection or losing connectivity immediately restores the configured route", async () => {
    rememberServerInstanceId(publicUrl, "instance-1");
    const lan = discovery();
    resolver = new ServerEndpointResolver(publicUrl, lan.client, vi.fn(async (url) => url === publicUrl ? null : result(url)));
    await resolver.resolve(wifi);
    setAutomaticServerEndpoint(publicUrl, false);
    expect(getServerEndpointSnapshot(publicUrl)).toMatchObject({ endpointUrl: publicUrl, automatic: false });
    await resolver.resolve(wifi);
    expect(lan.client.start).toHaveBeenCalledOnce();
    setAutomaticServerEndpoint(publicUrl, true);
    await resolver.resolve(wifi);
    await resolver.resolve({ connected: false, connectionType: "none" });
    expect(getServerEndpointSnapshot(publicUrl).endpointUrl).toBe(publicUrl);
  });
});

describe("unauthenticated endpoint probing", () => {
  it("bypasses Capacitor's native GET proxy to enforce cookie omission and redirect refusal", async () => {
    const patched = vi.fn(); vi.stubGlobal("fetch", patched);
    const original = vi.fn(async () => new Response(JSON.stringify({ appVersion: "1.5.1", serverInstanceId: "instance-1" })));
    (window as any).CapacitorWebFetch = original;
    expect((await probeServerEndpoint(lanUrl))?.serverInstanceId).toBe("instance-1");
    expect(patched).not.toHaveBeenCalled();
    expect(original).toHaveBeenCalledWith(`${lanUrl}/api/version`, expect.objectContaining({ credentials: "omit", redirect: "error" }));
  });
  it("uses existing proxy candidates without leaking credentials or following redirects", async () => {
    const fetchMock = vi.fn(async (url: string) => new Response(url.endsWith("/publicapi/version")
      ? JSON.stringify({ appVersion: "1.5.1", serverInstanceId: "instance-1" }) : "missing", { status: url.endsWith("/publicapi/version") ? 200 : 404 }));
    vi.stubGlobal("fetch", fetchMock);
    const endpoint = await probeServerEndpoint(publicUrl);
    expect(endpoint?.connection.apiBaseUrl).toBe(`${publicUrl}/publicapi`);
    for (const [, options] of fetchMock.mock.calls as unknown as [string, RequestInit][]) {
      expect(options).toMatchObject({ credentials: "omit", redirect: "error", cache: "no-store", headers: { Accept: "application/json" } });
      expect(new Headers(options.headers).has("Authorization")).toBe(false);
    }
  });

  it("bounds an unreachable public endpoint probe so local fallback can run", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    })));
    const pending = probeServerEndpoint(publicUrl);
    await vi.advanceTimersByTimeAsync(2500);
    expect(await pending).toBeNull();
  });

  it("does not treat an unrelated JSON service as Nowen Note", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ serverInstanceId: "instance-1" }))));
    expect(await probeServerEndpoint(lanUrl)).toBeNull();
  });

  it("accepts LAN/mDNS candidates and proxy prefixes but excludes public IPs and loopback", () => {
    expect(discoveredServerEndpoints({ ...service(), host: "nas.local", addresses: ["8.8.8.8", "127.0.0.1", "fd00::1"], txt: { https: "1", path: "/notes" } }))
      .toEqual(["https://192.168.1.10:3001/notes", "https://[fd00::1]:3001/notes", "https://nas.local:3001/notes"]);
    expect(discoveredServerEndpoints({ ...service(), port: 0 })).toEqual([]);
  });
});
