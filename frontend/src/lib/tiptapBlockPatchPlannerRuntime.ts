import type { BlockPatchOperation } from "@/lib/blockPatchApi";
import {
  planTiptapBlockPatch as planBaseTiptapBlockPatch,
  type TiptapBlockPatchPlan as BaseTiptapBlockPatchPlan,
} from "@/lib/tiptapBlockPatchPlanner";
import { planTiptapListItemMove } from "@/lib/tiptapListItemMovePlanner";

interface JsonNode {
  type?: string;
  attrs?: Record<string, unknown> | null;
  content?: JsonNode[];
  text?: string;
  [key: string]: unknown;
}

export type TiptapBlockPatchPlan = BaseTiptapBlockPatchPlan | {
  operations: BlockPatchOperation[];
  kind: "list-hierarchy";
  affectedBlockIds: string[];
};

function parseDocument(content: string): JsonNode | null {
  try {
    const parsed = JSON.parse(content || "{}");
    if (!parsed || parsed.type !== "doc" || !Array.isArray(parsed.content)) return null;
    return parsed as JsonNode;
  } catch {
    return null;
  }
}

/** Combine the established planner with the fail-closed single list hierarchy move planner. */
export function planTiptapBlockPatch(
  baseContent: string,
  nextContent: string,
): TiptapBlockPatchPlan | null {
  const basePlan = planBaseTiptapBlockPatch(baseContent, nextContent);
  if (basePlan) return basePlan;
  if (!baseContent || !nextContent || baseContent === nextContent) return null;
  const baseDoc = parseDocument(baseContent);
  const nextDoc = parseDocument(nextContent);
  if (!baseDoc || !nextDoc) return null;
  const operation = planTiptapListItemMove(baseDoc, nextDoc);
  if (!operation) return null;
  return {
    operations: [operation],
    kind: "list-hierarchy",
    affectedBlockIds: [operation.blockId, operation.targetBlockId],
  };
}
