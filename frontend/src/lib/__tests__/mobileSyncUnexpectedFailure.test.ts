import { afterEach, describe, expect, it, vi } from "vitest";
import { MobileSyncEngine } from "../mobileSyncEngine";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Android native Sync V2 crash containment", () => {
  it("captures an unexpected scheduled sync failure without advancing the cursor or dropping local changes", async () => {
    vi.useFakeTimers();
    const failure = new Error("SQLITE_BUSY");
    const db = {
      query: vi.fn().mockRejectedValue(failure),
      run: vi.fn().mockResolvedValue({ changes: 1 }),
      transaction: vi.fn(),
    };
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const engine = new MobileSyncEngine({
      db: db as never,
      attachments: {} as never,
      serverUrl: "https://notes.example.com",
      token: "test-token",
      userId: "u1",
      profileId: "p1",
      deviceId: "d1",
    });

    engine.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(log).toHaveBeenCalledWith(
      "[mobile-sync] unexpected background sync failure",
      failure,
    );
    expect(db.run).toHaveBeenCalledWith(
      "UPDATE sync_state SET lastError=? WHERE profileId=?",
      ["SYNC_RUNTIME_ERROR", "p1"],
    );
    expect(db.run).toHaveBeenCalledTimes(1);
    expect(db.transaction).not.toHaveBeenCalled();
    engine.stop();
  });

  it("does not relaunch a stopped sync after a pending timer", async () => {
    vi.useFakeTimers();
    const db = { query: vi.fn(), run: vi.fn(), transaction: vi.fn() };
    const engine = new MobileSyncEngine({
      db: db as never,
      attachments: {} as never,
      serverUrl: "https://notes.example.com",
      token: "test-token",
      userId: "u1",
      profileId: "p1",
      deviceId: "d1",
    });
    engine.start();
    engine.stop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(db.query).not.toHaveBeenCalled();
    expect(db.run).not.toHaveBeenCalled();
  });
});
