import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", () => ({ getBaseUrl: () => "/api" }));

import {
  applyPermissionMappings,
  previewPermissionManifest,
  type RoundTripPermissionsManifest,
} from "@/lib/roundTripPermissionMapping";

const manifest: RoundTripPermissionsManifest = {
  format: "nowen-workspace-permissions",
  version: 1,
  exportedAt: "2026-07-23T00:00:00.000Z",
  sourceWorkspace: { id: "source", name: "Source" },
  members: [{
    sourceUserId: "source-user",
    username: "alice",
    email: "alice@example.com",
    displayName: "Alice",
    role: "editor",
  }],
};

describe("round-trip permission mapping client", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("nowen-token", "token-1");
    vi.restoreAllMocks();
  });

  it("requests mapping preview without applying permissions", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      success: true,
      suggestions: [{
        sourceUserId: "source-user",
        username: "alice",
        email: "alice@example.com",
        sourceRole: "editor",
        suggestedTargetUserId: "target-user",
        suggestedTargetUsername: "alice",
        match: "email",
        appliedRole: "editor",
      }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    const suggestions = await previewPermissionManifest("target-workspace", manifest);
    expect(suggestions[0]?.match).toBe("email");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/settings/roundtrip-permissions/preview");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer token-1");
    expect(JSON.parse(String(init?.body))).toMatchObject({ workspaceId: "target-workspace" });
  });

  it("sends only explicit user mappings to the apply endpoint", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      success: true,
      applied: 1,
      skipped: 0,
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    const result = await applyPermissionMappings({
      workspaceId: "target-workspace",
      manifest,
      mappings: [{ sourceUserId: "source-user", targetUserId: "target-user", role: "viewer" }],
    });
    expect(result.applied).toBe(1);
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(String(init?.body))).toMatchObject({
      mappings: [{ sourceUserId: "source-user", targetUserId: "target-user", role: "viewer" }],
    });
  });
});
