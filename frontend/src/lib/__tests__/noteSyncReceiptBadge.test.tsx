// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ receipt: vi.fn() }));
vi.mock("@/lib/useSyncIndicator", () => ({
  useSyncIndicator: () => ({ syncEnabled: true, state: "synced", conflictCount: 0, pendingMutations: 0 }),
}));
vi.mock("@/lib/useNoteSyncReceipt", () => ({ useNoteSyncReceipt: mocks.receipt }));
vi.mock("@/lib/mobileLocalMode", () => ({ isAndroidNativeRuntime: () => false }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
import SyncStatusBadge from "@/components/SyncStatusBadge";
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  mocks.receipt.mockReset().mockReturnValue("unverified");
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });
describe("per-note editor sync receipt", () => {
  it("never uses global synced state to claim a note has cloud confirmation", async () => {
    await act(async () => root.render(<SyncStatusBadge noteId="note-a" />));
    expect(mocks.receipt).toHaveBeenCalledWith("note-a", true);
    expect(host.textContent).toBe("syncBadge.receipt.unverified");
    expect(host.textContent).not.toContain("syncBadge.state.synced");
    mocks.receipt.mockReturnValue("confirmed");
    await act(async () => root.render(<SyncStatusBadge noteId="note-a" />));
    expect(host.textContent).toBe("syncBadge.receipt.confirmed");
  });
  it("shows a saving state without claiming cloud ACK", async () => {
    mocks.receipt.mockReturnValue("confirmed");
    await act(async () => root.render(<SyncStatusBadge noteId="note-a" saving />));
    expect(host.textContent).toBe("syncBadge.receipt.saving");
  });
});
