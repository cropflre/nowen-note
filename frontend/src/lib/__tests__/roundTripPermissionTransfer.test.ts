import { afterEach, describe, expect, it, vi } from "vitest";
import {
  requestRoundTripPermissionReview,
  resolveRoundTripPermissionReview,
  roundTripPermissionReviewTestUtils,
  subscribeRoundTripPermissionReviews,
  suggestedPermissionMappings,
  type RoundTripPermissionReviewRequest,
} from "../roundTripPermissionReview";
import {
  downloadRoundTripPermissionPackage,
  requestRoundTripPermissionExport,
  resolveRoundTripExportWorkspaceFromUi,
  resolveRoundTripPermissionExport,
  roundTripPermissionExportTestUtils,
  subscribeRoundTripPermissionExports,
} from "../roundTripPermissionExport";
import { submitRoundTripPackage, type RoundTripPermissionInspection } from "../roundTripImportReview";

const inspection: RoundTripPermissionInspection = {
  included: true,
  valid: true,
  canApply: true,
  version: 2,
  reason: null,
  counts: { principals: 2, workspaceMembers: 2, notebookMembers: 1 },
  principals: [
    {
      sourceUserId: "source-a",
      username: "source-a",
      displayName: "Source A",
      email: "a@example.com",
      workspaceRole: "editor",
      suggestedTarget: {
        id: "target-a",
        username: "target-a",
        displayName: "Target A",
        avatarUrl: null,
      },
      match: "email",
    },
    {
      sourceUserId: "source-b",
      username: "source-b",
      displayName: null,
      email: null,
      workspaceRole: null,
      suggestedTarget: null,
      match: "none",
    },
  ],
  issues: [],
};

afterEach(() => {
  vi.restoreAllMocks();
  roundTripPermissionReviewTestUtils.reset();
  roundTripPermissionExportTestUtils.reset();
  document.body.innerHTML = "";
});

describe("round-trip permission transfer UI bridge", () => {
  it("queues explicit mappings and only prefills unique suggestions", async () => {
    let current: RoundTripPermissionReviewRequest[] = [];
    const unsubscribe = subscribeRoundTripPermissionReviews((items) => { current = items; });
    expect(suggestedPermissionMappings(inspection)).toEqual({ "source-a": "target-a" });

    const decision = requestRoundTripPermissionReview(inspection);
    expect(current).toHaveLength(1);
    expect(current[0].inspection.counts.notebookMembers).toBe(1);
    resolveRoundTripPermissionReview(current[0].id, {
      applyPermissions: true,
      permissionMappings: { "source-a": "target-a" },
    });
    await expect(decision).resolves.toEqual({
      applyPermissions: true,
      permissionMappings: { "source-a": "target-a" },
    });
    unsubscribe();
  });

  it("still surfaces an included but invalid permission manifest", async () => {
    let current: RoundTripPermissionReviewRequest[] = [];
    const unsubscribe = subscribeRoundTripPermissionReviews((items) => { current = items; });
    const decision = requestRoundTripPermissionReview({
      ...inspection,
      valid: false,
      canApply: false,
      issues: ["permissions.json 不是有效 JSON"],
    });
    expect(current).toHaveLength(1);
    expect(current[0].inspection.canApply).toBe(false);
    resolveRoundTripPermissionReview(current[0].id, {
      applyPermissions: false,
      permissionMappings: {},
    });
    await expect(decision).resolves.toEqual({ applyPermissions: false, permissionMappings: {} });
    unsubscribe();
  });

  it("submits applyPermissions and source-to-target mappings only on formal import", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      success: true,
      importBatch: { id: "batch-1", undoAvailable: true },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const file = new File(["zip"], "team.nowen.zip", { type: "application/zip" });

    await submitRoundTripPackage(file, {
      dryRun: false,
      strategy: "copy",
      workspaceId: "workspace-1",
      applyPermissions: true,
      permissionMappings: { "source-a": "target-a" },
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/settings/import-batches/package");
    expect(String(url)).toContain("workspaceId=workspace-1");
    const body = init?.body as FormData;
    expect(body.get("applyPermissions")).toBe("true");
    expect(body.get("permissionMappings")).toBe(JSON.stringify({ "source-a": "target-a" }));
  });

  it("uses DataManager's explicit personal or workspace scope", () => {
    document.body.innerHTML = `
      <div>
        <div role="tablist" aria-label="data scope">
          <button role="tab" aria-selected="false">Personal</button>
          <button role="tab" aria-selected="true">Workspace</button>
          <button role="tab" aria-selected="false">System</button>
        </div>
        <select><option value="workspace-a">A</option><option selected value="workspace-b">B</option></select>
      </div>
    `;
    expect(resolveRoundTripExportWorkspaceFromUi("sidebar-workspace")).toBe("workspace-b");
    const tabs = document.querySelectorAll('[role="tab"]');
    tabs[0].setAttribute("aria-selected", "true");
    tabs[1].setAttribute("aria-selected", "false");
    expect(resolveRoundTripExportWorkspaceFromUi("sidebar-workspace")).toBe("personal");
  });

  it("keeps permission export opt-in and forwards the explicit decision", async () => {
    let current: Array<{ id: number; workspaceId: string }> = [];
    const unsubscribe = subscribeRoundTripPermissionExports((items) => { current = items; });
    const decision = requestRoundTripPermissionExport("workspace-1");
    expect(current[0].workspaceId).toBe("workspace-1");
    resolveRoundTripPermissionExport(current[0].id, true);
    await expect(decision).resolves.toBe(true);
    unsubscribe();

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("zip", {
      status: 200,
      headers: { "Content-Disposition": 'attachment; filename="team.nowen.zip"' },
    }));
    const result = await downloadRoundTripPermissionPackage({
      workspaceId: "workspace-1",
      includePermissions: true,
    });
    expect(String(fetchMock.mock.calls[0][0])).toContain("includePermissions=true");
    expect(result.filename).toBe("team.nowen.zip");
  });
});
