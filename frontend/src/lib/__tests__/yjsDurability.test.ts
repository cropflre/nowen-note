import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  encodeMissingYjsUpdate,
  isYjsUploadReady,
  YjsDurabilityTracker,
} from "@/lib/yjsDurability";

describe("Yjs upload readiness", () => {
  it("requires both server and IndexedDB baselines before direct upload", () => {
    expect(isYjsUploadReady({
      socketOpen: true,
      joined: true,
      serverSynced: true,
      localPersistenceReady: false,
    })).toBe(false);

    expect(isYjsUploadReady({
      socketOpen: true,
      joined: true,
      serverSynced: true,
      localPersistenceReady: true,
    })).toBe(true);
  });
});

describe("YjsDurabilityTracker", () => {
  it("does not report saved until every sent operation is acknowledged", () => {
    const tracker = new YjsDurabilityTracker();

    expect(tracker.markLocalChange()).toEqual(expect.objectContaining({
      status: "local",
      dirty: true,
    }));
    expect(tracker.markSent("op-a", { localChanges: 1 })).toEqual(expect.objectContaining({
      status: "saving",
      pendingCount: 1,
    }));
    tracker.markLocalChange();
    tracker.markSent("op-b", { localChanges: 1 });

    expect(tracker.acknowledge("op-a", "2026-08-02T00:00:00.000Z")).toEqual(
      expect.objectContaining({ status: "saving", pendingCount: 1, dirty: true }),
    );
    expect(tracker.acknowledge("op-b", "2026-08-02T00:00:01.000Z")).toEqual(
      expect.objectContaining({
        status: "saved",
        pendingCount: 0,
        dirty: false,
        lastPersistedAt: "2026-08-02T00:00:01.000Z",
      }),
    );
  });

  it("keeps content local-only after disconnect and ignores late unknown ACKs", () => {
    const tracker = new YjsDurabilityTracker();
    tracker.markLocalChange();
    tracker.markSent("op-a", { localChanges: 1 });

    expect(tracker.markDisconnected()).toEqual(expect.objectContaining({
      status: "local",
      pendingCount: 0,
      dirty: true,
    }));
    expect(tracker.acknowledge("op-a", "2026-08-02T00:00:00.000Z")).toEqual(
      expect.objectContaining({ status: "local", dirty: true }),
    );
  });

  it("keeps failed operations dirty and visible", () => {
    const tracker = new YjsDurabilityTracker();
    tracker.markLocalChange();
    tracker.markSent("op-a", { localChanges: 1 });

    expect(tracker.fail("op-a", "persist_failed")).toEqual(expect.objectContaining({
      status: "error",
      pendingCount: 0,
      dirty: true,
      errorCode: "persist_failed",
    }));
  });

  it("does not let an older ACK clear newer content that was never sent", () => {
    const tracker = new YjsDurabilityTracker();
    tracker.markLocalChange();
    tracker.markSent("old-operation", { localChanges: 1 });

    // A later local update could not be represented by an operation, for example
    // because it exceeded the frame limit. The older request may still ACK later.
    tracker.fail(null, "too_large");

    expect(tracker.acknowledge("old-operation", "2026-08-02T00:00:01.000Z")).toEqual(
      expect.objectContaining({
        status: "error",
        pendingCount: 0,
        dirty: true,
        errorCode: "too_large",
      }),
    );
  });

  it("only clears all local-only changes for a full state-vector reconciliation", () => {
    const tracker = new YjsDurabilityTracker();
    tracker.markLocalChange(2);

    tracker.markSent("direct-update", { localChanges: 1 });
    expect(tracker.acknowledge("direct-update", "2026-08-02T00:00:00.000Z")).toEqual(
      expect.objectContaining({ status: "local", dirty: true, pendingCount: 0 }),
    );

    tracker.markSent("full-diff", { coversAllLocalChanges: true });
    expect(tracker.acknowledge("full-diff", "2026-08-02T00:00:01.000Z")).toEqual(
      expect.objectContaining({ status: "saved", dirty: false, pendingCount: 0 }),
    );
  });
});

describe("encodeMissingYjsUpdate", () => {
  it("uploads only local IndexedDB content missing from the server baseline", () => {
    const server = new Y.Doc();
    server.getText("content").insert(0, "server body");

    const local = new Y.Doc();
    Y.applyUpdate(local, Y.encodeStateAsUpdate(server));
    local.getText("content").insert(local.getText("content").length, " + offline edit");

    const missing = encodeMissingYjsUpdate(local, Y.encodeStateVector(server));
    expect(missing).not.toBeNull();

    Y.applyUpdate(server, missing!);
    expect(server.getText("content").toString()).toBe("server body + offline edit");

    local.destroy();
    server.destroy();
  });

  it("returns null when the server already contains the complete local document", () => {
    const server = new Y.Doc();
    server.getText("content").insert(0, "same body");
    const local = new Y.Doc();
    Y.applyUpdate(local, Y.encodeStateAsUpdate(server));

    expect(encodeMissingYjsUpdate(local, Y.encodeStateVector(server))).toBeNull();

    local.destroy();
    server.destroy();
  });
});
