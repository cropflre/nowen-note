import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildServerPathCandidates,
  cacheResolvedServerConnection,
  clearResolvedServerConnection,
  getResolvedApiBaseUrl,
  getResolvedWebSocketUrl,
} from "../serverUrl";

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear() { values.clear(); },
    getItem(key: string) { return values.has(key) ? values.get(key)! : null; },
    key(index: number) { return Array.from(values.keys())[index] ?? null; },
    removeItem(key: string) { values.delete(key); },
    setItem(key: string, value: string) { values.set(key, String(value)); },
  };
}

describe("#771 resolved reverse-proxy path cache", () => {
  let storage: Storage;

  beforeEach(() => {
    storage = createMemoryStorage();
    vi.stubGlobal("localStorage", storage);
    clearResolvedServerConnection();
  });

  afterEach(() => {
    clearResolvedServerConnection();
    vi.unstubAllGlobals();
  });

  it("keeps compatibility paths isolated for multiple saved servers", () => {
    const first = buildServerPathCandidates("https://one.example.com/nowen")[1];
    const second = buildServerPathCandidates("https://two.example.com")[2];

    cacheResolvedServerConnection(first);
    cacheResolvedServerConnection(second);

    expect(getResolvedApiBaseUrl(first.serverBaseUrl)).toBe(first.apiBaseUrl);
    expect(getResolvedWebSocketUrl(first.serverBaseUrl)).toBe(first.websocketUrl);
    expect(getResolvedApiBaseUrl(second.serverBaseUrl)).toBe(second.apiBaseUrl);
    expect(getResolvedWebSocketUrl(second.serverBaseUrl)).toBe(second.websocketUrl);
  });

  it("allows API and WebSocket to resolve through different compatibility shapes", () => {
    const candidates = buildServerPathCandidates("https://mixed.example.com");
    const apiCandidate = candidates[1];
    const websocketCandidate = candidates[2];

    cacheResolvedServerConnection({
      ...apiCandidate,
      websocketUrl: websocketCandidate.websocketUrl,
      websocketPath: websocketCandidate.websocketPath,
    });

    expect(getResolvedApiBaseUrl(apiCandidate.serverBaseUrl)).toBe("https://mixed.example.com/public/api");
    expect(getResolvedWebSocketUrl(apiCandidate.serverBaseUrl)).toBe("wss://mixed.example.com/publicws");
  });

  it("migrates the old single-server cache without changing the resolved route", () => {
    const candidate = buildServerPathCandidates("https://legacy.example.com")[1];
    storage.setItem("nowen-resolved-server-connection-v1", JSON.stringify({
      ...candidate,
      resolvedAt: 123,
    }));

    expect(getResolvedApiBaseUrl(candidate.serverBaseUrl)).toBe(candidate.apiBaseUrl);
    expect(getResolvedWebSocketUrl(candidate.serverBaseUrl)).toBe(candidate.websocketUrl);
    expect(storage.getItem("nowen-resolved-server-connection-v1")).toBeNull();
    expect(storage.getItem("nowen-resolved-server-connections-v2")).toContain(candidate.serverBaseUrl);
  });
});
