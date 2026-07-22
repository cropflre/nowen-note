import { afterEach, describe, expect, it } from "vitest";
import {
  requestRoundTripImportReview,
  resolveRoundTripImportReview,
  roundTripImportReviewTestUtils,
  subscribeRoundTripImportReviews,
  type RoundTripImportReviewRequest,
} from "../roundTripImportReview";

afterEach(() => {
  roundTripImportReviewTestUtils.reset();
});

describe("round-trip import review queue", () => {
  it("publishes a full preview and resolves the caller after approval", async () => {
    const snapshots: RoundTripImportReviewRequest[][] = [];
    const unsubscribe = subscribeRoundTripImportReviews((items) => snapshots.push(items));

    const decision = requestRoundTripImportReview({
      success: true,
      dryRun: true,
      package: {
        format: "nowen-package",
        formatVersion: 2,
        packageKind: "markdown",
        counts: { notebooks: 4, notes: 8, tags: 2, attachments: 3 },
        formatStats: { markdown: 8, richText: 0, html: 0 },
      },
      conflicts: [{ sourceId: "root", originalName: "产品资料", importedName: "产品资料 (2)" }],
      warnings: [],
      errors: [],
    }, {
      fileName: "产品资料.zip",
      targetLabel: "个人空间",
      source: "shared-import",
    });

    expect(roundTripImportReviewTestUtils.pendingCount()).toBe(1);
    const request = snapshots.at(-1)?.[0];
    expect(request?.fileName).toBe("产品资料.zip");
    expect(request?.preview.package?.counts?.notes).toBe(8);
    expect(request?.preview.conflicts?.[0]?.importedName).toBe("产品资料 (2)");

    resolveRoundTripImportReview(request!.id, true);
    await expect(decision).resolves.toBe(true);
    expect(roundTripImportReviewTestUtils.pendingCount()).toBe(0);
    expect(snapshots.at(-1)).toEqual([]);
    unsubscribe();
  });

  it("keeps concurrent reviews queued and allows cancellation without dropping the next request", async () => {
    let current: RoundTripImportReviewRequest[] = [];
    const unsubscribe = subscribeRoundTripImportReviews((items) => { current = items; });
    const first = requestRoundTripImportReview({ success: true }, { fileName: "a.nowen.zip" });
    const second = requestRoundTripImportReview({ success: true }, { fileName: "b.nowen.zip" });

    expect(current.map((item) => item.fileName)).toEqual(["a.nowen.zip", "b.nowen.zip"]);
    resolveRoundTripImportReview(current[0].id, false);
    await expect(first).resolves.toBe(false);
    expect(current.map((item) => item.fileName)).toEqual(["b.nowen.zip"]);

    resolveRoundTripImportReview(current[0].id, true);
    await expect(second).resolves.toBe(true);
    expect(current).toEqual([]);
    unsubscribe();
  });
});
