import { afterEach, describe, expect, it, vi } from "vitest";
import { installMobileSyncRealtime } from "../mobileSyncRealtime";
import type { MobileSyncEngine } from "../mobileSyncEngine";

const mocks = vi.hoisted(() => ({ enabled: true, listeners: new Map<string, () => void>(), connect: vi.fn() }));
vi.mock("../realtime", () => ({ realtime: {
  connect: mocks.connect,
  on: (event: string, callback: () => void) => { mocks.listeners.set(event, callback); return () => mocks.listeners.delete(event); },
} }));
vi.mock("../mobileSyncStatus", () => ({ isMobileSyncEnabled: () => mocks.enabled }));
afterEach(() => { vi.useRealTimers(); mocks.listeners.clear(); mocks.enabled = true; mocks.connect.mockClear(); });

describe("native notification and fallback Pull scheduling", () => {
  it("wakes the same engine on notice, reconnect, foreground and missing-notice poll", async () => {
    vi.useFakeTimers();
    const requestSync = vi.fn();
    const dispose = installMobileSyncRealtime({ requestSync } as unknown as MobileSyncEngine);
    mocks.listeners.get("sync.changed")!(); mocks.listeners.get("open")!();
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(requestSync).toHaveBeenCalledTimes(4);
    expect(requestSync).toHaveBeenLastCalledWith(150);
    expect(mocks.connect).toHaveBeenCalledOnce();
    dispose();
    await vi.advanceTimersByTimeAsync(60_000);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(requestSync).toHaveBeenCalledTimes(4);
    expect(mocks.listeners.size).toBe(0);
  });
  it("does not synchronize or connect while the user has disabled sync", async () => {
    vi.useFakeTimers(); mocks.enabled = false;
    const requestSync = vi.fn();
    const dispose = installMobileSyncRealtime({ requestSync } as unknown as MobileSyncEngine);
    mocks.listeners.get("sync.changed")!();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(requestSync).not.toHaveBeenCalled(); expect(mocks.connect).not.toHaveBeenCalled();
    dispose();
  });
});
