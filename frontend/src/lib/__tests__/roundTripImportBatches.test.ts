import { afterEach, describe, expect, it, vi } from "vitest";
import {
  announceRoundTripImportCompleted,
  listRoundTripImportBatches,
  ROUND_TRIP_IMPORT_COMPLETED_EVENT,
  undoRoundTripImportBatch,
} from "../roundTripImportBatches";

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("round-trip import batch client", () => {
  it("announces a completed batch and remembers its id", () => {
    const listener = vi.fn();
    window.addEventListener(ROUND_TRIP_IMPORT_COMPLETED_EVENT, listener);

    announceRoundTripImportCompleted("batch-123");

    expect(localStorage.getItem("nowen-last-roundtrip-import-batch")).toBe("batch-123");
    expect(listener).toHaveBeenCalledTimes(1);
    expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual({ batchId: "batch-123" });
    window.removeEventListener(ROUND_TRIP_IMPORT_COMPLETED_EVENT, listener);
  });

  it("loads persistent batch summaries", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      items: [{
        id: "batch-1",
        workspaceId: null,
        importMode: "new-root",
        packageKind: "nowen",
        sourceInstanceId: "instance-1",
        sourceExportBatchId: "export-1",
        status: "completed",
        createdAt: "2026-07-22T10:00:00Z",
        completedAt: "2026-07-22T10:00:01Z",
        undoneAt: null,
        undo: { available: true, expiresAt: "2026-07-29T10:00:01Z", reason: null, error: null },
        counts: { notes: 2 },
        warningCount: 0,
        errorCount: 0,
      }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    const items = await listRoundTripImportBatches({ workspaceId: null, limit: 10 });

    expect(items[0]?.id).toBe("batch-1");
    expect(items[0]?.undo.available).toBe(true);
    expect(fetchMock.mock.calls[0][0].toString()).toContain("/settings/import-batches?workspaceId=personal&limit=10");
  });

  it("surfaces guarded undo conflicts from the server", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      error: "检测到导入后的本地修改，已拒绝破坏性撤销",
      code: "IMPORT_BATCH_UNDO_CONFLICT",
      conflicts: ["笔记或其附件已在导入后发生变化：note-1"],
    }), { status: 409, headers: { "Content-Type": "application/json" } }));

    await expect(undoRoundTripImportBatch("batch-1")).rejects.toMatchObject({
      message: "检测到导入后的本地修改，已拒绝破坏性撤销",
      code: "IMPORT_BATCH_UNDO_CONFLICT",
      conflicts: ["笔记或其附件已在导入后发生变化：note-1"],
    });
  });
});
