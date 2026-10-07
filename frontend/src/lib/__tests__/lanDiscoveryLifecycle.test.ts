import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ watch: vi.fn(async () => "callback"), unwatch: vi.fn(async () => {}) }));
vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => true } }));
vi.mock("@mhaberler/capacitor-zeroconf-nsd", () => ({ ZeroConf: mocks }));
beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); mocks.watch.mockImplementation(async () => "callback"); delete (window as any).nowenDesktop; });
afterEach(() => { vi.restoreAllMocks(); });
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
describe("shared LAN discovery lifecycle", () => {
  it("keeps native discovery running until both UI and resolver unsubscribe", async () => {
    const { getLanDiscovery } = await import("../lanDiscovery");
    const client = getLanDiscovery();
    const ui = client.onUpdate(() => {}); const resolver = client.onUpdate(() => {});
    await client.start(); ui(); await flush();
    expect(mocks.unwatch).not.toHaveBeenCalled();
    resolver(); await flush(); expect(mocks.unwatch).toHaveBeenCalledOnce();
  });
  it("stops a delayed native watch after its last subscriber times out", async () => {
    let complete!: (value: string) => void;
    mocks.watch.mockImplementation(() => new Promise<string>((resolve) => { complete = resolve; }));
    const { getLanDiscovery } = await import("../lanDiscovery");
    const client = getLanDiscovery(); const off = client.onUpdate(() => {});
    const pending = client.start(); await flush(); off(); complete("callback"); await pending; await flush();
    expect(mocks.unwatch).toHaveBeenCalledOnce();
  });
  it("also reference counts the Electron discovery bridge", async () => {
    const stop = vi.fn();
    (window as any).nowenDesktop = { discovery: { start: async () => ({ ok: true, available: true }), stop, onUpdate: () => vi.fn() } };
    const { getLanDiscovery } = await import("../lanDiscovery");
    const client = getLanDiscovery(); const ui = client.onUpdate(() => {}); const resolver = client.onUpdate(() => {});
    await client.start(); ui(); expect(stop).not.toHaveBeenCalled(); resolver(); expect(stop).toHaveBeenCalledOnce();
  });
});
