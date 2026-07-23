// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/realtime", () => ({ realtime: {} }));
vi.mock("@/lib/syncEngine", () => ({
  SYNC_SNAPSHOT_APPLIED_EVENT: "sync-snapshot-applied",
  syncNow: vi.fn(),
}));

describe("workspace refresh button placement", () => {
  beforeEach(() => {
    vi.resetModules();
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
});
