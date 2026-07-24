export type MarkdownBlockPatchOperation =
  | { type: "replace"; blockId: string; expectedHash: string; content: string }
  | { type: "insert"; blockId: string; targetBlockId: string; position: "before" | "after"; content: string }
  | { type: "delete"; blockId: string; expectedHash: string }
  | { type: "move"; blockId: string; expectedHash: string; targetBlockId: string; position: "before" | "after" };

export interface MarkdownPatchBlock { blockId: string; raw: string; content: string; contentHash: string }

const MARKER_RE = /(?:[ \t]+\^(blk_[A-Za-z0-9_-]{6,})[ \t]*$)|(?:^\^(blk_[A-Za-z0-9_-]{6,})[ \t]*$)/gm;

export function hashMarkdownBlock(content: string): string {
  let high = 0xcbf29ce4;
  let low = 0x84222325;
  for (const byte of new TextEncoder().encode(content.replace(/\r\n/g, "\n"))) {
    low = (low ^ byte) >>> 0;
    const lowProduct = low * 0x1b3;
    const carry = Math.floor(lowProduct / 0x1_0000_0000);
    high = (Math.imul(high, 0x1b3) + carry + ((low << 8) >>> 0)) >>> 0;
    low = lowProduct >>> 0;
  }
  return high.toString(16).padStart(8, "0") + low.toString(16).padStart(8, "0");
}

function stripMarker(raw: string, blockId: string): string {
  return raw
    .replace(new RegExp(`[ \\t]+\\^${blockId}[ \\t]*$`), "")
    .replace(new RegExp(`(?:\\n|^)\\^${blockId}[ \\t]*$`), "")
    .replace(/[ \t]+$/gm, "")
    .trimEnd();
}

function safeContent(content: string): boolean {
  if (!content.trim() || content.length > 1_000_000 || /\u0000|\^blk_[A-Za-z0-9_-]{6,}/.test(content)) return false;
  const lines = content.split("\n");
  const opener = lines[0].match(/^\s{0,3}(`{3,}|~{3,})/);
  if (!opener) return true;
  return new RegExp(`^\\s{0,3}${opener[1][0]}{${opener[1].length},}\\s*$`).test(lines[lines.length - 1]);
}

export function parseMarkdownPatchDocument(source: string): { blocks: MarkdownPatchBlock[]; trailingNewline: boolean } | null {
  if (typeof source !== "string" || source.length > 20_000_000 || source.includes("\r")) return null;
  const matches = [...source.matchAll(MARKER_RE)];
  if (matches.length === 0) return null;
  const seen = new Set<string>();
  const blocks: MarkdownPatchBlock[] = [];
  let previousEnd = 0;
  for (const match of matches) {
    const blockId = match[1] || match[2];
    if (seen.has(blockId)) return null;
    let start = previousEnd;
    while (start < match.index! && /\s/.test(source[start])) start += 1;
    const end = match.index! + match[0].length;
    const raw = source.slice(start, end);
    const content = stripMarker(raw, blockId);
    if (!safeContent(content)) return null;
    blocks.push({ blockId, raw, content, contentHash: hashMarkdownBlock(content) });
    seen.add(blockId);
    previousEnd = end;
  }
  const trailing = source.slice(previousEnd);
  if (!/^\n?$/.test(trailing)) return null;
  const trailingNewline = trailing === "\n";
  if (blocks.map((block) => block.raw).join("\n\n") + (trailingNewline ? "\n" : "") !== source) return null;
  return { blocks, trailingNewline };
}

function singleBlock(content: string, blockId: string): MarkdownPatchBlock | null {
  const parsed = parseMarkdownPatchDocument(content);
  return parsed && !parsed.trailingNewline && parsed.blocks.length === 1 && parsed.blocks[0].blockId === blockId
    ? parsed.blocks[0]
    : null;
}

export function applyMarkdownBlockPatch(source: string, operations: MarkdownBlockPatchOperation[]) {
  const parsed = parseMarkdownPatchDocument(source);
  if (!parsed) throw new Error("INVALID_MARKDOWN_DOCUMENT");
  const blocks = parsed.blocks.map((block) => ({ ...block }));
  for (const operation of operations) {
    const index = blocks.findIndex((block) => block.blockId === operation.blockId);
    if (operation.type === "insert") {
      if (index >= 0) throw new Error("BLOCK_ID_CONFLICT");
      const target = blocks.findIndex((block) => block.blockId === operation.targetBlockId);
      const block = singleBlock(operation.content, operation.blockId);
      if (target < 0 || !block) throw new Error("INVALID_MARKDOWN_PATCH");
      blocks.splice(target + (operation.position === "after" ? 1 : 0), 0, block);
      continue;
    }
    if (index < 0 || blocks[index].contentHash !== operation.expectedHash) throw new Error("BLOCK_HASH_CONFLICT");
    if (operation.type === "replace") {
      const block = singleBlock(operation.content, operation.blockId);
      if (!block) throw new Error("INVALID_MARKDOWN_PATCH");
      blocks[index] = block;
    } else if (operation.type === "delete") {
      blocks.splice(index, 1);
    } else {
      const [block] = blocks.splice(index, 1);
      const target = blocks.findIndex((entry) => entry.blockId === operation.targetBlockId);
      if (target < 0) throw new Error("BLOCK_NOT_FOUND");
      blocks.splice(target + (operation.position === "after" ? 1 : 0), 0, block);
    }
  }
  if (blocks.length === 0) throw new Error("UNSAFE_MARKDOWN_BOUNDARY");
  return { content: blocks.map((block) => block.raw).join("\n\n") + (parsed.trailingNewline ? "\n" : "") };
}
