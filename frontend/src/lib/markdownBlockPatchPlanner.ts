import {
  applyMarkdownBlockPatch,
  parseMarkdownPatchDocument,
  type MarkdownBlockPatchOperation,
} from "@/lib/markdownBlockPatch";

export interface MarkdownBlockPatchPlan {
  operations: MarkdownBlockPatchOperation[];
  affectedBlockIds: string[];
}

export function planMarkdownBlockPatch(baseContent: string, nextContent: string): MarkdownBlockPatchPlan | null {
  if (!baseContent || !nextContent || baseContent === nextContent) return null;
  const base = parseMarkdownPatchDocument(baseContent);
  const next = parseMarkdownPatchDocument(nextContent);
  if (!base || !next || base.trailingNewline !== next.trailingNewline) return null;
  const baseById = new Map(base.blocks.map((block) => [block.blockId, block]));
  const nextById = new Map(next.blocks.map((block) => [block.blockId, block]));
  const operations: MarkdownBlockPatchOperation[] = [];

  for (const block of base.blocks) {
    const after = nextById.get(block.blockId);
    if (after && after.raw !== block.raw) {
      operations.push({ type: "replace", blockId: block.blockId, expectedHash: block.contentHash, content: after.raw });
    }
  }
  for (const block of base.blocks) {
    if (!nextById.has(block.blockId)) operations.push({ type: "delete", blockId: block.blockId, expectedHash: block.contentHash });
  }

  const current = base.blocks.filter((block) => nextById.has(block.blockId)).map((block) => block.blockId);
  for (let index = 0; index < next.blocks.length; index += 1) {
    const block = next.blocks[index];
    if (baseById.has(block.blockId)) continue;
    const previous = next.blocks.slice(0, index).reverse().find((entry) => current.includes(entry.blockId));
    const following = next.blocks.slice(index + 1).find((entry) => current.includes(entry.blockId));
    const target = previous || following;
    if (!target) return null;
    const position = previous ? "after" : "before";
    operations.push({ type: "insert", blockId: block.blockId, targetBlockId: target.blockId, position, content: block.raw });
    const targetIndex = current.indexOf(target.blockId);
    current.splice(targetIndex + (position === "after" ? 1 : 0), 0, block.blockId);
  }

  const hashById = new Map(next.blocks.map((block) => [block.blockId, block.contentHash]));
  const desired = next.blocks.map((block) => block.blockId);
  for (let index = 0; index < desired.length; index += 1) {
    if (current[index] === desired[index]) continue;
    const found = current.indexOf(desired[index], index + 1);
    if (found < 0 || !current[index]) return null;
    operations.push({
      type: "move",
      blockId: desired[index],
      expectedHash: hashById.get(desired[index])!,
      targetBlockId: current[index],
      position: "before",
    });
    const [moved] = current.splice(found, 1);
    current.splice(index, 0, moved);
  }
  if (operations.length < 1 || operations.length > 100) return null;
  try {
    if (applyMarkdownBlockPatch(baseContent, operations).content !== nextContent) return null;
  } catch {
    return null;
  }
  return { operations, affectedBlockIds: [...new Set(operations.map((operation) => operation.blockId))] };
}
