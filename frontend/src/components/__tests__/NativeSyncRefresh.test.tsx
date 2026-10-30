import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import OfflineSyncRuntime from "../OfflineSyncRuntime";
import { MOBILE_SYNC_APPLIED_EVENT } from "@/lib/mobileSyncStatus";

const actions = vi.hoisted(() => ({ refreshNotes: vi.fn(), refreshNotebooks: vi.fn(), setTags: vi.fn() }));
const legacy = vi.hoisted(() => ({ useNetworkStatus: vi.fn(), syncAttachments: vi.fn() }));
vi.mock("@/store/AppContext", () => ({ useAppActions: () => actions }));
vi.mock("@/lib/api", () => ({ api: { getTags: async () => [] } }));
vi.mock("@/lib/mobileLocalMode", () => ({ isAndroidNativeRuntime: () => true }));
vi.mock("@/hooks/useNetworkStatus", () => ({ useNetworkStatus: legacy.useNetworkStatus }));
vi.mock("@/lib/offlineAttachmentRecovery", () => ({ installOfflineAttachmentRecoveryCapture: legacy.syncAttachments }));
vi.mock("@/lib/syncEngine", () => ({ SYNC_SNAPSHOT_APPLIED_EVENT: "legacy-snapshot" }));

it("refreshes native lists and tree after Apply without starting a second sync engine", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div");
  const root = createRoot(host);
  const treeChanged = vi.fn();
  window.addEventListener("nowen:knowledge-tree-changed", treeChanged);
  try {
    await act(async () => root.render(<OfflineSyncRuntime />));
    expect(legacy.useNetworkStatus).not.toHaveBeenCalled();
    expect(legacy.syncAttachments).not.toHaveBeenCalled();
    expect(actions.refreshNotes).not.toHaveBeenCalled();
    await act(async () => { window.dispatchEvent(new CustomEvent(MOBILE_SYNC_APPLIED_EVENT)); });
    expect(actions.refreshNotes).toHaveBeenCalledOnce();
    expect(actions.refreshNotebooks).toHaveBeenCalledOnce();
    expect(actions.setTags).toHaveBeenCalledWith([]);
    expect(treeChanged).toHaveBeenCalledOnce();
    await act(async () => root.unmount());
    window.dispatchEvent(new CustomEvent(MOBILE_SYNC_APPLIED_EVENT));
    expect(actions.refreshNotes).toHaveBeenCalledOnce();
  } finally { window.removeEventListener("nowen:knowledge-tree-changed", treeChanged); }
});
