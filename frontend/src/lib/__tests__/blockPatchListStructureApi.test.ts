import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api.impl", () => ({
  getBaseUrl: () => "/api",
}));

import {
  BlockPatchRequestError,
  patchTiptapBlocks,
} from "@/lib/blockPatchApi";
import { shouldFallbackTiptapBlockPatchToWholeSave } from "@/lib/tiptapBlockPatchRuntime";

function paragraph(blockId: string, text: string) {
  return {
    type: "paragraph" as const,
    attrs: { blockId, textAlign: null, lineHeight: null },
    content: text ? [{ type: "text" as const, text }] : [],
  };
}

describe("list item structure Block Patch API", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("sends a scoped create and accepts the list-structural response", async () => {
    const node = {
      type: "listItem" as const,
      attrs: { blockId: "blk_item_new" },
      content: [paragraph("blk_para_new", "New")],
    };
    const authoritativeContent = JSON.stringify({
      type: "doc",
      content: [{ type: "bulletList", content: [node] }],
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      success: true,
      noteId: "note-1",
      title: "List",
      version: 2,
      updatedAt: "2026-07-23T11:00:00.000Z",
      content: authoritativeContent,
      contentText: "New",
      contentFormat: "tiptap-json",
      notebookId: "notebook-1",
      operationCount: 1,
      affectedBlockIds: ["blk_item_new", "blk_para_new"],
      deletedBlockIds: [],
      createdBlocks: [{
        operationIndex: 0,
        clientId: "blk_item_new",
        blockId: "blk_item_new",
      }],
      blocks: [],
      indexUpdateMode: "incremental",
      indexUpdateKind: "list-structural",
      indexedBlockIds: ["blk_item_new", "blk_para_new"],
      contentChangedByNormalization: false,
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    const result = await patchTiptapBlocks("note-1", {
      expectedNoteVersion: 1,
      operationId: "list-structure-api-test",
      operations: [{
        type: "create",
        scope: "listItem",
        clientId: "blk_item_new",
        blockId: "blk_item_new",
        targetBlockId: "blk_item_old",
        position: "after",
        node,
      }],
    });

    expect(result.indexUpdateKind).toBe("list-structural");
    expect(result.createdBlocks).toEqual([{
      operationIndex: 0,
      clientId: "blk_item_new",
      blockId: "blk_item_new",
    }]);
    const request = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(request.operations).toEqual([{
      type: "create",
      scope: "listItem",
      clientId: "blk_item_new",
      blockId: "blk_item_new",
      targetBlockId: "blk_item_old",
      position: "after",
      node,
    }]);
  });

  it("treats a rejected list structure patch as a safe whole-save fallback", () => {
    const error = new BlockPatchRequestError("unsupported list structure");
    error.code = "LIST_STRUCTURE_INVALID";
    error.status = 400;
    expect(shouldFallbackTiptapBlockPatchToWholeSave(error)).toBe(true);
  });
});
