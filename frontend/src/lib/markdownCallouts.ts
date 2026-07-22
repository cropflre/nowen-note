export type SiyuanCalloutType = "note" | "tip" | "important" | "warning" | "caution";

export interface SiyuanCalloutMarker {
  type: SiyuanCalloutType;
  title: string;
  rest: string;
  fold: "expanded" | "collapsed" | null;
}

type MarkdownNode = {
  type?: string;
  value?: string;
  children?: MarkdownNode[];
  data?: {
    hProperties?: Record<string, string>;
    [key: string]: unknown;
  };
};

const CALLOUT_TITLES: Record<SiyuanCalloutType, string> = {
  note: "Note",
  tip: "Tip",
  important: "Important",
  warning: "Warning",
  caution: "Caution",
};

const CALLOUT_ALIASES: Record<string, SiyuanCalloutType> = {
  note: "note",
  info: "note",
  abstract: "note",
  summary: "note",
  tldr: "note",
  quote: "note",
  cite: "note",
  tip: "tip",
  hint: "tip",
  success: "tip",
  check: "tip",
  done: "tip",
  important: "important",
  question: "important",
  help: "important",
  faq: "important",
  example: "important",
  warning: "warning",
  warn: "warning",
  attention: "warning",
  caution: "caution",
  danger: "caution",
  error: "caution",
  failure: "caution",
  fail: "caution",
  bug: "caution",
};

const CALLOUT_MARKER_RE = /^\s*\[!([A-Z0-9_-]+)\]([+-])?(?:[ \t]+([^\r\n]*?))?(?:\r?\n([\s\S]*))?\s*$/i;
const IAL_RE = /^\s*\{:\s*[\s\S]*\}\s*$/;

export function parseSiyuanCalloutMarker(value: string): SiyuanCalloutMarker | null {
  const match = value.replace(/[\u200B-\u200D\uFEFF]/g, "").match(CALLOUT_MARKER_RE);
  if (!match) return null;

  const type = CALLOUT_ALIASES[match[1].toLowerCase()];
  if (!type) return null;
  const customTitle = match[3]?.trim();
  return {
    type,
    title: customTitle || CALLOUT_TITLES[type],
    rest: match[4] || "",
    fold: match[2] === "+" ? "expanded" : match[2] === "-" ? "collapsed" : null,
  };
}

function visit(node: MarkdownNode, visitor: (node: MarkdownNode) => void) {
  visitor(node);
  for (const child of node.children || []) visit(child, visitor);
}

function inlineText(node: MarkdownNode): string {
  if (node.type === "text" || node.type === "inlineCode") return node.value || "";
  if (node.type === "break") return "\n";
  return (node.children || []).map(inlineText).join("");
}

function paragraphText(node: MarkdownNode | undefined): string {
  return node?.type === "paragraph" ? inlineText(node) : "";
}

function isStandaloneIal(node: MarkdownNode): boolean {
  return node.type === "paragraph" && IAL_RE.test(paragraphText(node));
}

function pruneStandaloneIal(node: MarkdownNode): void {
  if (!Array.isArray(node.children)) return;
  node.children = node.children.filter((child) => !isStandaloneIal(child));
  for (const child of node.children) pruneStandaloneIal(child);
}

function extractMarker(node: MarkdownNode): SiyuanCalloutMarker | null {
  const firstParagraph = node.children?.[0];
  if (firstParagraph?.type !== "paragraph") return null;
  const marker = parseSiyuanCalloutMarker(paragraphText(firstParagraph));
  if (!marker) return null;

  if (marker.rest) {
    firstParagraph.children = [{ type: "text", value: marker.rest }];
  } else {
    node.children = node.children?.slice(1) || [];
  }
  return marker;
}

export function remarkSiyuanCallouts() {
  return (tree: MarkdownNode) => {
    // Block IAL rows can be siblings of the callout rather than children of its
    // blockquote. Remove them at every container level before decorating callouts.
    pruneStandaloneIal(tree);
    visit(tree, (node) => {
      if (node.type !== "blockquote") return;
      const marker = extractMarker(node);
      if (!marker) return;

      node.data = {
        ...node.data,
        hProperties: {
          ...node.data?.hProperties,
          "data-callout-type": marker.type,
          "data-callout-title": marker.title,
          ...(marker.fold ? { "data-callout-fold": marker.fold } : {}),
        },
      };
    });
  };
}
