import type { EditorRuntimeMode } from "@/lib/editorRuntimePolicy";
import { BlockPatchRequestError } from "@/lib/blockPatchApi";

export const TIPTAP_BLOCK_PATCH_OVERRIDE_KEY = "nowen.tiptap_block_patch_v1";

export function resolveTiptapBlockPatchEnabled(options: {
  mode: EditorRuntimeMode;
  override?: string | null;
  editable: boolean;
  isGuest: boolean;
  presentationMode: boolean;
  contentFormat: string;
}): boolean {
  if (!options.editable || options.isGuest || options.presentationMode) return false;
  if (options.contentFormat !== "tiptap-json") return false;
  const override = (options.override || "").trim().toLowerCase();
  if (["0", "off", "false", "disabled"].includes(override)) return false;
  if (["1", "on", "true", "enabled"].includes(override)) return true;
  return options.mode === "viewport-optimized" || options.mode === "lightweight-edit";
}

export function shouldRetryTiptapBlockPatch(error: unknown): boolean {
  if (error instanceof BlockPatchRequestError) return error.code === "BLOCK_PATCH_TIMEOUT";
  return error instanceof TypeError;
}

/** Errors known to have rejected the patch before persistence may safely use the old full-save path. */
export function shouldFallbackTiptapBlockPatchToWholeSave(error: unknown): boolean {
  if (!(error instanceof BlockPatchRequestError)) return false;
  return [
    "BLOCK_FORMAT_UNSUPPORTED",
    "INVALID_BLOCK_PATCH",
    "INVALID_PATCH",
    "INVALID_BLOCK_ID",
    "INVALID_BLOCK_NODE",
    "BLOCK_ID_CONFLICT",
    "BLOCK_NOT_FOUND",
    "BLOCK_MOVE_SELF",
    "BLOCK_MOVE_PARENT_MISMATCH",
    "INVALID_TIPTAP_DOCUMENT",
  ].includes(error.code || "");
}
