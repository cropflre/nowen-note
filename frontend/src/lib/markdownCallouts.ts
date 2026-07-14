export type SiyuanCalloutType = "note" | "tip" | "important" | "warning" | "caution";

interface SiyuanCalloutMarker {
  type: SiyuanCalloutType;
  title: string;
  rest: string;
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

// SiYuan exports both the GitHub-style form (`[!TIP]`) and the collapsible
// variants used by Obsidian-compatible Markdown (`[!TIP]+` / `[!TIP]-`).
// The body may stay in the same mdast text node when there is no blank quote
// line, so keep everything after the first newline as paragraph content.
const CALLOUT_MARKER_RE = /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:[+-])?(?:[ \t]+([^\r\n]*?))?(?:\r?\n([\s\S]*))?\s*$/i;

export function parseSiyuanCalloutMarker(value: string): SiyuanCalloutMarker | null {
  const match = value.match(CALLOUT_MARKER_RE);
  if (!match) return null;

  const type = match[1].toLowerCase() as SiyuanCalloutType;
  const customTitle = match[2]?.trim();

  return {
    type,
    title: customTitle || CALLOUT_TITLES[type],
    rest: match[3] || "",
  };
}

function visit(node: MarkdownNode, visitor: (node: MarkdownNode) => void) {
  visitor(node);
  for (const child of node.children || []) {
    visit(child, visitor);
  }
}

function extractMarker(node: MarkdownNode): SiyuanCalloutMarker | null {
  const firstParagraph = node.children?.[0];
  if (firstParagraph?.type !== "paragraph") return null;
  const firstInline = firstParagraph.children?.[0];
  if (firstInline?.type !== "text") return null;

  const marker = parseSiyuanCalloutMarker(firstInline.value ?? "");
  if (!marker) return null;

  if (marker.rest) {
    firstInline.value = marker.rest;
  } else {
    firstParagraph.children = firstParagraph.children?.slice(1) || [];
  }

  if ((firstParagraph.children || []).length === 0) {
    node.children = node.children?.slice(1) || [];
  }

  return marker;
}

export function remarkSiyuanCallouts() {
  return (tree: MarkdownNode) => {
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
        },
      };
    });
  };
}
