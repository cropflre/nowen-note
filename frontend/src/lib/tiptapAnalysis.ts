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

const LEAF_TEXT_TYPES = new Set(["paragraph", "heading", "codeBlock"]);

function nodeSize(node: TiptapJsonNode): number {
  if (node.type === "text") return node.text?.length || 0;
  if (!node.content?.length) return 1;
  return 2 + node.content.reduce((total, child) => total + nodeSize(child), 0);
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
    if (LEAF_TEXT_TYPES.has(node.type || "")) blocks.push(inlineText(node));
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
