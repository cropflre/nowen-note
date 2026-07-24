import {
  normalizeTiptapReplacementNode,
  TiptapBlockNodeValidationError,
  type TiptapPatchJsonNode,
} from "./tiptapBlockPatchNode.js";

const BLOCK_ID_RE = /^blk_[A-Za-z0-9_-]{6,}$/;
const LIST_TYPES = new Set(["bulletList", "orderedList", "taskList"]);
const ITEM_TYPES = new Set(["listItem", "taskItem"]);
const ITEM_NODE_MAX_BYTES = 256 * 1024;

export interface TiptapListItemCreateOperation {
  type: "create";
  scope: "listItem";
  clientId?: string;
  blockId: string;
  targetBlockId: string;
  position: "before" | "after";
  node: TiptapListItemPatchNode;
}

export interface TiptapListItemDeleteOperation {
  type: "delete";
  scope: "listItem";
  blockId: string;
}

export type TiptapListItemStructuralOperation =
  | TiptapListItemCreateOperation
  | TiptapListItemDeleteOperation;

export interface TiptapListItemPatchNode {
  type: "listItem" | "taskItem";
  attrs: {
    blockId: string;
    checked?: boolean;
  };
  content: [TiptapPatchJsonNode];
}

export interface TiptapListItemStructureResult {
  affectedBlockIds: string[];
  createdBlockIds: string[];
  deletedBlockIds: string[];
}

export class TiptapListItemStructureError extends Error {
  constructor(
    readonly code:
      | "INVALID_BLOCK_NODE"
      | "BLOCK_ID_CONFLICT"
      | "BLOCK_NOT_FOUND"
      | "LIST_STRUCTURE_INVALID",
    message: string,
  ) {
    super(message);
    this.name = "TiptapListItemStructureError";
  }
}

interface NodeFrame {
  node: any;
  parent: any[];
  index: number;
}

interface ListItemLocation {
  item: any;
  itemFrame: NodeFrame;
  list: any;
  listFrame: NodeFrame;
  parentItemFrame: NodeFrame | null;
}

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

function findPath(nodes: any[], blockId: string, ancestors: NodeFrame[] = []): NodeFrame[] | null {
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

function locateListItem(doc: any, blockId: string): ListItemLocation {
  const path = findPath(doc.content, blockId);
  if (!path || path.length < 2) {
    throw new TiptapListItemStructureError("BLOCK_NOT_FOUND", `列表项不存在: ${blockId}`);
  }
  const itemFrame = path[path.length - 1];
  const listFrame = path[path.length - 2];
  if (!ITEM_TYPES.has(itemFrame.node?.type) || !LIST_TYPES.has(listFrame.node?.type)) {
    throw new TiptapListItemStructureError("LIST_STRUCTURE_INVALID", `目标不是受支持的列表项: ${blockId}`);
  }
  if (itemFrame.node.type !== expectedItemType(listFrame.node.type)) {
    throw new TiptapListItemStructureError("LIST_STRUCTURE_INVALID", "列表项类型与父列表不兼容");
  }
  if (listFrame.node.content !== itemFrame.parent) {
    throw new TiptapListItemStructureError("LIST_STRUCTURE_INVALID", "列表项父容器无效");
  }

  let parentItemFrame: NodeFrame | null = null;
  for (let index = path.length - 3; index >= 0; index -= 1) {
    if (ITEM_TYPES.has(path[index].node?.type)) {
      parentItemFrame = path[index];
      break;
    }
  }
  return {
    item: itemFrame.node,
    itemFrame,
    list: listFrame.node,
    listFrame,
    parentItemFrame,
  };
}

function collectBlockIds(node: any, output = new Set<string>()): Set<string> {
  if (!node || typeof node !== "object") return output;
  const blockId = node.attrs?.blockId;
  if (validBlockId(blockId)) output.add(blockId);
  for (const child of Array.isArray(node.content) ? node.content : []) collectBlockIds(child, output);
  return output;
}

function allDocumentBlockIds(doc: any): Set<string> {
  const output = new Set<string>();
  for (const node of Array.isArray(doc?.content) ? doc.content : []) collectBlockIds(node, output);
  return output;
}

function removeListWrapperIfEmpty(location: ListItemLocation): void {
  if (location.list.content.length > 0) return;
  const currentIndex = location.listFrame.parent.indexOf(location.list);
  if (currentIndex >= 0) location.listFrame.parent.splice(currentIndex, 1);
}

function normalizeParagraph(raw: unknown): TiptapPatchJsonNode {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TiptapListItemStructureError("INVALID_BLOCK_NODE", "列表项必须包含一个段落");
  }
  const blockId = (raw as any).attrs?.blockId;
  if (!validBlockId(blockId)) {
    throw new TiptapListItemStructureError("INVALID_BLOCK_NODE", "列表项段落缺少有效 Block ID");
  }
  try {
    const normalized = normalizeTiptapReplacementNode(raw, blockId);
    if (normalized.type !== "paragraph") {
      throw new TiptapListItemStructureError("INVALID_BLOCK_NODE", "列表项 V1 只允许一个 paragraph 子块");
    }
    return normalized;
  } catch (error) {
    if (error instanceof TiptapListItemStructureError) throw error;
    const message = error instanceof TiptapBlockNodeValidationError
      ? error.message
      : "列表项段落无效";
    throw new TiptapListItemStructureError("INVALID_BLOCK_NODE", message);
  }
}

/** Validate and canonicalize one leaf list item supplied by a scoped create request. */
export function normalizeTiptapListItemPatchNode(
  raw: unknown,
  expectedBlockId: string,
): TiptapListItemPatchNode {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TiptapListItemStructureError("INVALID_BLOCK_NODE", "create.node 必须是列表项对象");
  }
  if (JSON.stringify(raw).length > ITEM_NODE_MAX_BYTES) {
    throw new TiptapListItemStructureError("INVALID_BLOCK_NODE", "列表项节点超过 256 KB");
  }
  const node = raw as Record<string, any>;
  if (!exactKeys(node, ["type", "attrs", "content"])) {
    throw new TiptapListItemStructureError("INVALID_BLOCK_NODE", "列表项包含未知字段");
  }
  if (node.type !== "listItem" && node.type !== "taskItem") {
    throw new TiptapListItemStructureError("INVALID_BLOCK_NODE", "仅支持 listItem 或 taskItem");
  }
  if (!node.attrs || typeof node.attrs !== "object" || Array.isArray(node.attrs)) {
    throw new TiptapListItemStructureError("INVALID_BLOCK_NODE", "列表项 attrs 无效");
  }
  const allowedAttrs = node.type === "taskItem" ? ["blockId", "checked"] : ["blockId"];
  if (!exactKeys(node.attrs, allowedAttrs)) {
    throw new TiptapListItemStructureError("INVALID_BLOCK_NODE", "列表项包含未知 attrs");
  }
  if (node.attrs.blockId !== expectedBlockId || !validBlockId(node.attrs.blockId)) {
    throw new TiptapListItemStructureError("INVALID_BLOCK_NODE", "列表项 Block ID 与操作目标不一致");
  }
  if (node.type === "taskItem" && typeof node.attrs.checked !== "boolean") {
    throw new TiptapListItemStructureError("INVALID_BLOCK_NODE", "taskItem.checked 必须是布尔值");
  }
  if (!Array.isArray(node.content) || node.content.length !== 1) {
    throw new TiptapListItemStructureError(
      "INVALID_BLOCK_NODE",
      "列表项创建 V1 只允许一个段落，不支持嵌套列表或多段落",
    );
  }
  const paragraph = normalizeParagraph(node.content[0]);
  if (paragraph.attrs.blockId === expectedBlockId) {
    throw new TiptapListItemStructureError("INVALID_BLOCK_NODE", "列表项和段落不能使用相同 Block ID");
  }
  return {
    type: node.type,
    attrs: node.type === "taskItem"
      ? { blockId: expectedBlockId, checked: node.attrs.checked }
      : { blockId: expectedBlockId },
    content: [paragraph],
  };
}

function ensureLeafItem(location: ListItemLocation): string[] {
  if (!Array.isArray(location.item.content) || location.item.content.length !== 1) {
    throw new TiptapListItemStructureError(
      "LIST_STRUCTURE_INVALID",
      "列表项删除 V1 只支持不含嵌套列表的单段落项",
    );
  }
  const child = location.item.content[0];
  if (child?.type !== "paragraph" || !validBlockId(child.attrs?.blockId)) {
    throw new TiptapListItemStructureError("LIST_STRUCTURE_INVALID", "列表项段落结构无效");
  }
  return [location.item.attrs.blockId, child.attrs.blockId];
}

/** Apply one scoped list-item create/delete operation to a mutable Tiptap document. */
export function applyTiptapListItemStructure(
  doc: any,
  operation: TiptapListItemStructuralOperation,
): TiptapListItemStructureResult {
  if (!doc || doc.type !== "doc" || !Array.isArray(doc.content)) {
    throw new TiptapListItemStructureError("LIST_STRUCTURE_INVALID", "富文本列表文档无效");
  }

  if (operation.type === "create") {
    const target = locateListItem(doc, operation.targetBlockId);
    const node = normalizeTiptapListItemPatchNode(operation.node, operation.blockId);
    if (node.type !== expectedItemType(target.list.type)) {
      throw new TiptapListItemStructureError("LIST_STRUCTURE_INVALID", "新列表项类型与目标列表不匹配");
    }
    const createdBlockIds = [...collectBlockIds(node)];
    const existingIds = allDocumentBlockIds(doc);
    const duplicate = createdBlockIds.find((blockId) => existingIds.has(blockId));
    if (duplicate) {
      throw new TiptapListItemStructureError("BLOCK_ID_CONFLICT", `blockId 已存在: ${duplicate}`);
    }
    const targetIndex = target.list.content.indexOf(target.item);
    if (targetIndex < 0) {
      throw new TiptapListItemStructureError("LIST_STRUCTURE_INVALID", "目标列表结构已变化");
    }
    const destination = operation.position === "after" ? targetIndex + 1 : targetIndex;
    target.list.content.splice(destination, 0, cloneJson(node));
    const parentId = target.parentItemFrame?.node?.attrs?.blockId;
    return {
      affectedBlockIds: [
        ...createdBlockIds,
        ...(validBlockId(parentId) ? [parentId] : []),
      ],
      createdBlockIds,
      deletedBlockIds: [],
    };
  }

  const source = locateListItem(doc, operation.blockId);
  const deletedBlockIds = ensureLeafItem(source);
  source.list.content.splice(source.itemFrame.index, 1);
  removeListWrapperIfEmpty(source);
  const parentId = source.parentItemFrame?.node?.attrs?.blockId;
  return {
    affectedBlockIds: [
      ...deletedBlockIds,
      ...(validBlockId(parentId) ? [parentId] : []),
    ],
    createdBlockIds: [],
    deletedBlockIds,
  };
}
