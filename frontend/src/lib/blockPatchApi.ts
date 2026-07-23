import { getBaseUrl } from "@/lib/api.impl";
import type { TiptapPatchJsonNode } from "@/lib/tiptapBlockPatchNode";

export type BlockPatchBlockType =
  | "heading"
  | "paragraph"
  | "listItem"
  | "taskItem"
  | "blockquote"
  | "codeBlock";

export type BlockPatchOperation =
  | {
      type: "create";
      clientId?: string;
      blockId?: string;
      blockType?: BlockPatchBlockType;
      text?: string;
      afterBlockId?: string;
    }
  | {
      type: "update";
      blockId: string;
      text: string;
    }
  | {
      type: "replace";
      blockId: string;
      node: TiptapPatchJsonNode;
    }
  | {
      type: "delete";
      blockId: string;
    }
  | {
      type: "move";
      blockId: string;
      targetBlockId: string;
      position?: "before" | "after";
    };

export interface BlockPatchRequest {
  expectedNoteVersion: number;
  /** Keep the same ID when retrying an uncertain request. */
  operationId: string;
  operations: BlockPatchOperation[];
}

export interface BlockPatchIndexRow {
  noteId: string;
  blockId: string;
  blockType: BlockPatchBlockType;
  parentBlockId: string | null;
  blockOrder: number;
  plainText: string;
  contentHash: string;
  path: string;
  startOffset: number | null;
  endOffset: number | null;
}

export interface BlockPatchResult {
  success: true;
  noteId: string;
  title: string;
  version: number;
  updatedAt: string;
  content: string;
  contentText: string;
  contentFormat: string;
  notebookId: string | null;
  operationCount: number;
  affectedBlockIds: string[];
  deletedBlockIds: string[];
  createdBlocks: Array<{
    operationIndex: number;
    clientId: string | null;
    blockId: string;
  }>;
  blocks: BlockPatchIndexRow[];
  /** Whether the server touched only the affected leaf rows or rebuilt every note index row. */
  indexUpdateMode: "incremental" | "full";
  indexedBlockIds: string[];
  contentChangedByNormalization: boolean;
  idempotentReplay?: boolean;
}

export class BlockPatchRequestError extends Error {
  code?: string;
  status?: number;
  currentVersion?: number;
}

export function createBlockPatchOperationId(): string {
  const randomUUID = typeof crypto !== "undefined" ? crypto.randomUUID?.bind(crypto) : undefined;
  if (randomUUID) return `block-patch-${randomUUID()}`;
  return `block-patch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * Send one confirmed, idempotent Tiptap block transaction.
 *
 * This intentionally bypasses the optimistic offline mutation queue. A caller must receive the
 * authoritative version before applying a later patch, otherwise operation order would become
 * ambiguous after reconnect.
 */
export async function patchTiptapBlocks(
  noteId: string,
  input: BlockPatchRequest,
): Promise<BlockPatchResult> {
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), 30_000);
  const token = localStorage.getItem("nowen-token");

  try {
    const response = await fetch(
      `${getBaseUrl()}/blocks/${encodeURIComponent(noteId)}/patch`,
      {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(input),
      },
    );
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) {
      const error = new BlockPatchRequestError(
        typeof payload.error === "string" ? payload.error : `HTTP ${response.status}`,
      );
      error.code = typeof payload.code === "string" ? payload.code : undefined;
      error.status = response.status;
      error.currentVersion = typeof payload.currentVersion === "number"
        ? payload.currentVersion
        : undefined;
      throw error;
    }
    return payload as unknown as BlockPatchResult;
  } catch (error) {
    if ((error as { name?: string })?.name === "AbortError") {
      const timeoutError = new BlockPatchRequestError("块级保存超时，请检查网络后使用同一 operationId 重试");
      timeoutError.code = "BLOCK_PATCH_TIMEOUT";
      throw timeoutError;
    }
    throw error;
  } finally {
    globalThis.clearTimeout(timeout);
  }
}
