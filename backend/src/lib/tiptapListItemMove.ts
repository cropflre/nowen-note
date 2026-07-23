const BLOCK_ID_RE = /^blk_[A-Za-z0-9_-]{6,}$/;
const LIST_TYPES = new Set(["bulletList", "orderedList", "taskList"]);
const ITEM_TYPES = new Set(["listItem", "taskItem"]);

export type TiptapListItemMovePosition = "before" | "after" | "inside";

export interface TiptapListItemMoveOperation {
  type: "move";
  scope: "listItem";
  blockId: string;
  targetBlockId: string;
  position: TiptapListItemMovePosition;
}

export class TiptapListItemMoveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TiptapListItemMoveError";
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
  path: NodeFrame[];
  depth: number;
  parentItemFrame: NodeFrame | null;
  outerListFrame: NodeFrame | null;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function validBlockId(value: unknown): value is string {
  return typeof value === "string" && BLOCK_ID_RE.test(value);
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
    throw new TiptapListItemMoveError(`列表项不存在: ${blockId}`);
  }
  const itemFrame = path[path.length - 1];
  const listFrame = path[path.length - 2];
  if (!ITEM_TYPES.has(itemFrame.node?.type) || !LIST_TYPES.has(listFrame.node?.type)) {
    throw new TiptapListItemMoveError(`目标不是可移动列表项: ${blockId}`);
  }
  if (listFrame.node.content !== itemFrame.parent) {
    throw new TiptapListItemMoveError("列表项父容器无效");
  }

  let parentItemFrame: NodeFrame | null = null;
  let outerListFrame: NodeFrame | null = null;
  for (let index = path.length - 3; index >= 0; index -= 1) {
    if (!ITEM_TYPES.has(path[index].node?.type)) continue;
    parentItemFrame = path[index];
    if (index > 0 && LIST_TYPES.has(path[index - 1].node?.type)) {
      outerListFrame = path[index - 1];
    }
    break;
  }

  return {
    item: itemFrame.node,
    itemFrame,
    list: listFrame.node,
    listFrame,
    path,
    depth: path.filter((frame) => LIST_TYPES.has(frame.node?.type)).length,
    parentItemFrame,
    outerListFrame,
  };
}

function expectedItemType(listType: string): string {
  return listType === "taskList" ? "taskItem" : "listItem";
}

function validateCompatible(source: ListItemLocation, target: ListItemLocation): void {
  if (source.item.type !== target.item.type || source.list.type !== target.list.type) {
    throw new TiptapListItemMoveError("仅支持同类型列表项和列表容器之间移动");
  }
  if (source.item.type !== expectedItemType(source.list.type)) {
    throw new TiptapListItemMoveError("列表项类型与列表容器不匹配");
  }
}

function removeListWrapperIfEmpty(location: ListItemLocation): void {
  if (location.list.content.length > 0) return;
  const currentIndex = location.listFrame.parent.indexOf(location.list);
  if (currentIndex >= 0) location.listFrame.parent.splice(currentIndex, 1);
}

function nestedListForSink(target: ListItemLocation): any {
  const children = Array.isArray(target.item.content) ? target.item.content : [];
  const nestedLists = children.filter((child: any) => LIST_TYPES.has(child?.type));
  if (nestedLists.some((child: any) => child.type !== target.list.type)) {
    throw new TiptapListItemMoveError("前一列表项包含不同类型的嵌套列表，无法安全缩进");
  }
  if (nestedLists.length > 1) {
    throw new TiptapListItemMoveError("前一列表项包含多个嵌套列表，无法确定缩进目标");
  }
  if (nestedLists.length === 1) return nestedLists[0];
  const attrs = target.list.attrs && typeof target.list.attrs === "object"
    ? cloneJson(target.list.attrs)
    : null;
  const nested = {
    type: target.list.type,
    ...(attrs && Object.keys(attrs).length > 0 ? { attrs } : {}),
    content: [] as any[],
  };
  if (!Array.isArray(target.item.content)) target.item.content = [];
  target.item.content.push(nested);
  return nested;
}

function sinkListItem(source: ListItemLocation, target: ListItemLocation): void {
  validateCompatible(source, target);
  if (source.list !== target.list || source.depth !== target.depth) {
    throw new TiptapListItemMoveError("缩进只能发生在同一列表层级");
  }
  const sourceIndex = source.list.content.indexOf(source.item);
  const targetIndex = source.list.content.indexOf(target.item);
  if (sourceIndex < 1 || targetIndex !== sourceIndex - 1) {
    throw new TiptapListItemMoveError("列表项只能缩进到紧邻的前一项下");
  }
  const nested = nestedListForSink(target);
  source.list.content.splice(sourceIndex, 1);
  nested.content.push(source.item);
}

function liftListItem(source: ListItemLocation, target: ListItemLocation): void {
  validateCompatible(source, target);
  if (
    source.depth !== target.depth + 1
    || source.parentItemFrame?.node !== target.item
    || !source.outerListFrame
    || source.outerListFrame.node !== target.list
    || source.listFrame.parent !== target.item.content
  ) {
    throw new TiptapListItemMoveError("提升只能把嵌套项移动到其直接父项之后");
  }

  const sourceIndex = source.list.content.indexOf(source.item);
  const targetIndex = target.list.content.indexOf(target.item);
  if (sourceIndex < 0 || targetIndex < 0) {
    throw new TiptapListItemMoveError("列表结构已变化，无法完成提升");
  }
  source.list.content.splice(sourceIndex, 1);
  removeListWrapperIfEmpty(source);
  const refreshedTargetIndex = target.list.content.indexOf(target.item);
  target.list.content.splice(refreshedTargetIndex + 1, 0, source.item);
}

function moveAtSameDepth(
  source: ListItemLocation,
  target: ListItemLocation,
  position: "before" | "after",
): void {
  validateCompatible(source, target);
  if (source.depth !== target.depth) {
    throw new TiptapListItemMoveError("跨列表移动必须保持相同层级");
  }

  const sourceIndex = source.list.content.indexOf(source.item);
  if (sourceIndex < 0) throw new TiptapListItemMoveError("源列表项不存在");
  source.list.content.splice(sourceIndex, 1);
  if (source.list !== target.list) removeListWrapperIfEmpty(source);

  const targetIndex = target.list.content.indexOf(target.item);
  if (targetIndex < 0) throw new TiptapListItemMoveError("目标列表项不存在");
  const destination = position === "after" ? targetIndex + 1 : targetIndex;
  target.list.content.splice(destination, 0, source.item);
}

/** Apply one controlled list hierarchy operation to a mutable Tiptap document. */
export function applyTiptapListItemMove(
  doc: any,
  operation: TiptapListItemMoveOperation,
): string[] {
  if (!validBlockId(operation.blockId) || !validBlockId(operation.targetBlockId)) {
    throw new TiptapListItemMoveError("列表项 Block ID 无效");
  }
  if (operation.blockId === operation.targetBlockId) {
    throw new TiptapListItemMoveError("不能把列表项移动到自身");
  }
  if (!doc || doc.type !== "doc" || !Array.isArray(doc.content)) {
    throw new TiptapListItemMoveError("富文本列表文档无效");
  }

  const source = locateListItem(doc, operation.blockId);
  const target = locateListItem(doc, operation.targetBlockId);
  if (operation.position === "inside") {
    sinkListItem(source, target);
  } else if (
    operation.position === "after"
    && source.depth === target.depth + 1
  ) {
    liftListItem(source, target);
  } else {
    moveAtSameDepth(source, target, operation.position);
  }
  return [operation.blockId, operation.targetBlockId];
}
