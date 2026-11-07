import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ watch: vi.fn(async () => "callback"), unwatch: vi.fn(async () => {}) }));
vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => true } }));
vi.mock("@mhaberler/capacitor-zeroconf-nsd", () => ({ ZeroConf: mocks }));
beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); mocks.watch.mockImplementation(async () => "callback"); });
afterEach(() => { vi.restoreAllMocks(); });
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
describe("LAN discovery lifecycle", () => {
  it("keeps native discovery running until every subscriber unsubscribes", async () => {
    const { getLanDiscovery } = await import("../lanDiscovery");
    const client = getLanDiscovery();
    const first = client.onUpdate(() => {}); const second = client.onUpdate(() => {});
    await client.start(); first(); await flush();
    expect(mocks.unwatch).not.toHaveBeenCalled();
    second(); await flush(); expect(mocks.unwatch).toHaveBeenCalledOnce();
  });
  it("stops a delayed native watch after its last subscriber times out", async () => {
    let complete!: (value: string) => void;
    mocks.watch.mockImplementation(() => new Promise<string>((resolve) => { complete = resolve; }));
    const { getLanDiscovery } = await import("../lanDiscovery");
    const client = getLanDiscovery(); const off = client.onUpdate(() => {});
    const pending = client.start(); await flush(); off(); complete("callback"); await pending; await flush();
    expect(mocks.unwatch).toHaveBeenCalledOnce();
  });
});
