import {
  applyTiptapListItemStructure,
  TiptapListItemStructureError,
  type TiptapListItemStructuralOperation,
} from "./tiptapListItemStructure.js";

export interface TiptapListItemStructurePatchResult {
  content: string;
  affectedBlockIds: string[];
  deletedBlockIds: string[];
  createdBlocks: Array<{ operationIndex: number; clientId: string | null; blockId: string }>;
}

/** Apply one scoped list-item create/delete request without changing the legacy batch engine. */
export function applyTiptapListItemStructurePatch(
  source: string,
  operation: TiptapListItemStructuralOperation,
): TiptapListItemStructurePatchResult {
  let doc: any;
  try {
    doc = JSON.parse(source || "{}");
  } catch {
    throw new TiptapListItemStructureError("LIST_STRUCTURE_INVALID", "富文本 JSON 无法解析");
  }
  if (!doc || doc.type !== "doc" || !Array.isArray(doc.content)) {
    throw new TiptapListItemStructureError("LIST_STRUCTURE_INVALID", "富文本必须是合法 doc.content 数组");
  }

  const result = applyTiptapListItemStructure(doc, operation);
  if (doc.content.length === 0) {
    throw new TiptapListItemStructureError(
      "LIST_STRUCTURE_INVALID",
      "删除最后一个列表项继续使用整篇保存与空文档 Block ID 对账",
    );
  }

  return {
    content: JSON.stringify(doc),
    affectedBlockIds: [...new Set(result.affectedBlockIds)],
    deletedBlockIds: result.deletedBlockIds,
    createdBlocks: operation.type === "create"
      ? [{
          operationIndex: 0,
          clientId: operation.clientId || null,
          blockId: operation.blockId,
        }]
      : [],
  };
}
