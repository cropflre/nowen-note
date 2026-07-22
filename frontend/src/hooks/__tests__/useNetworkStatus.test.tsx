import React, { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  queueLength: 0,
  queueSubscribers: new Set<(count: number) => void>(),
  syncNow: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  getBaseUrl: () => "http://127.0.0.1:3000",
}));

vi.mock("@/lib/offlineQueue", () => ({
  getQueueLength: () => mocks.queueLength,
  subscribe: (listener: (count: number) => void) => {
    mocks.queueSubscribers.add(listener);
    return () => mocks.queueSubscribers.delete(listener);
  },
}));

vi.mock("@/lib/syncEngine", () => ({
  syncNow: () => mocks.syncNow(),
}));

import {
  shouldSignalRecoveredOfflineChanges,
  useNetworkStatus,
} from "@/hooks/useNetworkStatus";

type NetworkSnapshot = ReturnType<typeof useNetworkStatus>;

function setOnline(value: boolean) {
  Object.defineProperty(window.navigator, "onLine", {
    configurable: true,
    value,
  });
}

function setVisibility(value: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value,
  });
}

function emitQueue(count: number) {
  mocks.queueLength = count;
  for (const listener of mocks.queueSubscribers) listener(count);
}

function Harness({ onSnapshot }: { onSnapshot: (snapshot: NetworkSnapshot) => void }) {
  const snapshot = useNetworkStatus();
  useEffect(() => {
    onSnapshot(snapshot);
  }, [onSnapshot, snapshot.flush, snapshot.isOnline, snapshot.pendingCount, snapshot.wasOffline]);
  return null;
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("useNetworkStatus recovery semantics", () => {
  let root: Root;
  let container: HTMLDivElement;
  let snapshot: NetworkSnapshot | null;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.useFakeTimers();
    mocks.queueLength = 0;
    mocks.queueSubscribers.clear();
    mocks.syncNow.mockReset();
    mocks.syncNow.mockResolvedValue({ ok: true, pending: 0, versionConflicts: 0 });
    setOnline(true);
    setVisibility("visible");

    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    snapshot = null;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<Harness onSnapshot={(value) => { snapshot = value; }} />);
    });
    await settle();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("keeps a normal tab visibility return silent and avoids an empty sync", async () => {
    expect(snapshot?.isOnline).toBe(true);
    expect(snapshot?.wasOffline).toBe(false);
    expect(mocks.syncNow).not.toHaveBeenCalled();

    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await settle();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(snapshot?.wasOffline).toBe(false);
    expect(mocks.syncNow).not.toHaveBeenCalled();
  });

  it("signals once only after real offline changes are successfully synchronized", async () => {
    setOnline(false);
    await act(async () => {
      window.dispatchEvent(new Event("offline"));
    });
    await settle();
    expect(snapshot?.isOnline).toBe(false);

    await act(async () => emitQueue(2));
    mocks.syncNow.mockImplementationOnce(async () => {
      emitQueue(0);
      return { ok: true, pending: 0, versionConflicts: 0 };
    });

    setOnline(true);
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    await settle();

    expect(mocks.syncNow).toHaveBeenCalledTimes(1);
    expect(snapshot?.pendingCount).toBe(0);
    expect(snapshot?.wasOffline).toBe(true);

    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await settle();
    expect(mocks.syncNow).toHaveBeenCalledTimes(1);
    expect(snapshot?.wasOffline).toBe(true);

    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });
    expect(snapshot?.wasOffline).toBe(false);
  });

  it("stays silent when the network recovers without offline edits", async () => {
    setOnline(false);
    await act(async () => {
      window.dispatchEvent(new Event("offline"));
    });
    await settle();

    setOnline(true);
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    await settle();

    expect(snapshot?.isOnline).toBe(true);
    expect(snapshot?.wasOffline).toBe(false);
    expect(mocks.syncNow).not.toHaveBeenCalled();
  });

  it("does not signal success when syncNow returns ok=false", async () => {
    setOnline(false);
    await act(async () => {
      window.dispatchEvent(new Event("offline"));
      emitQueue(1);
    });
    await settle();

    mocks.syncNow.mockImplementationOnce(async () => {
      emitQueue(0);
      return { ok: false, pending: 0, versionConflicts: 0, error: "snapshot failed" };
    });
    setOnline(true);
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    await settle();

    expect(mocks.syncNow).toHaveBeenCalledTimes(1);
    expect(snapshot?.pendingCount).toBe(0);
    expect(snapshot?.wasOffline).toBe(false);
  });

  it("coalesces concurrent visibility probes", async () => {
    let resolveProbe: ((value: { ok: boolean; status: number }) => void) | null = null;
    fetchMock.mockImplementationOnce(() => new Promise((resolve) => {
      resolveProbe = resolve;
    }));

    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      document.dispatchEvent(new Event("visibilitychange"));
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => {
      resolveProbe?.({ ok: true, status: 200 });
      await Promise.resolve();
    });
    await settle();

    expect(snapshot?.wasOffline).toBe(false);
    expect(mocks.syncNow).not.toHaveBeenCalled();
  });
});

describe("shouldSignalRecoveredOfflineChanges", () => {
  it("requires a real offline cycle, queued changes, a successful flush, and an empty queue", () => {
    expect(shouldSignalRecoveredOfflineChanges({
      wasActuallyOffline: true,
      pendingBefore: 2,
      pendingAfter: 0,
      flushSucceeded: true,
    })).toBe(true);

    expect(shouldSignalRecoveredOfflineChanges({
      wasActuallyOffline: false,
      pendingBefore: 2,
      pendingAfter: 0,
      flushSucceeded: true,
    })).toBe(false);
    expect(shouldSignalRecoveredOfflineChanges({
      wasActuallyOffline: true,
      pendingBefore: 0,
      pendingAfter: 0,
      flushSucceeded: true,
    })).toBe(false);
    expect(shouldSignalRecoveredOfflineChanges({
      wasActuallyOffline: true,
      pendingBefore: 2,
      pendingAfter: 1,
      flushSucceeded: true,
    })).toBe(false);
    expect(shouldSignalRecoveredOfflineChanges({
      wasActuallyOffline: true,
      pendingBefore: 2,
      pendingAfter: 0,
      flushSucceeded: false,
    })).toBe(false);
  });
});
