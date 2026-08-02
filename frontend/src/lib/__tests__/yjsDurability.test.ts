import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  encodeMissingYjsUpdate,
  YjsDurabilityTracker,
} from "@/lib/yjsDurability";

describe("YjsDurabilityTracker", () => {
  it("does not report saved until every sent operation is acknowledged", () => {
    const tracker = new YjsDurabilityTracker();

    expect(tracker.markLocalChange()).toEqual(expect.objectContaining({
      status: "local",
      dirty: true,
    }));
    expect(tracker.markSent("op-a")).toEqual(expect.objectContaining({
      status: "saving",
      pendingCount: 1,
    }));
    tracker.markSent("op-b");

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
    tracker.markSent("op-a");

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
    tracker.markSent("op-a");

    expect(tracker.fail("op-a", "persist_failed")).toEqual(expect.objectContaining({
      status: "error",
      pendingCount: 0,
      dirty: true,
      errorCode: "persist_failed",
    }));
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
