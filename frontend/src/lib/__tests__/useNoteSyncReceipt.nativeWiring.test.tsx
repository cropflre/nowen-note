// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MOBILE_SYNC_STATUS_CHANGED_EVENT } from "../mobileSyncStatus";

const mocks = vi.hoisted(() => ({
  fetchReceipt: vi.fn(),
}));
vi.mock("../mobileLocalMode", () => ({ isAndroidNativeRuntime: () => true }));
vi.mock("../syncLocalApi", () => ({ fetchNoteSyncReceipt: mocks.fetchReceipt }));
vi.mock("../offlineQueue", () => ({ getQueue: () => [], subscribe: () => () => undefined }));
vi.mock("../noteSyncReceipt", () => ({
  NOTE_SYNC_RECEIPT_CHANGED_EVENT: "nowen:note-receipt-changed",
  getNoteSyncReceipt: () => null, resolveNoteReceiptPhase: () => "unverified",
}));
vi.mock("../noteSyncSafety", () => ({ getNoteSyncConflict: () => null }));

import { useNoteSyncReceipt } from "../useNoteSyncReceipt";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
function ReceiptText({ noteId }: { noteId: string }) {
  const phase = useNoteSyncReceipt(noteId, true);
  return <span role="status">{phase}</span>;
}
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  mocks.fetchReceipt.mockReset();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
const reply = (phase: string) => ({
  phase, localRevision: null, acknowledgedRevision: phase === "confirmed" ? 3 : null,
});
describe("PR #821 current-note receipt UI after native Outbox commit", () => {
  it.each(["Markdown", "rich text"])("invalidates a stale confirmed snapshot for %s editing while ACK is delayed", async () => {
    let actualOutboxCount = 0;
    mocks.fetchReceipt.mockImplementation(async () => reply(actualOutboxCount ? "pending" : "confirmed"));
    await act(async () => root.render(<ReceiptText noteId="note-a" />));
    expect(host.textContent).toBe("confirmed");
    // NativeLocalRepository broadcasts this only AFTER its SQLite transaction
    // has persisted the new note and Outbox mutation, before any push ACK.
    actualOutboxCount = 1;
    await act(async () => window.dispatchEvent(new Event(MOBILE_SYNC_STATUS_CHANGED_EVENT)));
    expect(mocks.fetchReceipt).toHaveBeenLastCalledWith("note-a");
    expect(host.textContent).toBe("pending");
    actualOutboxCount = 2;
    await act(async () => window.dispatchEvent(new Event(MOBILE_SYNC_STATUS_CHANGED_EVENT)));
    expect(host.textContent).toBe("pending");
  });

  it("does not repaint an obsolete confirmed query after a newer pending refresh", async () => {
    const resolvers: Array<(result: ReturnType<typeof reply>) => void> = [];
    mocks.fetchReceipt.mockImplementation(() => new Promise((resolve) => resolvers.push(resolve)));
    await act(async () => root.render(<ReceiptText noteId="note-a" />));
    expect(resolvers).toHaveLength(1);
    await act(async () => window.dispatchEvent(new Event(MOBILE_SYNC_STATUS_CHANGED_EVENT)));
    expect(resolvers).toHaveLength(2);
    await act(async () => resolvers[1](reply("pending")));
    expect(host.textContent).toBe("pending");
    await act(async () => resolvers[0](reply("confirmed")));
    expect(host.textContent).toBe("pending");
  });
});
