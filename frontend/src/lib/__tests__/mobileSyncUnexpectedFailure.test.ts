import { afterEach, describe, expect, it, vi } from "vitest";
import { MobileSyncEngine } from "../mobileSyncEngine";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Android native Sync V2 crash containment", () => {
  it("handles /scopes HTTP 401 before per-scope processing without deleting local writes", async () => {
    const db = {
      query: vi.fn().mockResolvedValue([]),
      run: vi.fn().mockResolvedValue({ changes: 1 }),
      transaction: vi.fn(),
    };
    const onAuthRequired = vi.fn();
    const engine = new MobileSyncEngine({
      db: db as never, attachments: {} as never, serverUrl: "https://notes.example.com",
      token: "expired", userId: "u1", profileId: "p1", deviceId: "d1", onAuthRequired,
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ code: "UNAUTHORIZED" }), { status: 401 }),
    ));
    engine.start();
    await engine.syncOnce();
    expect(onAuthRequired).toHaveBeenCalledOnce();
    expect(db.run).toHaveBeenCalledWith(
      "UPDATE sync_profiles SET authStatus='auth_required',updatedAt=? WHERE id=?",
      [expect.any(String), "p1"],
    );
    expect(db.transaction).not.toHaveBeenCalled();
    engine.stop();
    vi.unstubAllGlobals();
  });

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

    // Force an unexpected failure above the per-scope network-error handler.
    // Without this stub the test's missing network returns NETWORK_UNAVAILABLE,
    // which is intentionally swallowed by the production engine.
    const scopeRequest = vi.spyOn(
      engine as unknown as { fetchScopes: () => Promise<unknown[]> },
      "fetchScopes",
    ).mockRejectedValue(failure);
    engine.start();
    await vi.runOnlyPendingTimersAsync();

    expect(scopeRequest).toHaveBeenCalledOnce();
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
