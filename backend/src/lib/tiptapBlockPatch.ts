import { v4 as uuid } from "uuid";

import {
  SUPPORTED_NOTE_BLOCK_TYPES,
  type NoteBlockType,
} from "./noteBlocks.js";
import {
  applyTiptapListItemMove,
  applyTiptapListItemTopLevelLift,
  TiptapListItemMoveError,
  type TiptapListItemMoveOperation,
  type TiptapListItemTopLevelLiftOperation,
} from "./tiptapListItemMove.js";
import {
  normalizeTiptapReplacementNode,
  TiptapBlockNodeValidationError,
  type TiptapPatchJsonNode,
} from "./tiptapBlockPatchNode.js";
import {
  applyTiptapListItemStructure,
  normalizeTiptapListItemPatchNode,
  TiptapListItemStructureError,
  type TiptapListItemStructuralOperation,
} from "./tiptapListItemStructure.js";

const BLOCK_ID_RE = /^blk_[A-Za-z0-9_-]{6,}$/;
const CREATABLE_TYPES = new Set<string>(
  SUPPORTED_NOTE_BLOCK_TYPES.filter((type) => !["table", "video", "blockEmbed", "mathBlock"].includes(type)),
);
type CreatableNoteBlockType = Exclude<NoteBlockType, "table" | "video" | "blockEmbed" | "mathBlock">;

export type TiptapBlockPatchOperation =
  | {
      type: "create";
      scope?: undefined;
      clientId?: string;
      blockId?: string;
      blockType?: CreatableNoteBlockType;
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
      scope?: undefined;
      blockId: string;
    }
  | {
      type: "move";
      scope?: undefined;
      blockId: string;
      targetBlockId: string;
      position?: "before" | "after";
    }
  | TiptapListItemMoveOperation
  | TiptapListItemTopLevelLiftOperation
  | TiptapListItemStructuralOperation;

export interface TiptapBlockPatchResult {
  content: string;
  affectedBlockIds: string[];
  createdBlocks: Array<{ operationIndex: number; clientId: string | null; blockId: string }>;
  deletedBlockIds: string[];
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

function exactKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
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

function createNode(blockType: CreatableNoteBlockType, text: string, blockId: string): any {
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
  if (!["create", "update", "replace", "delete", "move", "lift"].includes(operation.type)) {
    throw new TiptapBlockPatchError("INVALID_PATCH", `operations[${index}].type 无效`);
  }

  if (operation.type === "create") {
    if (operation.scope === "listItem") {
      if (!exactKeys(operation, [
        "type",
        "scope",
        "clientId",
        "blockId",
        "targetBlockId",
        "position",
        "node",
      ])) {
        throw new TiptapBlockPatchError("INVALID_PATCH", `operations[${index}] 列表项 create 包含未知字段`);
      }
      if (!validBlockId(operation.blockId) || !validBlockId(operation.targetBlockId)) {
        throw new TiptapBlockPatchError("INVALID_BLOCK_ID", `operations[${index}] 列表项 Block ID 无效`);
      }
      if (!["before", "after"].includes(operation.position)) {
        throw new TiptapBlockPatchError("INVALID_PATCH", `operations[${index}].position 无效`);
      }
      if (operation.clientId != null && (
        typeof operation.clientId !== "string"
        || operation.clientId.length < 1
        || operation.clientId.length > 64
      )) {
        throw new TiptapBlockPatchError("INVALID_PATCH", `operations[${index}].clientId 长度必须为 1-64`);
      }
      operation.node = normalizeTiptapListItemPatchNode(operation.node, operation.blockId);
      return;
    }
    if (operation.scope != null) {
      throw new TiptapBlockPatchError("INVALID_PATCH", `operations[${index}].scope 无效`);
    }
    const blockType = operation.blockType || "paragraph";
    if (!CREATABLE_TYPES.has(blockType)) {
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
  if (operation.type === "lift") {
    if (operation.scope !== "listItem" || !["before", "after"].includes(operation.position)) {
      throw new TiptapBlockPatchError("INVALID_PATCH", `operations[${index}] 顶层 lift 无效`);
    }
    if (!exactKeys(operation, ["type", "scope", "blockId", "position"])) {
      throw new TiptapBlockPatchError("INVALID_PATCH", `operations[${index}] 顶层 lift 包含未知字段`);
    }
    return;
  }
  if (operation.type === "delete") {
    if (operation.scope === "listItem") {
      if (!exactKeys(operation, ["type", "scope", "blockId"])) {
        throw new TiptapBlockPatchError("INVALID_PATCH", `operations[${index}] 列表项 delete 包含未知字段`);
      }
      return;
    }
    if (operation.scope != null) {
      throw new TiptapBlockPatchError("INVALID_PATCH", `operations[${index}].scope 无效`);
    }
    return;
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
  const tableReplacementCount = raw.filter((operation) => (
    operation.type === "replace" && operation.node.type === "table"
  )).length;
  if (tableReplacementCount > 0 && (tableReplacementCount !== 1 || raw.length !== 1)) {
    throw new TiptapBlockPatchError("INVALID_PATCH", "table replace 必须是请求中的唯一操作");
  }
  return cloneJson(raw) as TiptapBlockPatchOperation[];
}

/** Apply an ordered block patch to one Tiptap document without touching persistence. */
export function applyTiptapBlockPatch(
  source: string,
  operations: TiptapBlockPatchOperation[],
  createId: () => string = makeBlockId,
): TiptapBlockPatchResult {
  if (operations.some((operation) => operation.type === "replace" && operation.node.type === "table")
    && operations.length !== 1) {
    throw new TiptapBlockPatchError("INVALID_PATCH", "table replace 必须是请求中的唯一操作");
  }
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
  const deletedBlockIds: string[] = [];
  const knownIds = collectBlockIds(doc.content);

  operations.forEach((operation, operationIndex) => {
    if (operation.type === "create" && operation.scope === "listItem") {
      const result = applyTiptapListItemStructure(doc, operation);
      affectedBlockIds.push(...result.affectedBlockIds);
      result.createdBlockIds.forEach((blockId) => knownIds.add(blockId));
      createdBlocks.push({
        operationIndex,
        clientId: operation.clientId || null,
        blockId: operation.blockId,
      });
      return;
    }

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

    if (operation.type === "delete" && operation.scope === "listItem") {
      const result = applyTiptapListItemStructure(doc, operation);
      affectedBlockIds.push(...result.affectedBlockIds);
      deletedBlockIds.push(...result.deletedBlockIds);
      result.deletedBlockIds.forEach((blockId) => knownIds.delete(blockId));
      return;
    }

    if (operation.type === "lift" && operation.scope === "listItem") {
      try {
        const result = applyTiptapListItemTopLevelLift(doc, operation);
        affectedBlockIds.push(...result.affectedBlockIds);
        deletedBlockIds.push(...result.deletedBlockIds);
        result.deletedBlockIds.forEach((blockId) => knownIds.delete(blockId));
      } catch (error) {
        const message = error instanceof TiptapListItemMoveError
          ? error.message
          : "列表项顶层提升无效";
        throw new TiptapBlockPatchError("LIST_MOVE_INVALID", message);
      }
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
    const tableRoot = doc.content[target.topIndex];
    if (tableRoot?.type === "table" && !(
      operation.type === "replace"
      && target.node === tableRoot
      && target.parentNode?.type === "doc"
    )) {
      throw new TiptapBlockPatchError(
        "INVALID_BLOCK_NODE",
        "table 子树只支持顶层 table 整块 replace",
      );
    }

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
      if (["video", "blockEmbed", "mathBlock"].includes(replacement.type)
        && (replacement.type !== target.node.type || target.parentNode?.type !== "doc")) {
        throw new TiptapBlockPatchError(
          "INVALID_BLOCK_NODE",
          "复杂原子节点只能替换同类型顶层节点",
        );
      }
      if (replacement.type === "table" && (target.node.type !== "table" || target.parentNode?.type !== "doc")) {
        throw new TiptapBlockPatchError(
          "INVALID_BLOCK_NODE",
          "table 只能整块替换同一顶层 table",
        );
      }
      if (target.node.type === "table" && replacement.type !== "table") {
        throw new TiptapBlockPatchError(
          "INVALID_BLOCK_NODE",
          "顶层 table 不能转换为其他节点类型",
        );
      }
      const previousIds = collectBlockIds([target.node]);
      const replacementIds = collectBlockIds([replacement]);
      for (const blockId of replacementIds) {
        if (knownIds.has(blockId) && !previousIds.has(blockId)) {
          throw new TiptapBlockPatchError("BLOCK_ID_CONFLICT", `blockId 已存在: ${blockId}`);
        }
      }
      target.parent[target.index] = replacement;
      previousIds.forEach((blockId) => {
        if (!replacementIds.has(blockId)) deletedBlockIds.push(blockId);
      });
      previousIds.forEach((blockId) => knownIds.delete(blockId));
      replacementIds.forEach((blockId) => knownIds.add(blockId));
      affectedBlockIds.push(operation.blockId);
      return;
    }

    if (operation.type === "delete") {
      target.parent.splice(target.index, 1);
      repairEmptyContainers(doc.content);
      knownIds.delete(operation.blockId);
      affectedBlockIds.push(operation.blockId);
      deletedBlockIds.push(operation.blockId);
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

  if (doc.content.length === 0 && operations.some((operation) => (
    (operation.type === "create" || operation.type === "delete")
    && operation.scope === "listItem"
  ))) {
    throw new TiptapListItemStructureError(
      "LIST_STRUCTURE_INVALID",
      "删除最后一个列表项继续使用整篇保存与空文档 Block ID 对账",
    );
  }

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
    deletedBlockIds: [...new Set(deletedBlockIds)],
  };
}
