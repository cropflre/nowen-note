import type { NoteEditorHeading } from "@/components/editors/types";

export interface TiptapJsonNode {
  type?: string;
  attrs?: Record<string, unknown>;
  text?: string;
  content?: TiptapJsonNode[];
}

export interface TiptapAnalysisResult {
  plainText: string;
  headings: NoteEditorHeading[];
  stats: { chars: number; charsNoSpace: number; words: number };
}

const PLAIN_TEXT_BLOCK_TYPES = new Set(["paragraph", "heading", "codeBlock"]);

/**
 * ProseMirror leaf/atom nodes always have nodeSize = 1, even when their DOM is large.
 *
 * Empty text blocks and container nodes are different: their JSON normally omits the
 * `content` property, but their ProseMirror nodeSize is still 2 (opening + closing token).
 * Treating every node without JSON children as a leaf made each legacy empty paragraph,
 * empty heading or empty list cell shift every following outline position by one.
 */
const PROSEMIRROR_LEAF_NODE_TYPES = new Set([
  "hardBreak",
  "horizontalRule",
  "image",
  "video",
  "blockEmbed",
  "mathInline",
  "mathBlock",
  "footnoteReference",
  "footnoteDefinition",
  // Compatibility for atom nodes that can exist in imported or older documents.
  "attachment",
  "emoji",
  "mention",
]);

function nodeSize(node: TiptapJsonNode): number {
  const type = node.type || "";
  if (type === "text") return node.text?.length || 0;
  if (PROSEMIRROR_LEAF_NODE_TYPES.has(type)) return 1;

  // ProseMirror non-leaf nodes contribute two boundary tokens even when empty.
  return 2 + (node.content || []).reduce((total, child) => total + nodeSize(child), 0);
}

function inlineText(node: TiptapJsonNode): string {
  if (node.type === "text") return node.text || "";
  if (node.type === "hardBreak") return "\n";
  return (node.content || []).map(inlineText).join("");
}

/** Worker-safe derived data for a plain Tiptap JSON snapshot. */
export function analyzeTiptapDocument(doc: TiptapJsonNode): TiptapAnalysisResult {
  const headings: NoteEditorHeading[] = [];
  const blocks: string[] = [];

  const visit = (node: TiptapJsonNode, pos: number) => {
    if (PLAIN_TEXT_BLOCK_TYPES.has(node.type || "")) blocks.push(inlineText(node));
    if (node.type === "heading") {
      headings.push({
        id: `h-${headings.length}`,
        level: typeof node.attrs?.level === "number" ? node.attrs.level : 1,
        text: inlineText(node),
        pos,
      });
    }

    let childPos = node.type === "doc" ? pos : pos + 1;
    for (const child of node.content || []) {
      visit(child, childPos);
      childPos += nodeSize(child);
    }
  };

  visit(doc, 0);
  const plainText = blocks.join("\n");
  const chars = plainText.length;
  const charsNoSpace = plainText.replace(/\s/g, "").length;
  const cjk = (plainText.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) || []).length;
  const nonCjk = plainText
    .replace(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g, " ")
    .trim();
  const englishWords = nonCjk ? nonCjk.split(/\s+/).filter(Boolean).length : 0;

  return {
    plainText,
    headings,
    stats: { chars, charsNoSpace, words: cjk + englishWords },
  };
}
