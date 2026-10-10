import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MobileSyncEngine } from "../mobileSyncEngine";
import { setServerTransportEndpoint } from "../serverEndpointState";
import { buildServerPathCandidates, cacheResolvedServerConnection, clearResolvedServerConnection } from "../serverUrl";

const url = "https://notes.example.com";
const lan = "http://192.168.1.10:3001";
function createEngine(options: { beforeSync?: () => Promise<void>; onNetworkUnavailable?: () => void } = {}) {
  const db = { query: vi.fn(async () => []), run: vi.fn(), transaction: vi.fn() };
  const engine = new MobileSyncEngine({ db: db as never, attachments: {} as never, serverUrl: url,
    token: "same-token", userId: "alice", profileId: "same-profile", deviceId: "same-device", ...options });
  const internal = engine as unknown as { request: (path: string) => Promise<unknown>; fetchResponse: (path: string, options?: RequestInit) => Promise<Response> };
  return { engine, internal, db };
}
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); });
afterEach(() => {
  setServerTransportEndpoint(url, url);
  clearResolvedServerConnection();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("mobile sync transport rerouting", () => {
  it("renews the expired sync token through the same NodeBao proxy API prefix", async () => {
    const proxy = "https://nodebao.example.net/user:3001";
    const connection = buildServerPathCandidates(proxy).find((candidate) => candidate.mode === "public-concat")!;
    cacheResolvedServerConnection(connection);
    localStorage.setItem("nowen-token", "same-token");
    localStorage.setItem("nowen-refresh-token", "refresh-token");
    const requests: Array<{ url: string; auth: string | null }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string, init: RequestInit = {}) => {
      const auth = new Headers(init.headers).get("Authorization");
      requests.push({ url: String(input), auth });
      if (String(input).endsWith("/auth/refresh")) {
        return new Response(JSON.stringify({ token: "new-token" }), { status: 200 });
      }
      if (auth === "Bearer same-token") {
        return new Response(JSON.stringify({ error: "expired" }), { status: 401 });
      }
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    }));
    const db = { query: vi.fn(), run: vi.fn(), transaction: vi.fn() };
    const engine = new MobileSyncEngine({
      db: db as never, attachments: {} as never, serverUrl: proxy,
      token: "same-token", userId: "alice", profileId: "profile", deviceId: "device",
    });
    const internal = engine as unknown as { request: (path: string) => Promise<unknown> };
    expect(await internal.request("/scopes")).toEqual({ items: [] });
    expect(requests).toEqual([
      { url: `${connection.apiBaseUrl}/sync/v2/scopes`, auth: "Bearer same-token" },
      { url: `${connection.apiBaseUrl}/auth/refresh`, auth: null },
      { url: `${connection.apiBaseUrl}/sync/v2/scopes`, auth: "Bearer new-token" },
    ]);
    expect(localStorage.getItem("nowen-token")).toBe("new-token");
  });

  it("blocks cross-account outbox requests during session reconfiguration", async () => {
    const { internal } = createEngine();
    localStorage.setItem("nowen-token", "different-user");
    const mock = vi.fn(); vi.stubGlobal("fetch", mock);
    await expect(internal.request("/scopes")).rejects.toMatchObject({ code: "AUTH_SESSION_CHANGED" });
    expect(mock).not.toHaveBeenCalled();
  });

  it("releases sync even if native POST ignores AbortSignal and returns a late response", async () => {
    vi.useFakeTimers();
    const { internal } = createEngine();
    let complete!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { complete = resolve; })));
    const pending = internal.fetchResponse("/push", { method: "POST", body: "{}" });
    const rejected = expect(pending).rejects.toMatchObject({ code: "NETWORK_UNAVAILABLE" });
    await vi.advanceTimersByTimeAsync(15000);
    await rejected;
    complete(new Response("{}")); await Promise.resolve();
  });
  it("routes metadata and blobs with the same token without modifying local sync state", async () => {
    const { internal, db } = createEngine();
    const fetchMock = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);
    await internal.request("/scopes");
    setServerTransportEndpoint(url, lan);
    await internal.request("/scopes");
    await internal.fetchResponse("/blob/a?scopeKey=personal", { method: "PUT", body: new Blob(["hello"]), headers: { "Content-Type": "text/plain" } });
    expect(fetchMock.mock.calls.map((args) => (args as unknown[])[0])).toEqual([
      `${url}/api/sync/v2/scopes`, `${lan}/api/sync/v2/scopes`, `${lan}/api/sync/v2/blob/a?scopeKey=personal`,
    ]);
    for (const [, options] of fetchMock.mock.calls as unknown as [string, RequestInit][]) {
      expect(new Headers(options.headers).get("Authorization")).toBe("Bearer same-token");
    }
    expect(db.query).not.toHaveBeenCalled(); expect(db.run).not.toHaveBeenCalled(); expect(db.transaction).not.toHaveBeenCalled();
  });

  it("aborts an in-flight request on endpoint change and retries on the new route", async () => {
    const recover = vi.fn();
    const { internal } = createEngine({ onNetworkUnavailable: recover });
    vi.stubGlobal("fetch", vi.fn((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    })));
    const pending = internal.request("/scopes");
    setServerTransportEndpoint(url, lan);
    await expect(pending).rejects.toMatchObject({ code: "NETWORK_UNAVAILABLE" });
    expect(recover).toHaveBeenCalledOnce();
    const fetchMock = vi.fn(async () => new Response("{}")); vi.stubGlobal("fetch", fetchMock);
    await internal.request("/scopes");
    expect(fetchMock).toHaveBeenCalledWith(`${lan}/api/sync/v2/scopes`, expect.anything());
  });

  it("waits for routing before fetching scopes, and keeps local state when the network fails", async () => {
    vi.useFakeTimers();
    let complete!: () => void;
    const gate = new Promise<void>((resolve) => { complete = resolve; });
    const { engine, db } = createEngine({ beforeSync: () => gate });
    const fetchMock = vi.fn(async () => { throw new TypeError("offline"); }); vi.stubGlobal("fetch", fetchMock);
    engine.start();
    const pending = engine.syncOnce();
    await Promise.resolve(); expect(fetchMock).not.toHaveBeenCalled();
    complete(); await pending;
    engine.stop();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(db.run).not.toHaveBeenCalled(); expect(db.transaction).not.toHaveBeenCalled();
  });

  it("does not resume synchronization if disabled during endpoint selection", async () => {
    vi.useFakeTimers();
    let complete!: () => void;
    const gate = new Promise<void>((resolve) => { complete = resolve; });
    const { engine, db } = createEngine({ beforeSync: () => gate });
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    engine.start();
    const pending = engine.syncOnce();
    engine.stop(); complete(); await pending;
    await vi.advanceTimersByTimeAsync(15000);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.run).not.toHaveBeenCalled(); expect(db.transaction).not.toHaveBeenCalled();
  });
});
