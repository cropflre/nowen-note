import type { BlockPatchOperation } from "@/lib/blockPatchApi";
import { normalizeSafeTiptapReplacementNode } from "@/lib/tiptapBlockPatchNode";
import {
  applyTiptapListItemMoveForPlanning,
} from "@/lib/tiptapListItemMovePlanner";
import {
  applyTiptapListItemStructureForPlanning,
  type TiptapListItemPatchNode,
  type TiptapListItemStructureOperation,
} from "@/lib/tiptapListItemStructurePlanner";

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

interface ItemEntry {
  id: string;
  node: JsonNode;
  listKey: string;
  listType: string;
  depth: number;
  paragraph: JsonNode | null;
}

interface ListEntry {
  key: string;
  type: string;
  depth: number;
  itemIds: string[];
}

interface Snapshot {
  blockIds: Set<string>;
  blocks: Map<string, JsonNode>;
  items: Map<string, ItemEntry>;
  lists: ListEntry[];
}

export interface TiptapListItemBatchPlan {
  operations: BlockPatchOperation[];
  affectedBlockIds: string[];
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function validBlockId(value: unknown): value is string {
  return typeof value === "string" && BLOCK_ID_RE.test(value);
}

function expectedItemType(listType: string): "listItem" | "taskItem" {
  return listType === "taskList" ? "taskItem" : "listItem";
}

function snapshot(doc: JsonNode): Snapshot | null {
  const blockIds = new Set<string>();
  const blocks = new Map<string, JsonNode>();
  const items = new Map<string, ItemEntry>();
  const lists: ListEntry[] = [];
  const listOrdinals = new Map<string, number>();
  let invalid = false;

  const visit = (nodes: JsonNode[], depth: number, parentItemId: string | null) => {
    for (const node of nodes) {
      if (!node || typeof node !== "object") continue;
      const blockId = node.attrs?.blockId;
      if (blockId != null) {
        if (!validBlockId(blockId) || blockIds.has(blockId)) {
          invalid = true;
          return;
        }
        blockIds.add(blockId);
        blocks.set(blockId, node);
      }

      if (LIST_TYPES.has(node.type || "")) {
        const ordinalBase = `${parentItemId || "root"}:${node.type}`;
        const ordinal = listOrdinals.get(ordinalBase) || 0;
        listOrdinals.set(ordinalBase, ordinal + 1);
        const key = `${ordinalBase}:${ordinal}`;
        const children = Array.isArray(node.content) ? node.content : [];
        const itemIds: string[] = [];
        for (const item of children) {
          const itemId = item.attrs?.blockId;
          if (
            !ITEM_TYPES.has(item.type || "")
            || item.type !== expectedItemType(node.type || "")
            || !validBlockId(itemId)
          ) {
            invalid = true;
            return;
          }
          if (blockIds.has(itemId)) {
            invalid = true;
            return;
          }
          blockIds.add(itemId);
          blocks.set(itemId, item);
          itemIds.push(itemId);
          const paragraphs = (item.content || []).filter((child) => child.type === "paragraph");
          items.set(itemId, {
            id: itemId,
            node: item,
            listKey: key,
            listType: node.type || "",
            depth: depth + 1,
            paragraph: paragraphs.length === 1 ? paragraphs[0] : null,
          });
          visit(item.content || [], depth + 1, itemId);
          if (invalid) return;
        }
        lists.push({ key, type: node.type || "", depth: depth + 1, itemIds });
        continue;
      }
      if (Array.isArray(node.content)) {
        visit(node.content, depth, parentItemId);
        if (invalid) return;
      }
    }
  };

  visit(doc.content || [], 0, null);
  return invalid ? null : { blockIds, blocks, items, lists };
}

function normalizedItem(entry: ItemEntry): TiptapListItemPatchNode | null {
  const node = entry.node;
  if (!entry.paragraph || !node.attrs || !validBlockId(node.attrs.blockId)) return null;
  if (!Array.isArray(node.content) || node.content.length !== 1) return null;
  const paragraphId = entry.paragraph.attrs?.blockId;
  if (!validBlockId(paragraphId) || paragraphId === entry.id) return null;
  const paragraph = normalizeSafeTiptapReplacementNode(entry.paragraph, paragraphId);
  if (!paragraph || paragraph.type !== "paragraph") return null;
  if (node.type === "taskItem" && typeof node.attrs.checked !== "boolean") return null;
  const attrKeys = Object.keys(node.attrs);
  if (node.type === "taskItem") {
    if (attrKeys.some((key) => key !== "blockId" && key !== "checked")) return null;
  } else if (attrKeys.some((key) => key !== "blockId")) {
    return null;
  }
  return {
    type: node.type as "listItem" | "taskItem",
    attrs: node.type === "taskItem"
      ? { blockId: entry.id, checked: node.attrs.checked as boolean }
      : { blockId: entry.id },
    content: [paragraph],
  };
}

function locateItem(doc: JsonNode, blockId: string): { item: JsonNode; list: JsonNode; depth: number } | null {
  const visit = (nodes: JsonNode[], depth: number): { item: JsonNode; list: JsonNode; depth: number } | null => {
    for (const node of nodes) {
      if (LIST_TYPES.has(node.type || "")) {
        for (const item of node.content || []) {
          if (item.attrs?.blockId === blockId) return { item, list: node, depth: depth + 1 };
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

function applyReplacement(doc: JsonNode, operation: Extract<BlockPatchOperation, { type: "replace" }>): boolean {
  const visit = (nodes: JsonNode[]): boolean => {
    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes[index];
      if (node.attrs?.blockId === operation.blockId) {
        nodes[index] = cloneJson(operation.node) as JsonNode;
        return true;
      }
      if (Array.isArray(node.content) && visit(node.content)) return true;
    }
    return false;
  };
  return visit(doc.content || []);
}

function itemPayloadWithoutLists(node: JsonNode): string {
  const copy = cloneJson(node);
  copy.content = (copy.content || []).filter((child) => !LIST_TYPES.has(child.type || ""));
  return JSON.stringify(copy);
}

function nonListSkeleton(doc: JsonNode): string {
  const copy = cloneJson(doc);
  const strip = (nodes: JsonNode[]): JsonNode[] => nodes.map((node) => {
    if (LIST_TYPES.has(node.type || "")) return { type: node.type, content: [] };
    if (Array.isArray(node.content)) node.content = strip(node.content);
    return node;
  });
  copy.content = strip(copy.content || []);
  return JSON.stringify(copy);
}

/**
 * Plan a bounded ordered batch of list-item edits. The complete simulated JSON must equal the
 * editor snapshot, so unsupported wrappers, type conversions and ambiguous parents fail closed.
 */
export function planTiptapListItemBatch(baseDoc: JsonNode, nextDoc: JsonNode): TiptapListItemBatchPlan | null {
  if (nonListSkeleton(baseDoc) !== nonListSkeleton(nextDoc)) return null;
  const before = snapshot(baseDoc);
  const after = snapshot(nextDoc);
  if (!before || !after || Math.max(before.items.size, after.items.size) > 5000) return null;

  const addedItems = [...after.items.keys()].filter((id) => !before.items.has(id));
  const deletedItems = [...before.items.keys()].filter((id) => !after.items.has(id));

  const expectedAddedBlocks = new Set<string>();
  for (const id of addedItems) {
    const item = after.items.get(id)!;
    const normalized = normalizedItem(item);
    const paragraphId = normalized?.content[0].attrs.blockId;
    if (!normalized || !validBlockId(paragraphId)) return null;
    expectedAddedBlocks.add(id);
    expectedAddedBlocks.add(paragraphId);
  }
  const expectedDeletedBlocks = new Set<string>();
  for (const id of deletedItems) {
    const item = before.items.get(id)!;
    const normalized = normalizedItem(item);
    const paragraphId = normalized?.content[0].attrs.blockId;
    if (!normalized || !validBlockId(paragraphId)) return null;
    expectedDeletedBlocks.add(id);
    expectedDeletedBlocks.add(paragraphId);
  }
  const actualAddedBlocks = [...after.blockIds].filter((id) => !before.blockIds.has(id));
  const actualDeletedBlocks = [...before.blockIds].filter((id) => !after.blockIds.has(id));
  if (
    actualAddedBlocks.length !== expectedAddedBlocks.size
    || actualAddedBlocks.some((id) => !expectedAddedBlocks.has(id))
    || actualDeletedBlocks.length !== expectedDeletedBlocks.size
    || actualDeletedBlocks.some((id) => !expectedDeletedBlocks.has(id))
  ) return null;

  const operations: BlockPatchOperation[] = [];
  const simulated = cloneJson(baseDoc);

  for (const [id, previous] of before.items) {
    const next = after.items.get(id);
    if (!next) continue;
    if (previous.node.type !== next.node.type || previous.listType !== next.listType) return null;
    const previousWithoutLists = itemPayloadWithoutLists(previous.node);
    const nextWithoutLists = itemPayloadWithoutLists(next.node);
    if (previousWithoutLists === nextWithoutLists) continue;
    if (!previous.paragraph || !next.paragraph) return null;
    const paragraphId = next.paragraph.attrs?.blockId;
    if (!validBlockId(paragraphId) || previous.paragraph.attrs?.blockId !== paragraphId) return null;
    const normalized = normalizeSafeTiptapReplacementNode(next.paragraph, paragraphId);
    if (!normalized || normalized.type !== "paragraph") return null;
    const operation: Extract<BlockPatchOperation, { type: "replace" }> = {
      type: "replace",
      blockId: paragraphId,
      node: normalized,
    };
    operations.push(operation);
    if (!applyReplacement(simulated, operation)) return null;
  }

  for (const id of deletedItems) {
    const operation: TiptapListItemStructureOperation = { type: "delete", scope: "listItem", blockId: id };
    operations.push(operation);
    if (!applyTiptapListItemStructureForPlanning(simulated, operation)) return null;
  }

  const pending = new Set(addedItems);
  while (pending.size > 0) {
    let progressed = false;
    for (const id of [...pending]) {
      const entry = after.items.get(id)!;
      const desiredList = after.lists.find((list) => list.key === entry.listKey);
      const normalized = normalizedItem(entry);
      if (!desiredList || !normalized) return null;
      const index = desiredList.itemIds.indexOf(id);
      const previousId = index > 0 ? desiredList.itemIds[index - 1] : null;
      const nextId = index + 1 < desiredList.itemIds.length ? desiredList.itemIds[index + 1] : null;
      const targetId = previousId && locateItem(simulated, previousId)
        ? previousId
        : nextId && locateItem(simulated, nextId)
          ? nextId
          : null;
      if (!targetId) continue;
      const operation: TiptapListItemStructureOperation = {
        type: "create",
        scope: "listItem",
        clientId: id,
        blockId: id,
        targetBlockId: targetId,
        position: targetId === previousId ? "after" : "before",
        node: normalized,
      };
      if (!applyTiptapListItemStructureForPlanning(simulated, operation)) return null;
      operations.push(operation);
      pending.delete(id);
      progressed = true;
    }
    if (!progressed) return null;
  }

  for (const desiredList of after.lists) {
    if (desiredList.itemIds.length < 2) continue;
    const anchor = desiredList.itemIds
      .map((id) => locateItem(simulated, id))
      .find(Boolean);
    if (!anchor) return null;
    const destination = anchor.list;
    for (let index = 0; index < desiredList.itemIds.length; index += 1) {
      const desiredId = desiredList.itemIds[index];
      const currentIds = (destination.content || []).map((item) => item.attrs?.blockId).filter(validBlockId);
      if (currentIds[index] === desiredId) continue;
      const targetId = currentIds[index] || currentIds[currentIds.length - 1];
      if (!targetId || targetId === desiredId) continue;
      const operation = {
        type: "move" as const,
        scope: "listItem" as const,
        blockId: desiredId,
        targetBlockId: targetId,
        position: currentIds[index] ? "before" as const : "after" as const,
      };
      if (!applyTiptapListItemMoveForPlanning(simulated, operation)) return null;
      operations.push(operation);
    }
  }

  if (operations.length < 2 || operations.length > 100) return null;
  if (JSON.stringify(simulated) !== JSON.stringify(nextDoc)) return null;
  return {
    operations,
    affectedBlockIds: [...new Set(operations.flatMap((operation): string[] => {
      if (operation.type === "create") {
        return operation.scope === "listItem"
          ? [operation.blockId, operation.targetBlockId, operation.node.content[0].attrs.blockId]
            .filter(validBlockId)
          : operation.blockId ? [operation.blockId] : [];
      }
      if (operation.type === "move") return [operation.blockId, operation.targetBlockId];
      return [operation.blockId];
    }))],
  };
}
