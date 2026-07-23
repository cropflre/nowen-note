import type { BlockPatchOperation, BlockPatchBlockType } from "@/lib/blockPatchApi";
import {
  normalizeSafeTiptapReplacementNode,
  type TiptapPatchJsonNode,
} from "@/lib/tiptapBlockPatchNode";

const BLOCK_ID_RE = /^blk_[A-Za-z0-9_-]{6,}$/;
const STRUCTURAL_TYPES = new Set(["paragraph", "heading", "codeBlock"]);
const TEXT_BLOCK_TYPES = new Set(["paragraph", "heading", "codeBlock"]);

type ReplaceOperation = Extract<BlockPatchOperation, { type: "replace" }>;

interface JsonNode {
  type?: string;
  attrs?: Record<string, unknown> | null;
  content?: JsonNode[];
  text?: string;
  marks?: unknown[];
  [key: string]: unknown;
}

interface SimpleBlock {
  id: string;
  type: BlockPatchBlockType;
  text: string;
  node: JsonNode;
}

export interface TiptapBlockPatchPlan {
  operations: BlockPatchOperation[];
  kind: "top-level-structural" | "text-only" | "node-replace";
  affectedBlockIds: string[];
}

function parseDocument(content: string): JsonNode | null {
  try {
    const parsed = JSON.parse(content || "{}");
    if (!parsed || parsed.type !== "doc" || !Array.isArray(parsed.content)) return null;
    return parsed as JsonNode;
  } catch {
    return null;
  }
}

function validBlockId(value: unknown): value is string {
  return typeof value === "string" && BLOCK_ID_RE.test(value);
}

function simpleText(node: JsonNode): string | null {
  const content = Array.isArray(node.content) ? node.content : [];
  let text = "";
  for (const child of content) {
    if (child?.type !== "text" || typeof child.text !== "string") return null;
    if (Array.isArray(child.marks) && child.marks.length > 0) return null;
    text += child.text;
  }
  return text;
}

function blockType(type: string): BlockPatchBlockType | null {
  if (type === "paragraph" || type === "heading" || type === "codeBlock") return type;
  return null;
}

function asSimpleBlock(node: JsonNode): SimpleBlock | null {
  if (!node?.type || !TEXT_BLOCK_TYPES.has(node.type)) return null;
  const id = node.attrs?.blockId;
  if (!validBlockId(id)) return null;
  const type = blockType(node.type);
  const text = simpleText(node);
  if (!type || text == null) return null;
  return { id, type, text, node };
}

function normalizedAttrs(node: JsonNode): Record<string, unknown> {
  const attrs = { ...(node.attrs || {}) };
  delete attrs.blockId;
  return attrs;
}

function sameNonTextShape(left: JsonNode, right: JsonNode): boolean {
  if (left.type !== right.type) return false;
  if (JSON.stringify(normalizedAttrs(left)) !== JSON.stringify(normalizedAttrs(right))) return false;
  const leftExtra = { ...left, content: [], attrs: normalizedAttrs(left) };
  const rightExtra = { ...right, content: [], attrs: normalizedAttrs(right) };
  return JSON.stringify(leftExtra) === JSON.stringify(rightExtra);
}

function isDefaultValue(value: unknown): boolean {
  return value == null || value === "" || value === 0 || value === false;
}

function canCreateFromNode(block: SimpleBlock): boolean {
  const attrs = normalizedAttrs(block.node);
  if (block.type === "heading") {
    if (attrs.level !== 2) return false;
    delete attrs.level;
  }
  if (block.type === "codeBlock") {
    if (!(attrs.language == null || attrs.language === "")) return false;
    delete attrs.language;
  }
  return Object.values(attrs).every(isDefaultValue);
}

function uniqueBlocks(nodes: JsonNode[]): SimpleBlock[] | null {
  const blocks: SimpleBlock[] = [];
  const seen = new Set<string>();
  for (const node of nodes) {
    if (!node?.type || !STRUCTURAL_TYPES.has(node.type)) return null;
    const block = asSimpleBlock(node);
    if (!block || seen.has(block.id)) return null;
    seen.add(block.id);
    blocks.push(block);
  }
  return blocks;
}

function planTopLevelStructural(baseDoc: JsonNode, nextDoc: JsonNode): TiptapBlockPatchPlan | null {
  const base = uniqueBlocks(baseDoc.content || []);
  const next = uniqueBlocks(nextDoc.content || []);
  if (!base || !next || next.length === 0) return null;

  const baseById = new Map(base.map((item) => [item.id, item]));
  const nextById = new Map(next.map((item) => [item.id, item]));
  const operations: BlockPatchOperation[] = [];

  for (const item of next) {
    const previous = baseById.get(item.id);
    if (!previous) continue;
    if (!sameNonTextShape(previous.node, item.node)) return null;
    if (previous.text !== item.text) {
      operations.push({ type: "update", blockId: item.id, text: item.text });
    }
  }

  for (const item of base) {
    if (!nextById.has(item.id)) operations.push({ type: "delete", blockId: item.id });
  }

  const created = next.filter((item) => !baseById.has(item.id));
  for (const item of created) {
    if (!canCreateFromNode(item)) return null;
    operations.push({
      type: "create",
      clientId: item.id,
      blockId: item.id,
      blockType: item.type,
      text: item.text,
    });
  }

  const desired = next.map((item) => item.id);
  const desiredSet = new Set(desired);
  const current = base.map((item) => item.id).filter((id) => desiredSet.has(id));
  current.push(...created.map((item) => item.id));

  for (let index = 0; index < desired.length; index += 1) {
    if (current[index] === desired[index]) continue;
    const found = current.indexOf(desired[index], index + 1);
    if (found < 0 || !current[index]) return null;
    operations.push({
      type: "move",
      blockId: desired[index],
      targetBlockId: current[index],
      position: "before",
    });
    const [moved] = current.splice(found, 1);
    current.splice(index, 0, moved);
  }

  if (operations.length === 0 || operations.length > 100) return null;
  return {
    operations,
    kind: "top-level-structural",
    affectedBlockIds: [...new Set(operations.flatMap((operation) => {
      if (operation.type === "create") return operation.blockId ? [operation.blockId] : [];
      if (operation.type === "move") return [operation.blockId, operation.targetBlockId];
      return [operation.blockId];
    }))],
  };
}

interface TextSnapshot {
  textById: Map<string, string>;
  skeleton: string;
}

function textSnapshot(doc: JsonNode): TextSnapshot | null {
  const clone = JSON.parse(JSON.stringify(doc)) as JsonNode;
  const textById = new Map<string, string>();
  const seen = new Set<string>();
  let invalid = false;

  const visit = (nodes: JsonNode[]) => {
    for (const node of nodes) {
      if (!node || typeof node !== "object") continue;
      if (node.type && TEXT_BLOCK_TYPES.has(node.type)) {
        const block = asSimpleBlock(node);
        if (!block || seen.has(block.id)) {
          invalid = true;
          return;
        }
        seen.add(block.id);
        textById.set(block.id, block.text);
        node.content = [];
      } else if (Array.isArray(node.content)) {
        visit(node.content);
        if (invalid) return;
      }
    }
  };

  visit(clone.content || []);
  if (invalid) return null;
  return { textById, skeleton: JSON.stringify(clone) };
}

function planTextOnly(baseDoc: JsonNode, nextDoc: JsonNode): TiptapBlockPatchPlan | null {
  const base = textSnapshot(baseDoc);
  const next = textSnapshot(nextDoc);
  if (!base || !next || base.skeleton !== next.skeleton) return null;
  if (base.textById.size !== next.textById.size) return null;

  const operations: BlockPatchOperation[] = [];
  for (const [blockId, text] of next.textById) {
    if (!base.textById.has(blockId)) return null;
    if (base.textById.get(blockId) !== text) {
      operations.push({ type: "update", blockId, text });
    }
  }
  if (operations.length === 0 || operations.length > 100) return null;
  return {
    operations,
    kind: "text-only",
    affectedBlockIds: operations
      .map((operation) => operation.type === "update" ? operation.blockId : "")
      .filter(Boolean),
  };
}

interface ReplacementEntry {
  node: TiptapPatchJsonNode;
  parentType: string;
}

interface ReplacementSnapshot {
  nodesById: Map<string, ReplacementEntry>;
  skeleton: string;
}

function replacementSnapshot(doc: JsonNode): ReplacementSnapshot | null {
  const clone = JSON.parse(JSON.stringify(doc)) as JsonNode;
  const nodesById = new Map<string, ReplacementEntry>();
  let invalid = false;

  const visit = (nodes: JsonNode[], parentType: string) => {
    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes[index];
      if (!node || typeof node !== "object") continue;
      if (node.type && TEXT_BLOCK_TYPES.has(node.type)) {
        const blockId = node.attrs?.blockId;
        if (!validBlockId(blockId) || nodesById.has(blockId)) {
          invalid = true;
          return;
        }
        const normalized = normalizeSafeTiptapReplacementNode(node, blockId);
        if (!normalized) {
          invalid = true;
          return;
        }
        nodesById.set(blockId, { node: normalized, parentType });
        nodes[index] = {
          type: "__nowen_block_patch_slot",
          attrs: { blockId },
        };
        continue;
      }
      if (Array.isArray(node.content)) {
        visit(node.content, node.type || "unknown");
        if (invalid) return;
      }
    }
  };

  visit(clone.content || [], "doc");
  if (invalid || nodesById.size === 0) return null;
  return { nodesById, skeleton: JSON.stringify(clone) };
}

function planNodeReplacements(baseDoc: JsonNode, nextDoc: JsonNode): TiptapBlockPatchPlan | null {
  const base = replacementSnapshot(baseDoc);
  const next = replacementSnapshot(nextDoc);
  if (!base || !next || base.skeleton !== next.skeleton) return null;
  if (base.nodesById.size !== next.nodesById.size) return null;

  const operations: ReplaceOperation[] = [];
  for (const [blockId, nextEntry] of next.nodesById) {
    const baseEntry = base.nodesById.get(blockId);
    if (!baseEntry || baseEntry.parentType !== nextEntry.parentType) return null;
    if (baseEntry.node.type !== nextEntry.node.type && nextEntry.parentType !== "doc") return null;
    if (JSON.stringify(baseEntry.node) !== JSON.stringify(nextEntry.node)) {
      operations.push({ type: "replace", blockId, node: nextEntry.node });
    }
  }
  if (operations.length === 0 || operations.length > 100) return null;
  return {
    operations,
    kind: "node-replace",
    affectedBlockIds: operations.map((operation) => operation.blockId),
  };
}

export function planTiptapBlockPatch(
  baseContent: string,
  nextContent: string,
): TiptapBlockPatchPlan | null {
  if (!baseContent || !nextContent || baseContent === nextContent) return null;
  const baseDoc = parseDocument(baseContent);
  const nextDoc = parseDocument(nextContent);
  if (!baseDoc || !nextDoc) return null;
  return planTopLevelStructural(baseDoc, nextDoc)
    || planTextOnly(baseDoc, nextDoc)
    || planNodeReplacements(baseDoc, nextDoc);
}
