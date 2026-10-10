// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
const scope = vi.hoisted(() => ({ value: "server-a:user-a" }));
vi.mock("@/lib/offlineScope", () => ({ getOfflineQueueStorageKey: () => scope.value }));
import {
  beginNoteReceiptWrite, acknowledgeNoteReceipt, getNoteSyncReceipt,
  markNoteReceiptPending, resolveNoteReceiptPhase, acknowledgeRestNoteReceipt,
} from "@/lib/noteSyncReceipt";

describe("per-note sync receipt (browser)", () => {
  beforeEach(() => { localStorage.clear(); scope.value = "server-a:user-a"; });

  it("requires exact local revision before acknowledging a note write", () => {
    const first = beginNoteReceiptWrite("note-a");
    const latest = beginNoteReceiptWrite("note-a");
    expect(acknowledgeNoteReceipt("note-a", first, 8)).toBe(false);
    expect(resolveNoteReceiptPhase(getNoteSyncReceipt("note-a"), [])).toBe("unverified");
    expect(acknowledgeNoteReceipt("note-a", latest, 8)).toBe(true);
    expect(getNoteSyncReceipt("note-a")).toMatchObject({
      localRevision: 2, acknowledgedRevision: 2, acknowledgedVersion: 8, phase: "confirmed",
    });
    expect(acknowledgeNoteReceipt("note-a", latest, NaN)).toBe(false);
  });

  it("preserves pending queue and conflict priority over an older ACK", () => {
    const revision = beginNoteReceiptWrite("note-a");
    acknowledgeNoteReceipt("note-a", revision, 4);
    expect(resolveNoteReceiptPhase(getNoteSyncReceipt("note-a"), [{ noteId: "note-a" }])).toBe("pending");
    expect(resolveNoteReceiptPhase(getNoteSyncReceipt("note-a"), [
      { noteId: "note-a", conflict: true },
    ])).toBe("conflict");
    expect(resolveNoteReceiptPhase(getNoteSyncReceipt("note-a"), [
      { noteId: "note-a", blocked: true, errorCode: "NETWORK_ERROR" },
    ])).toBe("error");
    markNoteReceiptPending("note-a");
    expect(resolveNoteReceiptPhase(getNoteSyncReceipt("note-a"), [])).toBe("pending");
  });

  it("does not treat an Electron local SQLite response as a cloud ACK", () => {
    const revision = beginNoteReceiptWrite("desktop-note");
    (window as any).nowenDesktop = { isDesktop: true };
    try {
      expect(acknowledgeRestNoteReceipt("desktop-note", revision, 12)).toBe(false);
      expect(resolveNoteReceiptPhase(getNoteSyncReceipt("desktop-note"), [])).toBe("unverified");
    } finally {
      delete (window as any).nowenDesktop;
    }
  });
  it("isolates receipt data across account and server scopes", () => {
    const revision = beginNoteReceiptWrite("note-a");
    acknowledgeNoteReceipt("note-a", revision, 3);
    scope.value = "server-b:user-b";
    expect(getNoteSyncReceipt("note-a")).toBeNull();
    scope.value = "server-a:user-a";
    expect(getNoteSyncReceipt("note-a")?.phase).toBe("confirmed");
  });

  it("does not revive a save-in-flight as confirmed after a reload", () => {
    beginNoteReceiptWrite("note-a");
    expect(resolveNoteReceiptPhase(getNoteSyncReceipt("note-a"), [])).toBe("unverified");
  });
});
