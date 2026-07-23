import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api.impl", () => ({
  getBaseUrl: () => "/api",
}));

import {
  BlockPatchRequestError,
  createBlockPatchOperationId,
  patchTiptapBlocks,
} from "@/lib/blockPatchApi";

describe("block patch API client", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("sends one confirmed patch envelope and returns the authoritative snapshot", async () => {
    localStorage.setItem("nowen-token", "token-1");
    const authoritativeContent = JSON.stringify({
      type: "doc",
      content: [{
        type: "paragraph",
        attrs: { blockId: "blk_alpha00" },
        content: [{ type: "text", text: "Updated" }],
      }],
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      success: true,
      noteId: "note-1",
      title: "Note",
      version: 8,
      updatedAt: "2026-07-22T10:00:00.000Z",
      content: authoritativeContent,
      contentText: "Updated",
      contentFormat: "tiptap-json",
      notebookId: "notebook-1",
      operationCount: 1,
      affectedBlockIds: ["blk_alpha00"],
      deletedBlockIds: [],
      createdBlocks: [],
      blocks: [],
      indexUpdateMode: "incremental",
      indexedBlockIds: ["blk_alpha00"],
      contentChangedByNormalization: false,
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    const result = await patchTiptapBlocks("note/with spaces", {
      expectedNoteVersion: 7,
      operationId: "block-patch-test-operation",
      operations: [{ type: "update", blockId: "blk_alpha00", text: "Updated" }],
    });

    expect(result).toMatchObject({
      version: 8,
      content: authoritativeContent,
      contentText: "Updated",
      contentFormat: "tiptap-json",
      updatedAt: "2026-07-22T10:00:00.000Z",
      indexUpdateMode: "incremental",
      indexedBlockIds: ["blk_alpha00"],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/blocks/note%2Fwith%20spaces/patch");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer token-1");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      expectedNoteVersion: 7,
      operationId: "block-patch-test-operation",
    });
  });

  it("preserves server conflict metadata for retry/rebase decisions", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      error: "Version conflict",
      code: "VERSION_CONFLICT",
      currentVersion: 11,
    }), { status: 409, headers: { "Content-Type": "application/json" } }));

    await expect(patchTiptapBlocks("note-1", {
      expectedNoteVersion: 10,
      operationId: "block-patch-conflict-test",
      operations: [{ type: "delete", blockId: "blk_alpha00" }],
    })).rejects.toMatchObject({
      code: "VERSION_CONFLICT",
      status: 409,
      currentVersion: 11,
    } satisfies Partial<BlockPatchRequestError>);
  });

  it("creates retry-safe operation identifiers", () => {
    expect(createBlockPatchOperationId()).toMatch(/^block-patch-/);
  });
});
