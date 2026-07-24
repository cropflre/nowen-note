const BLOCK_ID_RE = /^blk_[A-Za-z0-9_-]{6,}$/;
const MARKER_RE = /(?:[ \t]+\^(blk_[A-Za-z0-9_-]{6,})[ \t]*$)|(?:^\^(blk_[A-Za-z0-9_-]{6,})[ \t]*$)/gm;

export type MarkdownBlockPatchOperation =
  | { type: "replace"; blockId: string; expectedHash: string; content: string }
  | { type: "insert"; blockId: string; targetBlockId: string; position: "before" | "after"; content: string }
  | { type: "delete"; blockId: string; expectedHash: string }
  | { type: "move"; blockId: string; expectedHash: string; targetBlockId: string; position: "before" | "after" };

export interface MarkdownPatchBlock {
  blockId: string;
  raw: string;
  content: string;
  contentHash: string;
}

export class MarkdownBlockPatchError extends Error {
  constructor(
    readonly code:
      | "INVALID_MARKDOWN_PATCH"
      | "INVALID_MARKDOWN_DOCUMENT"
      | "UNSAFE_MARKDOWN_BOUNDARY"
      | "BLOCK_ID_CONFLICT"
      | "BLOCK_NOT_FOUND"
      | "BLOCK_HASH_CONFLICT",
    message: string,
  ) {
    super(message);
    this.name = "MarkdownBlockPatchError";
  }
}

export function hashMarkdownBlock(content: string): string {
  let high = 0xcbf29ce4;
  let low = 0x84222325;
  const bytes = new TextEncoder().encode(content.replace(/\r\n/g, "\n"));
  for (const byte of bytes) {
    low = (low ^ byte) >>> 0;
    const lowProduct = low * 0x1b3;
    const carry = Math.floor(lowProduct / 0x1_0000_0000);
    high = (Math.imul(high, 0x1b3) + carry + ((low << 8) >>> 0)) >>> 0;
    low = lowProduct >>> 0;
  }
  return high.toString(16).padStart(8, "0") + low.toString(16).padStart(8, "0");
}

function stripMarker(raw: string, blockId: string): string {
  const inline = new RegExp(`[ \\t]+\\^${blockId}[ \\t]*$`);
  const standalone = new RegExp(`(?:\\n|^)\\^${blockId}[ \\t]*$`);
  return raw.replace(inline, "").replace(standalone, "").replace(/[ \t]+$/gm, "").trimEnd();
}

function assertProtectedMarkdownRegions(source: string, markerOffsets: Set<number>): void {
  let fence: { marker: "`" | "~"; length: number } | null = null;
  let math = false;
  let htmlTag: string | null = null;
  let htmlComment = false;
  let offset = 0;
  for (const rawLine of source.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    const protectedAtLineStart = Boolean(fence || math || htmlTag || htmlComment);
    for (const markerOffset of markerOffsets) {
      if (markerOffset >= offset && markerOffset <= offset + rawLine.length && protectedAtLineStart) {
        throw new MarkdownBlockPatchError("UNSAFE_MARKDOWN_BOUNDARY", "稳定 Block ID 位于不可切分结构内部");
      }
    }
    const token = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (token) {
      const marker = token[0] as "`" | "~";
      if (!fence) fence = { marker, length: token.length };
      else if (fence.marker === marker && token.length >= fence.length) fence = null;
      offset += rawLine.length + 1;
      continue;
    }
    if (!fence && line.trim() === "$$") math = !math;
    if (!fence && !math) {
      if (!htmlComment && line.includes("<!--") && !line.includes("-->")) htmlComment = true;
      else if (htmlComment && line.includes("-->")) htmlComment = false;
      if (!htmlTag) {
        const open = /^\s{0,3}<(details|div|table|pre|script|style|iframe|video|audio|section|article)(?:\s|>|\/)/i.exec(line);
        if (open && !new RegExp(`</${open[1]}\\s*>`, "i").test(line)) htmlTag = open[1].toLowerCase();
      } else if (new RegExp(`</${htmlTag}\\s*>`, "i").test(line)) {
        htmlTag = null;
      }
    }
    offset += rawLine.length + 1;
  }
  if (fence) throw new MarkdownBlockPatchError("UNSAFE_MARKDOWN_BOUNDARY", "代码围栏没有在 Block 内闭合");
  if (math) throw new MarkdownBlockPatchError("UNSAFE_MARKDOWN_BOUNDARY", "数学公式块没有在 Block 内闭合");
  if (htmlTag || htmlComment) throw new MarkdownBlockPatchError("UNSAFE_MARKDOWN_BOUNDARY", "HTML 块没有在 Block 内闭合");
}

function assertSafeBoundary(content: string): void {
  if (!content.trim() || content.length > 1_000_000 || /\u0000/.test(content)) {
    throw new MarkdownBlockPatchError("UNSAFE_MARKDOWN_BOUNDARY", "Markdown Block 内容无效");
  }
  assertProtectedMarkdownRegions(content, new Set());
  if (/\^blk_[A-Za-z0-9_-]{6,}/.test(content)) {
    throw new MarkdownBlockPatchError("UNSAFE_MARKDOWN_BOUNDARY", "Block 内容包含额外稳定 ID");
  }
}

export function parseMarkdownPatchDocument(source: string): { blocks: MarkdownPatchBlock[]; trailingNewline: boolean } {
  if (typeof source !== "string" || source.length > 20_000_000 || source.includes("\r")) {
    throw new MarkdownBlockPatchError("INVALID_MARKDOWN_DOCUMENT", "Markdown 必须使用受限 UTF-8 LF 文本");
  }
  const matches = [...source.matchAll(MARKER_RE)];
  if (matches.length === 0) {
    throw new MarkdownBlockPatchError("INVALID_MARKDOWN_DOCUMENT", "Markdown 缺少稳定 Block ID");
  }
  assertProtectedMarkdownRegions(source, new Set(matches.map((match) => match.index!)));
  const blocks: MarkdownPatchBlock[] = [];
  const seen = new Set<string>();
  let previousEnd = 0;
  for (const match of matches) {
    const blockId = match[1] || match[2];
    if (!BLOCK_ID_RE.test(blockId)) throw new MarkdownBlockPatchError("INVALID_MARKDOWN_DOCUMENT", "Block ID 无效");
    if (seen.has(blockId)) throw new MarkdownBlockPatchError("BLOCK_ID_CONFLICT", `重复 Block ID: ${blockId}`);
    let start = previousEnd;
    while (start < match.index! && /\s/.test(source[start])) start += 1;
    const end = match.index! + match[0].length;
    const raw = source.slice(start, end);
    const content = stripMarker(raw, blockId);
    assertSafeBoundary(content);
    blocks.push({ blockId, raw, content, contentHash: hashMarkdownBlock(content) });
    seen.add(blockId);
    previousEnd = end;
  }
  const trailing = source.slice(previousEnd);
  if (!/^\n?$/.test(trailing)) {
    throw new MarkdownBlockPatchError("INVALID_MARKDOWN_DOCUMENT", "最后一个 Block 后存在无 ID 内容");
  }
  const trailingNewline = trailing === "\n";
  const canonical = blocks.map((block) => block.raw).join("\n\n") + (trailingNewline ? "\n" : "");
  if (canonical !== source) {
    throw new MarkdownBlockPatchError("INVALID_MARKDOWN_DOCUMENT", "Block 之间必须使用一个空行分隔");
  }
  return { blocks, trailingNewline };
}

function parseSingleBlock(content: string, expectedBlockId: string): MarkdownPatchBlock {
  try {
    const parsed = parseMarkdownPatchDocument(content);
    if (parsed.trailingNewline || parsed.blocks.length !== 1 || parsed.blocks[0].blockId !== expectedBlockId) {
      throw new MarkdownBlockPatchError("UNSAFE_MARKDOWN_BOUNDARY", "操作内容必须是一个匹配 ID 的完整 Block");
    }
    return parsed.blocks[0];
  } catch (error) {
    if (error instanceof MarkdownBlockPatchError && error.code === "BLOCK_ID_CONFLICT") throw error;
    throw new MarkdownBlockPatchError("UNSAFE_MARKDOWN_BOUNDARY", error instanceof Error ? error.message : "Markdown Block 无效");
  }
}

export function validateMarkdownBlockPatchOperations(raw: unknown): MarkdownBlockPatchOperation[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 100 || JSON.stringify(raw).length > 2_000_000) {
    throw new MarkdownBlockPatchError("INVALID_MARKDOWN_PATCH", "operations 数量或大小无效");
  }
  const operations = raw.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new MarkdownBlockPatchError("INVALID_MARKDOWN_PATCH", `operations[${index}] 必须是对象`);
    }
    const operation = value as Record<string, unknown>;
    if (typeof operation.type !== "string" || !["replace", "insert", "delete", "move"].includes(operation.type)) {
      throw new MarkdownBlockPatchError("INVALID_MARKDOWN_PATCH", `operations[${index}].type 无效`);
    }
    if (typeof operation.blockId !== "string" || !BLOCK_ID_RE.test(operation.blockId)) {
      throw new MarkdownBlockPatchError("INVALID_MARKDOWN_PATCH", `operations[${index}].blockId 无效`);
    }
    if (operation.type !== "insert" && (typeof operation.expectedHash !== "string" || !/^[0-9a-f]{16}$/.test(operation.expectedHash))) {
      throw new MarkdownBlockPatchError("INVALID_MARKDOWN_PATCH", `operations[${index}].expectedHash 无效`);
    }
    if (operation.type === "replace" || operation.type === "insert") {
      if (typeof operation.content !== "string") throw new MarkdownBlockPatchError("INVALID_MARKDOWN_PATCH", `operations[${index}].content 无效`);
      parseSingleBlock(operation.content, operation.blockId);
    }
    if (operation.type === "move" || operation.type === "insert") {
      if (typeof operation.targetBlockId !== "string" || !BLOCK_ID_RE.test(operation.targetBlockId)
        || !["before", "after"].includes(String(operation.position)) || operation.targetBlockId === operation.blockId) {
        throw new MarkdownBlockPatchError("INVALID_MARKDOWN_PATCH", `operations[${index}] 目标位置无效`);
      }
    }
    const allowed = operation.type === "replace"
      ? ["type", "blockId", "expectedHash", "content"]
      : operation.type === "insert"
        ? ["type", "blockId", "targetBlockId", "position", "content"]
        : operation.type === "delete"
          ? ["type", "blockId", "expectedHash"]
          : ["type", "blockId", "expectedHash", "targetBlockId", "position"];
    if (Object.keys(operation).some((key) => !allowed.includes(key))) {
      throw new MarkdownBlockPatchError("INVALID_MARKDOWN_PATCH", `operations[${index}] 包含未知字段`);
    }
    return { ...operation } as MarkdownBlockPatchOperation;
  });
  return operations;
}

export function applyMarkdownBlockPatch(source: string, operations: MarkdownBlockPatchOperation[]) {
  const parsed = parseMarkdownPatchDocument(source);
  const blocks = parsed.blocks.map((block) => ({ ...block }));
  const affectedBlockIds: string[] = [];
  const createdBlocks: Array<{ operationIndex: number; clientId: null; blockId: string }> = [];
  const deletedBlockIds: string[] = [];

  operations.forEach((operation, operationIndex) => {
    const index = blocks.findIndex((block) => block.blockId === operation.blockId);
    if (operation.type === "insert") {
      if (index >= 0) throw new MarkdownBlockPatchError("BLOCK_ID_CONFLICT", `Block ID 已存在: ${operation.blockId}`);
      const targetIndex = blocks.findIndex((block) => block.blockId === operation.targetBlockId);
      if (targetIndex < 0) throw new MarkdownBlockPatchError("BLOCK_NOT_FOUND", `目标 Block 不存在: ${operation.targetBlockId}`);
      const block = parseSingleBlock(operation.content, operation.blockId);
      blocks.splice(targetIndex + (operation.position === "after" ? 1 : 0), 0, block);
      affectedBlockIds.push(operation.blockId);
      createdBlocks.push({ operationIndex, clientId: null, blockId: operation.blockId });
      return;
    }
    if (index < 0) throw new MarkdownBlockPatchError("BLOCK_NOT_FOUND", `Block 不存在: ${operation.blockId}`);
    if (blocks[index].contentHash !== operation.expectedHash) {
      throw new MarkdownBlockPatchError("BLOCK_HASH_CONFLICT", `Block 内容已变化: ${operation.blockId}`);
    }
    if (operation.type === "replace") {
      blocks[index] = parseSingleBlock(operation.content, operation.blockId);
    } else if (operation.type === "delete") {
      blocks.splice(index, 1);
      deletedBlockIds.push(operation.blockId);
    } else {
      const targetIndexBefore = blocks.findIndex((block) => block.blockId === operation.targetBlockId);
      if (targetIndexBefore < 0) throw new MarkdownBlockPatchError("BLOCK_NOT_FOUND", `目标 Block 不存在: ${operation.targetBlockId}`);
      const [block] = blocks.splice(index, 1);
      const targetIndex = blocks.findIndex((entry) => entry.blockId === operation.targetBlockId);
      blocks.splice(targetIndex + (operation.position === "after" ? 1 : 0), 0, block);
    }
    affectedBlockIds.push(operation.blockId);
  });
  if (blocks.length === 0) throw new MarkdownBlockPatchError("UNSAFE_MARKDOWN_BOUNDARY", "Markdown 不能通过 Patch 删除为空文档");
  return {
    content: blocks.map((block) => block.raw).join("\n\n") + (parsed.trailingNewline ? "\n" : ""),
    affectedBlockIds: [...new Set(affectedBlockIds)],
    createdBlocks,
    deletedBlockIds: [...new Set(deletedBlockIds)],
  };
}
