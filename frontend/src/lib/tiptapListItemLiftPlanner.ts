import type { BlockPatchOperation } from "@/lib/blockPatchApi";

const BLOCK_ID_RE = /^blk_[A-Za-z0-9_-]{6,}$/;
const LIST_TYPES = new Set(["bulletList", "orderedList", "taskList"]);
const ITEM_TYPES = new Set(["listItem", "taskItem"]);

interface JsonNode {
  type?: string;
  attrs?: Record<string, unknown> | null;
  content?: JsonNode[];
  [key: string]: unknown;
}

type LiftOperation = Extract<BlockPatchOperation, { type: "lift" }>;

interface ItemLocation {
  item: JsonNode;
  list: JsonNode;
  listParent: JsonNode[];
  depth: number;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function validBlockId(value: unknown): value is string {
  return typeof value === "string" && BLOCK_ID_RE.test(value);
}

function collectIds(doc: JsonNode): Set<string> | null {
  const output = new Set<string>();
  let invalid = false;
  const visit = (nodes: JsonNode[]) => {
    for (const node of nodes) {
      const id = node.attrs?.blockId;
      if (id != null) {
        if (!validBlockId(id) || output.has(id)) {
          invalid = true;
          return;
        }
        output.add(id);
      }
      if (Array.isArray(node.content)) visit(node.content);
      if (invalid) return;
    }
  };
  visit(doc.content || []);
  return invalid ? null : output;
}

function collectItemIds(doc: JsonNode): Set<string> | null {
  const output = new Set<string>();
  let invalid = false;
  const visit = (nodes: JsonNode[]) => {
    for (const node of nodes) {
      if (ITEM_TYPES.has(node.type || "")) {
        const id = node.attrs?.blockId;
        if (!validBlockId(id) || output.has(id)) {
          invalid = true;
          return;
        }
        output.add(id);
      }
      if (Array.isArray(node.content)) visit(node.content);
      if (invalid) return;
    }
  };
  visit(doc.content || []);
  return invalid ? null : output;
}

function locateItem(doc: JsonNode, blockId: string): ItemLocation | null {
  const visit = (nodes: JsonNode[], depth: number): ItemLocation | null => {
    for (const node of nodes) {
      if (LIST_TYPES.has(node.type || "")) {
        for (const item of node.content || []) {
          if (item.attrs?.blockId === blockId) {
            return { item, list: node, listParent: nodes, depth: depth + 1 };
          }
          const nested = visit(item.content || [], depth + 1);
          if (nested) return nested;
        }
      } else if (Array.isArray(node.content)) {
        const nested = visit(node.content, depth);
        if (nested) return nested;
      }
    }
    return null;
  };
  return visit(doc.content || [], 0);
}

function applyLift(doc: JsonNode, operation: LiftOperation): boolean {
  const source = locateItem(doc, operation.blockId);
  if (!source || source.depth !== 1 || source.listParent !== doc.content) return false;
  if (!Array.isArray(source.item.content) || source.item.content.length !== 1) return false;
  const paragraph = source.item.content[0];
  if (paragraph.type !== "paragraph" || !validBlockId(paragraph.attrs?.blockId)) return false;
  const listIndex = source.listParent.indexOf(source.list);
  const itemIndex = source.list.content?.indexOf(source.item) ?? -1;
  if (listIndex < 0 || itemIndex < 0 || !Array.isArray(source.list.content)) return false;
  source.list.content.splice(itemIndex, 1);
  if (source.list.content.length === 0) {
    source.listParent.splice(listIndex, 1, paragraph);
  } else {
    source.listParent.splice(operation.position === "before" ? listIndex : listIndex + 1, 0, paragraph);
  }
  return true;
}

/** Prove one top-level list-item lift into its existing paragraph Block. */
export function planTiptapListItemTopLevelLift(baseDoc: JsonNode, nextDoc: JsonNode): LiftOperation | null {
  const baseItems = collectItemIds(baseDoc);
  const nextItems = collectItemIds(nextDoc);
  const baseIds = collectIds(baseDoc);
  const nextIds = collectIds(nextDoc);
  if (!baseItems || !nextItems || !baseIds || !nextIds) return null;
  const deletedItems = [...baseItems].filter((id) => !nextItems.has(id));
  const addedItems = [...nextItems].filter((id) => !baseItems.has(id));
  const deletedBlocks = [...baseIds].filter((id) => !nextIds.has(id));
  const addedBlocks = [...nextIds].filter((id) => !baseIds.has(id));
  if (
    deletedItems.length !== 1
    || addedItems.length !== 0
    || deletedBlocks.length !== 1
    || deletedBlocks[0] !== deletedItems[0]
    || addedBlocks.length !== 0
  ) return null;

  const blockId = deletedItems[0];
  const source = locateItem(baseDoc, blockId);
  if (!source || source.depth !== 1 || source.listParent !== baseDoc.content) return null;
  if (!Array.isArray(source.item.content) || source.item.content.length !== 1) return null;
  const paragraph = source.item.content[0];
  const paragraphId = paragraph.attrs?.blockId;
  if (paragraph.type !== "paragraph" || !validBlockId(paragraphId)) return null;

  for (const position of ["before", "after"] as const) {
    const operation: LiftOperation = { type: "lift", scope: "listItem", blockId, position };
    const simulated = cloneJson(baseDoc);
    if (applyLift(simulated, operation) && JSON.stringify(simulated) === JSON.stringify(nextDoc)) {
      return operation;
    }
  }
  return null;
}
