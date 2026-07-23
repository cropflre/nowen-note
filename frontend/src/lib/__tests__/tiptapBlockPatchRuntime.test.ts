import { describe, expect, it } from "vitest";

import { BlockPatchRequestError } from "@/lib/blockPatchApi";
import {
  resolveTiptapBlockPatchEnabled,
  shouldFallbackTiptapBlockPatchToWholeSave,
  shouldRetryTiptapBlockPatch,
} from "@/lib/tiptapBlockPatchRuntime";

const base = {
  editable: true,
  isGuest: false,
  presentationMode: false,
  contentFormat: "tiptap-json",
} as const;

describe("Tiptap Block Patch rollout", () => {
  it("defaults to optimized modes and supports explicit session overrides", () => {
    expect(resolveTiptapBlockPatchEnabled({ ...base, mode: "normal" })).toBe(false);
    expect(resolveTiptapBlockPatchEnabled({ ...base, mode: "viewport-optimized" })).toBe(true);
    expect(resolveTiptapBlockPatchEnabled({ ...base, mode: "lightweight-edit" })).toBe(true);
    expect(resolveTiptapBlockPatchEnabled({ ...base, mode: "normal", override: "on" })).toBe(true);
    expect(resolveTiptapBlockPatchEnabled({ ...base, mode: "lightweight-edit", override: "off" })).toBe(false);
  });

  it("never enables writes for guests, presentations or non-Tiptap documents", () => {
    expect(resolveTiptapBlockPatchEnabled({ ...base, mode: "lightweight-edit", isGuest: true })).toBe(false);
    expect(resolveTiptapBlockPatchEnabled({ ...base, mode: "lightweight-edit", presentationMode: true })).toBe(false);
    expect(resolveTiptapBlockPatchEnabled({ ...base, mode: "lightweight-edit", contentFormat: "markdown" })).toBe(false);
  });

  it("retries uncertain outcomes but only falls back after known pre-persistence rejection", () => {
    const timeout = new BlockPatchRequestError("timeout");
    timeout.code = "BLOCK_PATCH_TIMEOUT";
    expect(shouldRetryTiptapBlockPatch(timeout)).toBe(true);
    expect(shouldFallbackTiptapBlockPatchToWholeSave(timeout)).toBe(false);

    const unsupported = new BlockPatchRequestError("unsupported");
    unsupported.code = "BLOCK_FORMAT_UNSUPPORTED";
    expect(shouldRetryTiptapBlockPatch(unsupported)).toBe(false);
    expect(shouldFallbackTiptapBlockPatchToWholeSave(unsupported)).toBe(true);

    const invalidNode = new BlockPatchRequestError("invalid rich node");
    invalidNode.code = "INVALID_BLOCK_NODE";
    expect(shouldRetryTiptapBlockPatch(invalidNode)).toBe(false);
    expect(shouldFallbackTiptapBlockPatchToWholeSave(invalidNode)).toBe(true);

    const conflict = new BlockPatchRequestError("conflict");
    conflict.code = "VERSION_CONFLICT";
    expect(shouldFallbackTiptapBlockPatchToWholeSave(conflict)).toBe(false);
  });
});
