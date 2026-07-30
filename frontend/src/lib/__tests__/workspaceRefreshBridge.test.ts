// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const realtimeHarness = vi.hoisted(() => {
  const listeners = new Map<string, (payload: unknown) => void>();
  const on = vi.fn((event: string, listener: (payload: unknown) => void) => {
    listeners.set(event, listener);
    return () => listeners.delete(event);
  });
  const emit = vi.fn((event: string, payload: unknown) => {
    listeners.get(event)?.(payload);
  });
  return { listeners, on, emit };
});

const syncHarness = vi.hoisted(() => ({ syncNow: vi.fn() }));

vi.mock("@/lib/realtime", () => ({
  realtime: { on: realtimeHarness.on, emit: realtimeHarness.emit },
}));
vi.mock("@/lib/syncEngine", () => ({
  SYNC_SNAPSHOT_APPLIED_EVENT: "sync-snapshot-applied",
  syncNow: syncHarness.syncNow,
}));

describe("workspace refresh button placement", () => {
  beforeEach(() => {
    vi.resetModules();
    realtimeHarness.listeners.clear();
    realtimeHarness.on.mockClear();
    realtimeHarness.emit.mockClear();
    syncHarness.syncNow.mockReset();
    syncHarness.syncNow.mockResolvedValue({ ok: true });
    localStorage.clear();
    document.body.innerHTML = `
      <div>
        <button data-nowen-notebook-sort type="button">sort</button>
        <button type="button"><svg class="lucide-panel-left-close"></svg></button>
      </div>`;
  });

  afterEach(() => {
    (window as Window & { __NOWEN_WORKSPACE_REFRESH_BRIDGE__?: () => void })
      .__NOWEN_WORKSPACE_REFRESH_BRIDGE__?.();
    document.body.innerHTML = "";
  });

  it("mounts immediately before the notebook sort button", async () => {
    await import("@/lib/workspaceRefreshBridge");

    const refresh = document.querySelector<HTMLButtonElement>("button[data-nowen-workspace-refresh]");
    const sort = document.querySelector<HTMLButtonElement>("button[data-nowen-notebook-sort]");

    expect(refresh).not.toBeNull();
    expect(refresh?.nextElementSibling).toBe(sort);
  });

  it("refreshes the knowledge tree when an import broadcasts notes:imported", async () => {
    const changed = vi.fn();
    window.addEventListener("nowen:knowledge-tree-changed", changed, { once: true });
    await import("@/lib/workspaceRefreshBridge");

    realtimeHarness.listeners.get("notes:imported")?.({ reason: "siyuan-import" });

    expect(changed).toHaveBeenCalledTimes(1);
    const event = changed.mock.calls[0][0] as CustomEvent<{ reason: string }>;
    expect(event.detail.reason).toBe("siyuan-import");
  });

  it("does not refresh the knowledge tree when a poll applies a sync snapshot", async () => {
    const changed = vi.fn();
    window.addEventListener("nowen:knowledge-tree-changed", changed);
    localStorage.setItem("nowen-token", "test-token");
    syncHarness.syncNow.mockImplementation(async () => {
      expect(document.querySelector("button[data-nowen-workspace-refresh]")?.getAttribute("aria-busy"))
        .not.toBe("true");
      window.dispatchEvent(new CustomEvent("sync-snapshot-applied"));
      return { ok: true };
    });
    const { refreshWorkspaceCollections } = await import("@/lib/workspaceRefreshBridge");

    await refreshWorkspaceCollections("poll", { force: true });

    expect(changed).not.toHaveBeenCalled();
    window.removeEventListener("nowen:knowledge-tree-changed", changed);
  });
});
