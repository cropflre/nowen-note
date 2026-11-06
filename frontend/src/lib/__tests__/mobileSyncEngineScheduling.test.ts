import { afterEach, describe, expect, it, vi } from "vitest";
import { MobileSyncEngine } from "../mobileSyncEngine";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

function startedEngine() {
  const syncOnce = vi.spyOn(MobileSyncEngine.prototype, "syncOnce").mockResolvedValue(undefined);
  const engine = new MobileSyncEngine({} as never);
  engine.start();
  return { engine, syncOnce };
}

describe("native Pull wake scheduling", () => {
  it("does not let a slower retry postpone a pending notice wake", async () => {
    vi.useFakeTimers();
    const { engine, syncOnce } = startedEngine();
    await vi.advanceTimersByTimeAsync(0);
    syncOnce.mockClear();
    engine.requestSync(150);
    engine.requestSync(30_000);
    await vi.advanceTimersByTimeAsync(200);
    expect(syncOnce).toHaveBeenCalledOnce();
    engine.stop();
  });

  it("is not starved by a continuous stream of notices", async () => {
    vi.useFakeTimers();
    const { engine, syncOnce } = startedEngine();
    await vi.advanceTimersByTimeAsync(0);
    syncOnce.mockClear();
    for (let i = 0; i < 10; i++) {
      engine.requestSync(150);
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(syncOnce.mock.calls.length).toBeGreaterThanOrEqual(5);
    engine.stop();
  });

  it("still moves a pending slow retry earlier when a notice arrives", async () => {
    vi.useFakeTimers();
    const { engine, syncOnce } = startedEngine();
    await vi.advanceTimersByTimeAsync(0);
    syncOnce.mockClear();
    engine.requestSync(30_000);
    engine.requestSync(150);
    await vi.advanceTimersByTimeAsync(200);
    expect(syncOnce).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(syncOnce).toHaveBeenCalledOnce();
    engine.stop();
  });

  it("schedules nothing after stop", async () => {
    vi.useFakeTimers();
    const { engine, syncOnce } = startedEngine();
    await vi.advanceTimersByTimeAsync(0);
    syncOnce.mockClear();
    engine.requestSync(150);
    engine.stop();
    engine.requestSync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(syncOnce).not.toHaveBeenCalled();
  });
});
