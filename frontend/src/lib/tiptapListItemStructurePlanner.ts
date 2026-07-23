import type { BlockPatchOperation } from "@/lib/blockPatchApi";
import {
  normalizeSafeTiptapReplacementNode,
  type TiptapPatchJsonNode,
} from "@/lib/tiptapBlockPatchNode";

const BLOCK_ID_RE = /^blk_[A-Za-z0-9_-]{6,}$/;
const LIST_TYPES = new Set(["bulletList", "orderedList", "taskList"]);
const ITEM_TYPES = new Set(["listItem", "taskItem"]);

interface JsonNode {
  type?: string;
  attrs?: Record<string, unknown> | null;
  content?: JsonNode[];
  text?: string;
  marks?: unknown[];
  [key: string]: unknown;
}

interface NodeFrame {
  node: JsonNode;
  parent: JsonNode[];
  index: number;
}

interface ItemLocation {
  item: JsonNode;
  itemFrame: NodeFrame;
  list: JsonNode;
  listFrame: NodeFrame;
}

export interface TiptapListItemPatchNode {
  type: "listItem" | "taskItem";
  attrs: { blockId: string; checked?: boolean };
  content: [TiptapPatchJsonNode];
}

export type TiptapListItemStructureOperation =
  | {
      type: "create";
      scope: "listItem";
      clientId: string;
      blockId: string;
      targetBlockId: string;
      position: "before" | "after";
      node: TiptapListItemPatchNode;
    }
  | {
      type: "delete";
      scope: "listItem";
      blockId: string;
    };

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function validBlockId(value: unknown): value is string {
  return typeof value === "string" && BLOCK_ID_RE.test(value);
}

function exactKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function expectedItemType(listType: string): "listItem" | "taskItem" {
  return listType === "taskList" ? "taskItem" : "listItem";
}

function findPath(nodes: JsonNode[], blockId: string, ancestors: NodeFrame[] = []): NodeFrame[] | null {
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (!node || typeof node !== "object") continue;
    const frame = { node, parent: nodes, index };
    const path = [...ancestors, frame];
    if (node.attrs?.blockId === blockId) return path;
    if (Array.isArray(node.content)) {
      const nested = findPath(node.content, blockId, path);
      if (nested) return nested;
    }
  }
  return null;
}

function locateItem(doc: JsonNode, blockId: string): ItemLocation | null {
  const path = findPath(doc.content || [], blockId);
  if (!path || path.length < 2) return null;
  const itemFrame = path[path.length - 1];
  const listFrame = path[path.length - 2];
  const itemType = itemFrame.node.type || "";
  const listType = listFrame.node.type || "";
  if (!ITEM_TYPES.has(itemType) || !LIST_TYPES.has(listType)) return null;
  if (itemType !== expectedItemType(listType)) return null;
  if (listFrame.node.content !== itemFrame.parent) return null;
  return { item: itemFrame.node, itemFrame, list: listFrame.node, listFrame };
}

function normalizeItem(node: JsonNode, expectedBlockId: string): TiptapListItemPatchNode | null {
  if (!node || !exactKeys(node, ["type", "attrs", "content"])) return null;
  if (node.type !== "listItem" && node.type !== "taskItem") return null;
  if (!node.attrs || typeof node.attrs !== "object" || Array.isArray(node.attrs)) return null;
  const allowedAttrs = node.type === "taskItem" ? ["blockId", "checked"] : ["blockId"];
  if (!exactKeys(node.attrs, allowedAttrs) || node.attrs.blockId !== expectedBlockId) return null;
  if (node.type === "taskItem" && typeof node.attrs.checked !== "boolean") return null;
  if (!Array.isArray(node.content) || node.content.length !== 1) return null;
  const paragraphId = node.content[0]?.attrs?.blockId;
  if (!validBlockId(paragraphId) || paragraphId === expectedBlockId) return null;
  const paragraph = normalizeSafeTiptapReplacementNode(node.content[0], paragraphId);
  if (!paragraph || paragraph.type !== "paragraph") return null;
  return {
    type: node.type,
    attrs: node.type === "taskItem"
      ? { blockId: expectedBlockId, checked: node.attrs.checked as boolean }
      : { blockId: expectedBlockId },
    content: [paragraph],
  };
}

function collectItemIds(doc: JsonNode): Map<string, JsonNode> | null {
  const output = new Map<string, JsonNode>();
  let invalid = false;
  const visit = (nodes: JsonNode[], parentType: string) => {
    for (const node of nodes) {
      if (!node || typeof node !== "object") continue;
      if (ITEM_TYPES.has(node.type || "")) {
        const blockId = node.attrs?.blockId;
        if (
          !LIST_TYPES.has(parentType)
          || node.type !== expectedItemType(parentType)
          || !validBlockId(blockId)
          || output.has(blockId)
        ) {
          invalid = true;
          return;
        }
        output.set(blockId, node);
      }
      if (Array.isArray(node.content)) {
        visit(node.content, node.type || "");
        if (invalid) return;
      }
    }
  };
  visit(doc.content || [], "doc");
  return invalid ? null : output;
}

function collectAllBlockIds(doc: JsonNode): Set<string> | null {
  const output = new Set<string>();
  let invalid = false;
  const visit = (nodes: JsonNode[]) => {
    for (const node of nodes) {
      if (!node || typeof node !== "object") continue;
      const blockId = node.attrs?.blockId;
      if (blockId != null) {
        if (!validBlockId(blockId) || output.has(blockId)) {
          invalid = true;
          return;
        }
        output.add(blockId);
      }
      if (Array.isArray(node.content)) {
        visit(node.content);
        if (invalid) return;
      }
    }
  };
  visit(doc.content || []);
  return invalid ? null : output;
}

function removeListWrapperIfEmpty(location: ItemLocation): void {
  if ((location.list.content || []).length > 0) return;
  const index = location.listFrame.parent.indexOf(location.list);
  if (index >= 0) location.listFrame.parent.splice(index, 1);
}

function simulateCreate(
  doc: JsonNode,
  operation: Extract<TiptapListItemStructureOperation, { type: "create" }>,
): boolean {
  const target = locateItem(doc, operation.targetBlockId);
  if (!target || operation.node.type !== expectedItemType(target.list.type || "")) return false;
  const targetIndex = (target.list.content || []).indexOf(target.item);
  if (targetIndex < 0) return false;
  const destination = operation.position === "after" ? targetIndex + 1 : targetIndex;
  target.list.content!.splice(destination, 0, cloneJson(operation.node) as unknown as JsonNode);
  return true;
}

function simulateDelete(
  doc: JsonNode,
  operation: Extract<TiptapListItemStructureOperation, { type: "delete" }>,
): boolean {
  const source = locateItem(doc, operation.blockId);
  if (!source || !normalizeItem(source.item, operation.blockId)) return false;
  source.list.content!.splice(source.itemFrame.index, 1);
  removeListWrapperIfEmpty(source);
  return (doc.content || []).length > 0;
}

/** Prove that one leaf list-item create/delete reproduces the complete next Tiptap JSON. */
export function planTiptapListItemStructure(
  baseDoc: JsonNode,
  nextDoc: JsonNode,
): TiptapListItemStructureOperation | null {
  const baseItems = collectItemIds(baseDoc);
  const nextItems = collectItemIds(nextDoc);
  const baseBlockIds = collectAllBlockIds(baseDoc);
  const nextBlockIds = collectAllBlockIds(nextDoc);
  if (
    !baseItems
    || !nextItems
    || !baseBlockIds
    || !nextBlockIds
    || Math.max(baseItems.size, nextItems.size) > 5000
  ) {
    return null;
  }

  const addedItems = [...nextItems.keys()].filter((id) => !baseItems.has(id));
  const deletedItems = [...baseItems.keys()].filter((id) => !nextItems.has(id));
  const addedBlocks = [...nextBlockIds].filter((id) => !baseBlockIds.has(id));
  const deletedBlocks = [...baseBlockIds].filter((id) => !nextBlockIds.has(id));
  const targetJson = JSON.stringify(nextDoc);

  if (addedItems.length === 1 && deletedItems.length === 0) {
    const blockId = addedItems[0];
    const location = locateItem(nextDoc, blockId);
    const node = location ? normalizeItem(location.item, blockId) : null;
    const paragraphId = node?.content[0].attrs.blockId;
    if (
      !location
      || !node
      || !validBlockId(paragraphId)
      || addedBlocks.length !== 2
      || !addedBlocks.includes(blockId)
      || !addedBlocks.includes(paragraphId)
      || deletedBlocks.length > 0
    ) {
      return null;
    }

    const siblings = location.list.content || [];
    const index = siblings.indexOf(location.item);
    const candidates: TiptapListItemStructureOperation[] = [];
    const previousId = index > 0 ? siblings[index - 1]?.attrs?.blockId : null;
    const nextId = index + 1 < siblings.length ? siblings[index + 1]?.attrs?.blockId : null;
    if (validBlockId(previousId) && baseItems.has(previousId)) {
      candidates.push({
        type: "create",
        scope: "listItem",
        clientId: blockId,
        blockId,
        targetBlockId: previousId,
        position: "after",
        node,
      });
    }
    if (validBlockId(nextId) && baseItems.has(nextId)) {
      candidates.push({
        type: "create",
        scope: "listItem",
        clientId: blockId,
        blockId,
        targetBlockId: nextId,
        position: "before",
        node,
      });
    }
    for (const candidate of candidates) {
      const simulated = cloneJson(baseDoc);
      if (simulateCreate(simulated, candidate) && JSON.stringify(simulated) === targetJson) return candidate;
    }
    return null;
  }

  if (deletedItems.length === 1 && addedItems.length === 0) {
    const blockId = deletedItems[0];
    const source = baseItems.get(blockId);
    const normalized = source ? normalizeItem(source, blockId) : null;
    const paragraphId = normalized?.content[0].attrs.blockId;
    if (
      !source
      || !normalized
      || !validBlockId(paragraphId)
      || deletedBlocks.length !== 2
      || !deletedBlocks.includes(blockId)
      || !deletedBlocks.includes(paragraphId)
      || addedBlocks.length > 0
    ) {
      return null;
    }
    const operation: Extract<TiptapListItemStructureOperation, { type: "delete" }> = {
      type: "delete",
      scope: "listItem",
      blockId,
    };
    const simulated = cloneJson(baseDoc);
    return simulateDelete(simulated, operation) && JSON.stringify(simulated) === targetJson
      ? operation
      : null;
  }

  return null;
}

export function listItemStructureOperationForPatch(
  operation: TiptapListItemStructureOperation,
): BlockPatchOperation {
  return operation;
}
