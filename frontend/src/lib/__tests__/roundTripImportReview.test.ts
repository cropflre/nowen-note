import { afterEach, describe, expect, it, vi } from "vitest";
import {
  requestRoundTripImportReview,
  resolveRoundTripImportReview,
  roundTripImportReviewTestUtils,
  subscribeRoundTripImportReviews,
  type RoundTripImportReviewRequest,
} from "../roundTripImportReview";

const noPermissions = {
  applyPermissions: false,
  permissionMappings: {},
} as const;

afterEach(() => {
  roundTripImportReviewTestUtils.reset();
});

describe("round-trip import review queue", () => {
  it("publishes a full preview and resolves an independent-copy decision", async () => {
    const snapshots: RoundTripImportReviewRequest[][] = [];
    const unsubscribe = subscribeRoundTripImportReviews((items) => snapshots.push(items));

    const decision = requestRoundTripImportReview({
      success: true,
      dryRun: true,
      strategy: "copy",
      package: {
        format: "nowen-package",
        formatVersion: 2,
        packageKind: "markdown",
        counts: { notebooks: 4, notes: 8, tags: 2, attachments: 3 },
        formatStats: { markdown: 8, richText: 0, html: 0 },
        sync: { available: false, linkedResources: 0, reason: "Markdown 往返包不支持同步" },
      },
      conflicts: [{
        action: "rename-root",
        resourceType: "notebook",
        sourceId: "root",
        originalName: "产品资料",
        importedName: "产品资料 (2)",
      }],
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
    expect(request?.preview.package?.sync?.available).toBe(false);
    expect(request?.preview.conflicts?.[0]?.importedName).toBe("产品资料 (2)");

    resolveRoundTripImportReview(request!.id, { accepted: true, strategy: "copy", ...noPermissions });
    await expect(decision).resolves.toEqual({ accepted: true, strategy: "copy", ...noPermissions });
    expect(roundTripImportReviewTestUtils.pendingCount()).toBe(0);
    expect(snapshots.at(-1)).toEqual([]);
    unsubscribe();
  });

  it("exposes a lazy merge preview loader and returns the explicit merge decision", async () => {
    let current: RoundTripImportReviewRequest[] = [];
    const loadPreview = vi.fn(async () => ({
      success: true,
      dryRun: true,
      strategy: "merge" as const,
      counts: { notebooks: 1, mergedNotebooks: 3, renamedNotes: 2 },
      conflicts: [{
        action: "merge-directory" as const,
        resourceType: "notebook" as const,
        sourceId: "root",
        originalName: "产品资料",
        importedName: "产品资料",
      }],
    }));
    const unsubscribe = subscribeRoundTripImportReviews((items) => { current = items; });
    const decision = requestRoundTripImportReview({ success: true, strategy: "copy" }, {
      fileName: "merge.nowen.zip",
      loadPreview,
    });

    const mergePreview = await current[0].loadPreview?.("merge");
    expect(loadPreview).toHaveBeenCalledWith("merge");
    expect(mergePreview?.counts?.mergedNotebooks).toBe(3);

    resolveRoundTripImportReview(current[0].id, { accepted: true, strategy: "merge", ...noPermissions });
    await expect(decision).resolves.toEqual({ accepted: true, strategy: "merge", ...noPermissions });
    unsubscribe();
  });

  it("loads a source-linked sync plan and returns an explicit safe-sync decision", async () => {
    let current: RoundTripImportReviewRequest[] = [];
    const loadPreview = vi.fn(async (strategy: "copy" | "merge" | "sync") => ({
      success: true,
      dryRun: true,
      strategy,
      package: {
        format: "nowen-package",
        formatVersion: 2,
        packageKind: "nowen",
        sourceInstanceId: "source-instance-1",
        sync: { available: true, linkedResources: 12, reason: null },
      },
      counts: {
        notes: 1,
        updatedNotes: 3,
        unchangedNotes: 8,
        localConflicts: 1,
      },
      conflicts: [{
        action: "sync-local-conflict" as const,
        resourceType: "note" as const,
        sourceId: "source-note",
        targetId: "target-note",
        originalName: "来源第三版",
        importedName: "本地人工修改",
      }],
      warnings: [{ type: "sync_local_conflicts", message: "本地修改已保留" }],
      errors: [],
    }));
    const unsubscribe = subscribeRoundTripImportReviews((items) => { current = items; });
    const decision = requestRoundTripImportReview({
      success: true,
      strategy: "copy",
      package: {
        format: "nowen-package",
        packageKind: "nowen",
        sourceInstanceId: "source-instance-1",
        sync: { available: true, linkedResources: 12, reason: null },
      },
    }, {
      fileName: "incremental.nowen.zip",
      loadPreview,
    });

    const syncPreview = await current[0].loadPreview?.("sync");
    expect(loadPreview).toHaveBeenCalledWith("sync");
    expect(syncPreview?.strategy).toBe("sync");
    expect(syncPreview?.counts?.updatedNotes).toBe(3);
    expect(syncPreview?.counts?.localConflicts).toBe(1);
    expect(syncPreview?.conflicts?.[0]?.action).toBe("sync-local-conflict");

    resolveRoundTripImportReview(current[0].id, { accepted: true, strategy: "sync", ...noPermissions });
    await expect(decision).resolves.toEqual({ accepted: true, strategy: "sync", ...noPermissions });
    unsubscribe();
  });

  it("returns only explicit source-to-target account mappings", async () => {
    let current: RoundTripImportReviewRequest[] = [];
    const unsubscribe = subscribeRoundTripImportReviews((items) => { current = items; });
    const decision = requestRoundTripImportReview({
      success: true,
      strategy: "copy",
      package: {
        permissions: {
          included: true,
          valid: true,
          canApply: true,
          reason: null,
          counts: { principals: 2, workspaceMembers: 2, notebookMembers: 1 },
          principals: [{
            sourceUserId: "source-user-1",
            username: "alice",
            displayName: "Alice",
            email: "alice@example.com",
            workspaceRole: "editor",
            suggestedTarget: {
              id: "target-user-1",
              username: "alice-target",
              displayName: "Alice Target",
              avatarUrl: null,
            },
            match: "email",
          }],
          issues: [],
        },
      },
    }, { fileName: "permissions.nowen.zip" });

    resolveRoundTripImportReview(current[0].id, {
      accepted: true,
      strategy: "copy",
      applyPermissions: true,
      permissionMappings: { "source-user-1": "target-user-1" },
    });
    await expect(decision).resolves.toEqual({
      accepted: true,
      strategy: "copy",
      applyPermissions: true,
      permissionMappings: { "source-user-1": "target-user-1" },
    });
    unsubscribe();
  });

  it("keeps concurrent reviews queued and allows cancellation without dropping the next request", async () => {
    let current: RoundTripImportReviewRequest[] = [];
    const unsubscribe = subscribeRoundTripImportReviews((items) => { current = items; });
    const first = requestRoundTripImportReview({ success: true }, { fileName: "a.nowen.zip" });
    const second = requestRoundTripImportReview({ success: true }, { fileName: "b.nowen.zip" });

    expect(current.map((item) => item.fileName)).toEqual(["a.nowen.zip", "b.nowen.zip"]);
    resolveRoundTripImportReview(current[0].id, { accepted: false });
    await expect(first).resolves.toEqual({ accepted: false });
    expect(current.map((item) => item.fileName)).toEqual(["b.nowen.zip"]);

    resolveRoundTripImportReview(current[0].id, { accepted: true, strategy: "copy", ...noPermissions });
    await expect(second).resolves.toEqual({ accepted: true, strategy: "copy", ...noPermissions });
    expect(current).toEqual([]);
    unsubscribe();
  });
});
