import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NetworkPlugin } from "@capacitor/network";
import { rememberServerInstanceId, setAutomaticServerEndpoint } from "../serverEndpointState";

const mocks = vi.hoisted(() => ({ resolve: vi.fn(async (_status: unknown) => {}), dispose: vi.fn() }));
vi.mock("../serverEndpointResolver", () => ({ ServerEndpointResolver: class { resolve = mocks.resolve; dispose = mocks.dispose; } }));
vi.mock("../lanDiscovery", () => ({ getLanDiscovery: () => ({}) }));
import { createMobileServerEndpointRuntime } from "../mobileServerEndpointRuntime";
const url = "https://notes.example.com";
const wifi = { connected: true, connectionType: "wifi" as const };
const cellular = { connected: true, connectionType: "cellular" as const };
let runtime: ReturnType<typeof createMobileServerEndpointRuntime> | undefined;
beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); mocks.resolve.mockImplementation(async () => {}); });
afterEach(() => { runtime?.dispose(); runtime = undefined; vi.useRealTimers(); });
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

describe("mobile endpoint lifecycle", () => {
  it("waits for the newest selection if another network arrives during beforeSync", async () => {
    const complete: Array<() => void> = [];
    mocks.resolve.mockImplementation(() => new Promise<void>((resolve) => { complete.push(resolve); }));
    runtime = createMobileServerEndpointRuntime(url, { getStatus: async () => wifi } as NetworkPlugin, vi.fn());
    await flush();
    const sync = vi.fn(); const pending = runtime.beforeSync().then(sync);
    void runtime.networkChanged(cellular);
    complete[0](); await flush(); expect(sync).not.toHaveBeenCalled();
    complete[1](); await pending; expect(sync).toHaveBeenCalledOnce();
  });
  it("waits for selection before synchronization and resumes once ready", async () => {
    let complete!: () => void;
    mocks.resolve.mockImplementation(() => new Promise<void>((resolve) => { complete = resolve; }));
    const ready = vi.fn();
    runtime = createMobileServerEndpointRuntime(url, { getStatus: async () => wifi } as NetworkPlugin, ready);
    const sync = vi.fn();
    const pending = runtime.beforeSync().then(sync);
    await flush();
    expect(sync).not.toHaveBeenCalled();
    expect(ready).not.toHaveBeenCalled();
    complete(); await pending;
    expect(sync).toHaveBeenCalledOnce();
    expect(ready).toHaveBeenCalledOnce();
  });

  it("discards a stale initial network snapshot after a cellular event", async () => {
    let complete!: (status: typeof wifi) => void;
    runtime = createMobileServerEndpointRuntime(url, { getStatus: () => new Promise((resolve) => { complete = resolve; }) } as NetworkPlugin, vi.fn());
    await runtime.networkChanged(cellular);
    complete(wifi); await flush();
    expect(mocks.resolve).toHaveBeenCalledOnce();
    expect(mocks.resolve).toHaveBeenCalledWith(cellular);
  });

  it("reacts to automatic preference changes, while learning identity does not restart selection", async () => {
    runtime = createMobileServerEndpointRuntime(url, { getStatus: async () => wifi } as NetworkPlugin, vi.fn());
    await runtime.beforeSync();
    rememberServerInstanceId(url, "instance-1");
    expect(mocks.resolve).toHaveBeenCalledOnce();
    setAutomaticServerEndpoint(url, false);
    await runtime.beforeSync();
    expect(mocks.resolve).toHaveBeenCalledTimes(2);
  });

  it("bounds recovery retries and cancels pending recovery on disposal", async () => {
    vi.useFakeTimers();
    runtime = createMobileServerEndpointRuntime(url, { getStatus: async () => wifi } as NetworkPlugin, vi.fn());
    await runtime.beforeSync();
    runtime.recover(); runtime.recover();
    await vi.advanceTimersByTimeAsync(14999);
    expect(mocks.resolve).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.resolve).toHaveBeenCalledTimes(2);
    runtime.recover(); runtime.dispose();
    await vi.advanceTimersByTimeAsync(15000);
    expect(mocks.resolve).toHaveBeenCalledTimes(2);
  });

  it("does not resume sync after logout during a pending selection", async () => {
    let complete!: () => void;
    mocks.resolve.mockImplementation(() => new Promise<void>((resolve) => { complete = resolve; }));
    const ready = vi.fn();
    runtime = createMobileServerEndpointRuntime(url, { getStatus: async () => wifi } as NetworkPlugin, ready);
    await flush(); runtime.dispose(); complete(); await runtime.beforeSync();
    expect(ready).not.toHaveBeenCalled();
  });
});
