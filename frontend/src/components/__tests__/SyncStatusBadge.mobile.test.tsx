import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SyncStatusBadge from "../SyncStatusBadge";
import { MOBILE_SYNC_STATUS_CHANGED_EVENT } from "@/lib/mobileSyncStatus";
const mocks = vi.hoisted(() => ({ settings: vi.fn(), diagnostics: vi.fn() }));
vi.mock("@/lib/syncLocalApi", () => ({
  fetchSyncSettings: mocks.settings, fetchSyncDiagnostics: mocks.diagnostics, SyncV2DisabledError: class extends Error {},
}));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLElement;
let pending = 0, attachments = 0;
const render = async (saving = false) => { await act(async () => root.render(<SyncStatusBadge saving={saving} />)); };
beforeEach(() => {
  pending = 0; attachments = 0;
  Object.assign(window, { Capacitor: { isNativePlatform: () => true, getPlatform: () => "android" } });
  mocks.settings.mockResolvedValue({ mode: "server" });
  mocks.diagnostics.mockImplementation(async () => ({ pendingMutations: pending, pendingAttachments: attachments, conflictCount: 0, lastError: null, lastSyncAt: "2026-10-07T00:00:00Z" }));
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); Reflect.deleteProperty(window,"Capacitor"); });
describe("Android lightweight editor sync status", () => {
  it("shows synced text on phones and refreshes pending work after local save and ACK", async () => {
    await render(); expect(host.textContent).toBe("已同步");
    expect(host.querySelector(".hidden")).toBeNull();
    await render(true); expect(host.textContent).toBe("");
    pending = 2; await render(false); expect(host.textContent).toBe("待同步 2");
    pending = 0;
    await act(async () => window.dispatchEvent(new Event(MOBILE_SYNC_STATUS_CHANGED_EVENT)));
    expect(host.textContent).toBe("已同步");
  });
  it("waits for attachment bytes even when entity mutations have been acknowledged", async () => {
    attachments = 1; await render(); expect(host.textContent).toBe("待同步 1");
  });
  it("hides sync UI for the independent device-only space", async () => {
    mocks.settings.mockResolvedValue({ mode: "device-only" }); await render();
    expect(host.textContent).toBe("");
  });
  it("preserves the quiet synced state on web", async () => {
    Reflect.deleteProperty(window,"Capacitor"); await render(); expect(host.textContent).toBe("");
  });
});
