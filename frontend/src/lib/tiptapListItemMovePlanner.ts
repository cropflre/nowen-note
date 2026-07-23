import type { BlockPatchOperation } from "@/lib/blockPatchApi";

const BLOCK_ID_RE = /^blk_[A-Za-z0-9_-]{6,}$/;
const LIST_TYPES = new Set(["bulletList", "orderedList", "taskList"]);
const ITEM_TYPES = new Set(["listItem", "taskItem"]);

type ListMoveOperation = Extract<BlockPatchOperation, { type: "move"; scope: "listItem" }>;

interface JsonNode {
  type?: string;
  attrs?: Record<string, unknown> | null;
  content?: JsonNode[];
  text?: string;
  [key: string]: unknown;
}

interface NodeFrame {
  node: JsonNode;
  parent: JsonNode[];
  index: number;
}

interface ListItemLocation {
  item: JsonNode;
  list: JsonNode;
  listFrame: NodeFrame;
  depth: number;
  parentItemFrame: NodeFrame | null;
  outerListFrame: NodeFrame | null;
}

interface ItemDescriptor {
  id: string;
  itemType: string;
  listType: string;
  depth: number;
  parentItemId: string | null;
  previousId: string | null;
  nextId: string | null;
  payload: string;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function validBlockId(value: unknown): value is string {
  return typeof value === "string" && BLOCK_ID_RE.test(value);
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

function locateListItem(doc: JsonNode, blockId: string): ListItemLocation | null {
  if (!Array.isArray(doc.content)) return null;
  const path = findPath(doc.content, blockId);
  if (!path || path.length < 2) return null;
  const itemFrame = path[path.length - 1];
  const listFrame = path[path.length - 2];
  if (!ITEM_TYPES.has(itemFrame.node.type || "") || !LIST_TYPES.has(listFrame.node.type || "")) {
    return null;
  }
  if (listFrame.node.content !== itemFrame.parent) return null;

  let parentItemFrame: NodeFrame | null = null;
  let outerListFrame: NodeFrame | null = null;
  for (let index = path.length - 3; index >= 0; index -= 1) {
    if (!ITEM_TYPES.has(path[index].node.type || "")) continue;
    parentItemFrame = path[index];
    if (index > 0 && LIST_TYPES.has(path[index - 1].node.type || "")) {
      outerListFrame = path[index - 1];
    }
    break;
  }

  return {
    item: itemFrame.node,
    list: listFrame.node,
    listFrame,
    depth: path.filter((frame) => LIST_TYPES.has(frame.node.type || "")).length,
    parentItemFrame,
    outerListFrame,
  };
}

function expectedItemType(listType: string): string {
  return listType === "taskList" ? "taskItem" : "listItem";
}

function compatible(source: ListItemLocation, target: ListItemLocation): boolean {
  return source.item.type === target.item.type
    && source.list.type === target.list.type
    && source.item.type === expectedItemType(source.list.type || "");
}

function removeListWrapperIfEmpty(location: ListItemLocation): void {
  if ((location.list.content || []).length > 0) return;
  const currentIndex = location.listFrame.parent.indexOf(location.list);
  if (currentIndex >= 0) location.listFrame.parent.splice(currentIndex, 1);
}

function nestedListForSink(target: ListItemLocation): JsonNode | null {
  const children = Array.isArray(target.item.content) ? target.item.content : [];
  const nestedLists = children.filter((child) => LIST_TYPES.has(child.type || ""));
  if (nestedLists.some((child) => child.type !== target.list.type) || nestedLists.length > 1) {
    return null;
  }
  if (nestedLists.length === 1) return nestedLists[0];
  const attrs = target.list.attrs && typeof target.list.attrs === "object"
    ? cloneJson(target.list.attrs)
    : null;
  const nested: JsonNode = {
    type: target.list.type,
    ...(attrs && Object.keys(attrs).length > 0 ? { attrs } : {}),
    content: [],
  };
  if (!Array.isArray(target.item.content)) target.item.content = [];
  target.item.content.push(nested);
  return nested;
}

function applyListMove(doc: JsonNode, operation: ListMoveOperation): boolean {
  const source = locateListItem(doc, operation.blockId);
  const target = locateListItem(doc, operation.targetBlockId);
  if (!source || !target || !compatible(source, target) || source.item === target.item) return false;

  if (operation.position === "inside") {
    if (source.list !== target.list || source.depth !== target.depth) return false;
    const sourceIndex = source.list.content?.indexOf(source.item) ?? -1;
    const targetIndex = source.list.content?.indexOf(target.item) ?? -1;
    if (sourceIndex < 1 || targetIndex !== sourceIndex - 1) return false;
    const nested = nestedListForSink(target);
    if (!nested || !Array.isArray(nested.content) || !Array.isArray(source.list.content)) return false;
    source.list.content.splice(sourceIndex, 1);
    nested.content.push(source.item);
    return true;
  }

  const isLift = operation.position === "after" && source.depth === target.depth + 1;
  if (isLift) {
    if (
      source.parentItemFrame?.node !== target.item
      || !source.outerListFrame
      || source.outerListFrame.node !== target.list
      || source.listFrame.parent !== target.item.content
      || !Array.isArray(source.list.content)
      || !Array.isArray(target.list.content)
    ) return false;
    const sourceIndex = source.list.content.indexOf(source.item);
    if (sourceIndex < 0) return false;
    source.list.content.splice(sourceIndex, 1);
    removeListWrapperIfEmpty(source);
    const targetIndex = target.list.content.indexOf(target.item);
    if (targetIndex < 0) return false;
    target.list.content.splice(targetIndex + 1, 0, source.item);
    return true;
  }

  if (source.depth !== target.depth || !Array.isArray(source.list.content) || !Array.isArray(target.list.content)) {
    return false;
  }
  const sourceIndex = source.list.content.indexOf(source.item);
  if (sourceIndex < 0) return false;
  source.list.content.splice(sourceIndex, 1);
  if (source.list !== target.list) removeListWrapperIfEmpty(source);
  const targetIndex = target.list.content.indexOf(target.item);
  if (targetIndex < 0) return false;
  target.list.content.splice(operation.position === "after" ? targetIndex + 1 : targetIndex, 0, source.item);
  return true;
}

function itemPayload(node: JsonNode): string {
  const clone = cloneJson(node);
  clone.content = (clone.content || []).filter((child) => !LIST_TYPES.has(child.type || ""));
  return JSON.stringify(clone);
}

function collectDescriptors(doc: JsonNode): Map<string, ItemDescriptor> | null {
  const output = new Map<string, ItemDescriptor>();
  let invalid = false;

  const visit = (nodes: JsonNode[], depth: number, parentItemId: string | null) => {
    for (const node of nodes) {
      if (!node || typeof node !== "object") continue;
      if (LIST_TYPES.has(node.type || "")) {
        const items = Array.isArray(node.content) ? node.content : [];
        for (let index = 0; index < items.length; index += 1) {
          const item = items[index];
          const id = item.attrs?.blockId;
          if (
            !ITEM_TYPES.has(item.type || "")
            || !validBlockId(id)
            || output.has(id)
            || item.type !== expectedItemType(node.type || "")
          ) {
            invalid = true;
            return;
          }
          const previousId = index > 0 ? items[index - 1]?.attrs?.blockId : null;
          const nextId = index + 1 < items.length ? items[index + 1]?.attrs?.blockId : null;
          if ((previousId != null && !validBlockId(previousId)) || (nextId != null && !validBlockId(nextId))) {
            invalid = true;
            return;
          }
          output.set(id, {
            id,
            itemType: item.type || "",
            listType: node.type || "",
            depth: depth + 1,
            parentItemId,
            previousId: previousId || null,
            nextId: nextId || null,
            payload: itemPayload(item),
          });
          visit(item.content || [], depth + 1, id);
          if (invalid) return;
        }
        continue;
      }
      if (Array.isArray(node.content)) {
        visit(node.content, depth, parentItemId);
        if (invalid) return;
      }
    }
  };

  visit(doc.content || [], 0, null);
  return invalid || output.size === 0 ? null : output;
}

function nonListSkeleton(doc: JsonNode): string {
  const clone = cloneJson(doc);
  const strip = (nodes: JsonNode[]): JsonNode[] => nodes
    .filter((node) => !LIST_TYPES.has(node.type || ""))
    .map((node) => {
      if (Array.isArray(node.content)) node.content = strip(node.content);
      return node;
    });
  clone.content = strip(clone.content || []);
  return JSON.stringify(clone);
}

function descriptorChanged(left: ItemDescriptor, right: ItemDescriptor): boolean {
  return left.parentItemId !== right.parentItemId
    || left.depth !== right.depth
    || left.previousId !== right.previousId
    || left.nextId !== right.nextId
    || left.listType !== right.listType;
}

function operationRank(
  operation: ListMoveOperation,
  base: Map<string, ItemDescriptor>,
  next: Map<string, ItemDescriptor>,
): string {
  const before = base.get(operation.blockId);
  const after = next.get(operation.blockId);
  const hierarchyChanged = before && after && (
    before.depth !== after.depth || before.parentItemId !== after.parentItemId
  );
  const semanticRank = operation.position === "inside" ? 0 : hierarchyChanged ? 1 : 2;
  const positionRank = operation.position === "before" ? 0 : operation.position === "after" ? 1 : 2;
  return `${semanticRank}:${positionRank}:${operation.blockId}:${operation.targetBlockId}`;
}

/**
 * Prove that one controlled list item move can reproduce the complete target JSON. Content, marks,
 * checked state and non-list structure must remain byte-for-byte equivalent. When two equivalent
 * moves produce the same target (for example an adjacent swap), a stable rank selects one request.
 */
export function planTiptapListItemMove(
  baseDoc: JsonNode,
  nextDoc: JsonNode,
): ListMoveOperation | null {
  if (nonListSkeleton(baseDoc) !== nonListSkeleton(nextDoc)) return null;
  const base = collectDescriptors(baseDoc);
  const next = collectDescriptors(nextDoc);
  if (!base || !next || base.size !== next.size || base.size > 5000) return null;

  for (const [id, before] of base) {
    const after = next.get(id);
    if (!after || before.itemType !== after.itemType || before.payload !== after.payload) return null;
  }

  const changedIds = [...base.keys()].filter((id) => descriptorChanged(base.get(id)!, next.get(id)!));
  if (changedIds.length === 0 || changedIds.length > 8) return null;

  const candidates = new Map<string, ListMoveOperation>();
  const add = (operation: ListMoveOperation) => {
    if (!validBlockId(operation.targetBlockId) || operation.blockId === operation.targetBlockId) return;
    candidates.set(JSON.stringify(operation), operation);
  };

  for (const blockId of changedIds) {
    const before = base.get(blockId)!;
    const after = next.get(blockId)!;
    if (after.parentItemId && after.depth === before.depth + 1) {
      add({ type: "move", scope: "listItem", blockId, targetBlockId: after.parentItemId, position: "inside" });
    }
    if (after.previousId) {
      add({ type: "move", scope: "listItem", blockId, targetBlockId: after.previousId, position: "after" });
    }
    if (after.nextId) {
      add({ type: "move", scope: "listItem", blockId, targetBlockId: after.nextId, position: "before" });
    }
    if (before.parentItemId && after.depth === before.depth - 1) {
      add({ type: "move", scope: "listItem", blockId, targetBlockId: before.parentItemId, position: "after" });
    }
  }

  const targetJson = JSON.stringify(nextDoc);
  const matches: ListMoveOperation[] = [];
  for (const operation of candidates.values()) {
    const simulated = cloneJson(baseDoc);
    if (applyListMove(simulated, operation) && JSON.stringify(simulated) === targetJson) {
      matches.push(operation);
    }
  }
  matches.sort((left, right) => operationRank(left, base, next).localeCompare(operationRank(right, base, next)));
  return matches[0] || null;
}
