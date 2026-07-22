import type {
  MarkdownSplitPreview,
  NoteSplitHeadingLevel,
} from "@/lib/noteSplit";

function collectNodeText(value: unknown, output: string[]): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectNodeText(item, output);
    return;
  }
  const node = value as Record<string, unknown>;
  if (node.type === "text" && typeof node.text === "string") output.push(node.text);
  if (node.type === "hardBreak") output.push("\n");
  if (Array.isArray(node.content)) collectNodeText(node.content, output);
}

function cleanTitle(node: Record<string, unknown>, index: number): string {
  const output: string[] = [];
  collectNodeText(node, output);
  const title = output
    .join("")
    .replace(/\s+\^blk_[A-Za-z0-9_-]{6,}\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
  return (title || `第 ${index + 1} 节`).slice(0, 200);
}

function parseRoot(serialized: string): Array<Record<string, unknown>> | null {
  try {
    const parsed = JSON.parse(serialized || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const root = parsed as Record<string, unknown>;
    if (root.type !== "doc" || !Array.isArray(root.content)) return null;
    return root.content as Array<Record<string, unknown>>;
  } catch {
    return null;
  }
}

function isHeading(node: Record<string, unknown>, level: NoteSplitHeadingLevel): boolean {
  if (node.type !== "heading") return false;
  const attrs = node.attrs;
  return !!attrs
    && typeof attrs === "object"
    && !Array.isArray(attrs)
    && Number((attrs as Record<string, unknown>).level) === level;
}

export function buildTiptapSplitPreview(
  serialized: string,
  headingLevel: NoteSplitHeadingLevel,
): MarkdownSplitPreview {
  const nodes = parseRoot(serialized);
  if (!nodes) {
    return { headingLevel, preamble: "", sections: [], sourceCharacters: serialized.length };
  }
  const boundaries: number[] = [];
  nodes.forEach((node, index) => {
    if (isHeading(node, headingLevel)) boundaries.push(index);
  });
  const preambleNodes = nodes.slice(0, boundaries[0] ?? nodes.length);
  return {
    headingLevel,
    preamble: JSON.stringify({ type: "doc", content: preambleNodes }),
    sourceCharacters: serialized.length,
    sections: boundaries.map((start, index) => {
      const end = boundaries[index + 1] ?? nodes.length;
      const bodyNodes = nodes.slice(start + 1, end);
      const fullNodes = nodes.slice(start, end);
      return {
        index,
        title: cleanTitle(nodes[start], index),
        content: JSON.stringify({ type: "doc", content: bodyNodes }),
        sourceStart: start,
        sourceEnd: end,
        sourceCharacters: JSON.stringify(fullNodes).length,
      };
    }),
  };
}

export function findPreferredTiptapSplitLevel(serialized: string): NoteSplitHeadingLevel | null {
  const nodes = parseRoot(serialized);
  if (!nodes) return null;
  let h1 = 0;
  let h2 = 0;
  for (const node of nodes) {
    if (isHeading(node, 1)) h1 += 1;
    if (isHeading(node, 2)) h2 += 1;
    if (h1 >= 2) return 1;
    if (h2 >= 2) return 2;
  }
  return h1 >= 2 ? 1 : h2 >= 2 ? 2 : null;
}
