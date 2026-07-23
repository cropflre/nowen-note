import { v4 as uuid } from "uuid";

import {
  SUPPORTED_NOTE_BLOCK_TYPES,
  type NoteBlockType,
} from "./noteBlocks.js";
import {
  applyTiptapListItemMove,
  TiptapListItemMoveError,
  type TiptapListItemMoveOperation,
} from "./tiptapListItemMove.js";
import {
  normalizeTiptapReplacementNode,
  TiptapBlockNodeValidationError,
  type TiptapPatchJsonNode,
} from "./tiptapBlockPatchNode.js";

const BLOCK_ID_RE = /^blk_[A-Za-z0-9_-]{6,}$/;
const SUPPORTED_TYPES = new Set<string>(SUPPORTED_NOTE_BLOCK_TYPES);

export type TiptapBlockPatchOperation =
  | {
      type: "create";
      clientId?: string;
      blockId?: string;
      blockType?: NoteBlockType;
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
      scope?: undefined;
      blockId: string;
      targetBlockId: string;
      position?: "before" | "after";
    }
  | TiptapListItemMoveOperation;

export interface TiptapBlockPatchResult {
  content: string;
  affectedBlockIds: string[];
  createdBlocks: Array<{ operationIndex: number; clientId: string | null; blockId: string }>;
}

export class TiptapBlockPatchError extends Error {
  constructor(
    public readonly code:
      | "INVALID_PATCH"
      | "INVALID_BLOCK_ID"
      | "INVALID_BLOCK_NODE"
      | "BLOCK_ID_CONFLICT"
      | "BLOCK_NOT_FOUND"
      | "BLOCK_MOVE_PARENT_MISMATCH"
      | "BLOCK_MOVE_SELF"
      | "LIST_MOVE_INVALID"
      | "INVALID_TIPTAP_DOCUMENT",
    message: string,
  ) {
    super(message);
    this.name = "TiptapBlockPatchError";
  }
}

interface TiptapLocation {
  node: any;
  parent: any[];
  parentNode: any | null;
  index: number;
  topIndex: number;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function makeBlockId(): string {
  return `blk_${uuid()}`;
}

function validBlockId(value: unknown): value is string {
  return typeof value === "string" && BLOCK_ID_RE.test(value);
}

function findBlock(
  nodes: any[],
  blockId: string,
  topIndex = -1,
  parentNode: any | null = null,
): TiptapLocation | null {
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    const currentTop = topIndex < 0 ? index : topIndex;
    if (node?.attrs?.blockId === blockId) {
      return { node, parent: nodes, parentNode, index, topIndex: currentTop };
    }
    if (Array.isArray(node?.content)) {
      const nested = findBlock(node.content, blockId, currentTop, node);
      if (nested) return nested;
    }
  }
  return null;
}

function collectBlockIds(nodes: any[], output = new Set<string>()): Set<string> {
  for (const node of nodes) {
    const blockId = node?.attrs?.blockId;
    if (validBlockId(blockId)) output.add(blockId);
    if (Array.isArray(node?.content)) collectBlockIds(node.content, output);
  }
  return output;
}

/** Keep common Tiptap container nodes schema-valid after deleting a nested indexed block. */
function repairEmptyContainers(nodes: any[]): void {
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index];
    if (!node || typeof node !== "object" || !Array.isArray(node.content)) continue;
    repairEmptyContainers(node.content);

    if (["bulletList", "orderedList", "taskList"].includes(node.type) && node.content.length === 0) {
      nodes.splice(index, 1);
      continue;
    }
    if (["listItem", "taskItem", "blockquote"].includes(node.type) && node.content.length === 0) {
      node.content = [{ type: "paragraph", content: [] }];
    }
  }
}

function setBlockText(node: any, text: string): void {
  const content = text ? [{ type: "text", text }] : [];
  if (["paragraph", "heading", "codeBlock"].includes(node.type)) {
    node.content = content;
    return;
  }

  const findTextContainer = (candidate: any): any | null => {
    if (!candidate || typeof candidate !== "object") return null;
    if (["paragraph", "heading", "codeBlock"].includes(candidate.type)) return candidate;
    if (!Array.isArray(candidate.content)) return null;
    for (const child of candidate.content) {
      const found = findTextContainer(child);
      if (found) return found;
    }
    return null;
  };

  const container = findTextContainer(node);
  if (container) container.content = content;
  else node.content = [{ type: "paragraph", content }];
}

function createNode(blockType: NoteBlockType, text: string, blockId: string): any {
  const textContent = text ? [{ type: "text", text }] : [];
  if (blockType === "heading") {
    return { type: "heading", attrs: { level: 2, blockId }, content: textContent };
  }
  if (blockType === "paragraph") {
    return { type: "paragraph", attrs: { blockId }, content: textContent };
  }
  if (blockType === "codeBlock") {
    return { type: "codeBlock", attrs: { language: null, blockId }, content: textContent };
  }
  if (blockType === "blockquote") {
    return {
      type: "blockquote",
      attrs: { blockId },
      content: [{ type: "paragraph", content: textContent }],
    };
  }
  const item = {
    type: blockType,
    attrs: blockType === "taskItem" ? { checked: false, blockId } : { blockId },
    content: [{ type: "paragraph", content: textContent }],
  };
  return {
    type: blockType === "taskItem" ? "taskList" : "bulletList",
    content: [item],
  };
}

function invalidBlockNode(error: unknown, index?: number): TiptapBlockPatchError {
  const prefix = index == null ? "" : `operations[${index}].`;
  const message = error instanceof TiptapBlockNodeValidationError
    ? error.message
    : "replace.node 无效";
  return new TiptapBlockPatchError("INVALID_BLOCK_NODE", `${prefix}${message}`);
}

function validateOperation(operation: any, index: number): asserts operation is TiptapBlockPatchOperation {
  if (!operation || typeof operation !== "object" || Array.isArray(operation)) {
    throw new TiptapBlockPatchError("INVALID_PATCH", `operations[${index}] 必须是对象`);
  }
  if (!["create", "update", "replace", "delete", "move"].includes(operation.type)) {
    throw new TiptapBlockPatchError("INVALID_PATCH", `operations[${index}].type 无效`);
  }

  if (operation.type === "create") {
    const blockType = operation.blockType || "paragraph";
    if (!SUPPORTED_TYPES.has(blockType)) {
      throw new TiptapBlockPatchError("INVALID_PATCH", `operations[${index}].blockType 无效`);
    }
    if (operation.blockId != null && !validBlockId(operation.blockId)) {
      throw new TiptapBlockPatchError("INVALID_BLOCK_ID", `operations[${index}].blockId 无效`);
    }
    if (operation.afterBlockId != null && !validBlockId(operation.afterBlockId)) {
      throw new TiptapBlockPatchError("INVALID_BLOCK_ID", `operations[${index}].afterBlockId 无效`);
    }
    if (operation.clientId != null && (
      typeof operation.clientId !== "string"
      || operation.clientId.length < 1
      || operation.clientId.length > 64
    )) {
      throw new TiptapBlockPatchError("INVALID_PATCH", `operations[${index}].clientId 长度必须为 1-64`);
    }
    if (operation.text != null && typeof operation.text !== "string") {
      throw new TiptapBlockPatchError("INVALID_PATCH", `operations[${index}].text 必须是字符串`);
    }
    return;
  }

  if (!validBlockId(operation.blockId)) {
    throw new TiptapBlockPatchError("INVALID_BLOCK_ID", `operations[${index}].blockId 无效`);
  }
  if (operation.type === "update") {
    if (typeof operation.text !== "string") {
      throw new TiptapBlockPatchError("INVALID_PATCH", `operations[${index}].text 必须是字符串`);
    }
    return;
  }
  if (operation.type === "replace") {
    try {
      operation.node = normalizeTiptapReplacementNode(operation.node, operation.blockId);
    } catch (error) {
      throw invalidBlockNode(error, index);
    }
    return;
  }
  if (operation.type === "move") {
    if (!validBlockId(operation.targetBlockId)) {
      throw new TiptapBlockPatchError("INVALID_BLOCK_ID", `operations[${index}].targetBlockId 无效`);
    }
    if (operation.scope === "listItem") {
      if (!["before", "after", "inside"].includes(operation.position)) {
        throw new TiptapBlockPatchError("INVALID_PATCH", `operations[${index}].position 无效`);
      }
      return;
    }
    if (operation.scope != null) {
      throw new TiptapBlockPatchError("INVALID_PATCH", `operations[${index}].scope 无效`);
    }
    if (operation.position != null && !["before", "after"].includes(operation.position)) {
      throw new TiptapBlockPatchError("INVALID_PATCH", `operations[${index}].position 无效`);
    }
  }
}

export function validateTiptapBlockPatchOperations(raw: unknown): TiptapBlockPatchOperation[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 100) {
    throw new TiptapBlockPatchError("INVALID_PATCH", "operations 数量必须为 1-100");
  }
  if (JSON.stringify(raw).length > 2_000_000) {
    throw new TiptapBlockPatchError("INVALID_PATCH", "块补丁过大");
  }
  const clientIds = new Set<string>();
  raw.forEach((operation, index) => {
    validateOperation(operation, index);
    if (operation.type === "create" && operation.clientId) {
      if (clientIds.has(operation.clientId)) {
        throw new TiptapBlockPatchError("INVALID_PATCH", `重复 clientId: ${operation.clientId}`);
      }
      clientIds.add(operation.clientId);
    }
  });
  return cloneJson(raw) as TiptapBlockPatchOperation[];
}

/** Apply an ordered block patch to one Tiptap document without touching persistence. */
export function applyTiptapBlockPatch(
  source: string,
  operations: TiptapBlockPatchOperation[],
  createId: () => string = makeBlockId,
): TiptapBlockPatchResult {
  let doc: any;
  try {
    doc = JSON.parse(source || "{}");
  } catch {
    throw new TiptapBlockPatchError("INVALID_TIPTAP_DOCUMENT", "富文本 JSON 无法解析");
  }
  if (!doc || typeof doc !== "object" || doc.type !== "doc" || !Array.isArray(doc.content)) {
    throw new TiptapBlockPatchError("INVALID_TIPTAP_DOCUMENT", "富文本必须是合法 doc.content 数组");
  }

  const affectedBlockIds: string[] = [];
  const createdBlocks: TiptapBlockPatchResult["createdBlocks"] = [];
  const knownIds = collectBlockIds(doc.content);

  operations.forEach((operation, operationIndex) => {
    if (operation.type === "create") {
      const blockId = operation.blockId || createId();
      if (!validBlockId(blockId)) {
        throw new TiptapBlockPatchError("INVALID_BLOCK_ID", `生成的 blockId 无效: ${blockId}`);
      }
      if (knownIds.has(blockId)) {
        throw new TiptapBlockPatchError("BLOCK_ID_CONFLICT", `blockId 已存在: ${blockId}`);
      }
      const node = createNode(operation.blockType || "paragraph", operation.text || "", blockId);
      if (operation.afterBlockId) {
        const anchor = findBlock(doc.content, operation.afterBlockId, -1, doc);
        if (!anchor) throw new TiptapBlockPatchError("BLOCK_NOT_FOUND", `块不存在: ${operation.afterBlockId}`);
        doc.content.splice(anchor.topIndex + 1, 0, node);
      } else {
        doc.content.push(node);
      }
      knownIds.add(blockId);
      affectedBlockIds.push(blockId);
      createdBlocks.push({
        operationIndex,
        clientId: operation.clientId || null,
        blockId,
      });
      return;
    }

    if (operation.type === "move" && operation.scope === "listItem") {
      try {
        affectedBlockIds.push(...applyTiptapListItemMove(doc, operation));
      } catch (error) {
        const message = error instanceof TiptapListItemMoveError
          ? error.message
          : "列表层级移动无效";
        throw new TiptapBlockPatchError("LIST_MOVE_INVALID", message);
      }
      return;
    }

    const target = findBlock(doc.content, operation.blockId, -1, doc);
    if (!target) throw new TiptapBlockPatchError("BLOCK_NOT_FOUND", `块不存在: ${operation.blockId}`);

    if (operation.type === "update") {
      setBlockText(target.node, operation.text);
      affectedBlockIds.push(operation.blockId);
      return;
    }

    if (operation.type === "replace") {
      let replacement: TiptapPatchJsonNode;
      try {
        replacement = normalizeTiptapReplacementNode(operation.node, operation.blockId);
      } catch (error) {
        throw invalidBlockNode(error);
      }
      if (replacement.type !== target.node.type && target.parentNode?.type !== "doc") {
        throw new TiptapBlockPatchError(
          "INVALID_BLOCK_NODE",
          "嵌套块只能保留原节点类型；顶层段落、标题和代码块才允许互相转换",
        );
      }
      target.parent[target.index] = replacement;
      affectedBlockIds.push(operation.blockId);
      return;
    }

    if (operation.type === "delete") {
      target.parent.splice(target.index, 1);
      repairEmptyContainers(doc.content);
      knownIds.delete(operation.blockId);
      affectedBlockIds.push(operation.blockId);
      return;
    }

    if (operation.blockId === operation.targetBlockId) {
      throw new TiptapBlockPatchError("BLOCK_MOVE_SELF", "不能把块移动到自身前后");
    }
    const anchor = findBlock(doc.content, operation.targetBlockId, -1, doc);
    if (!anchor) throw new TiptapBlockPatchError("BLOCK_NOT_FOUND", `块不存在: ${operation.targetBlockId}`);
    if (anchor.parent !== target.parent) {
      throw new TiptapBlockPatchError("BLOCK_MOVE_PARENT_MISMATCH", "当前仅支持同一父块内移动");
    }
    const [node] = target.parent.splice(target.index, 1);
    let destination = anchor.index;
    if (target.index < anchor.index) destination -= 1;
    if ((operation.position || "after") === "after") destination += 1;
    target.parent.splice(Math.max(0, destination), 0, node);
    affectedBlockIds.push(operation.blockId);
  });

  if (doc.content.length === 0) {
    let blockId = createId();
    let attempts = 0;
    while ((!validBlockId(blockId) || knownIds.has(blockId)) && attempts < 32) {
      blockId = createId();
      attempts += 1;
    }
    if (!validBlockId(blockId) || knownIds.has(blockId)) {
      throw new TiptapBlockPatchError("INVALID_BLOCK_ID", "无法生成有效的空段落 blockId");
    }
    doc.content.push(createNode("paragraph", "", blockId));
    affectedBlockIds.push(blockId);
    createdBlocks.push({ operationIndex: operations.length, clientId: null, blockId });
  }

  return {
    content: JSON.stringify(doc),
    affectedBlockIds: [...new Set(affectedBlockIds)],
    createdBlocks,
  };
}
