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

const CALLOUT_MARKER_RE = /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:[ \t]+(.+?))?\s*$/i;

export function parseSiyuanCalloutMarker(value: string): SiyuanCalloutMarker | null {
  const match = value.match(CALLOUT_MARKER_RE);
  if (!match) return null;

  const type = match[1].toLowerCase() as SiyuanCalloutType;
  const customTitle = match[2]?.trim();

  return {
    type,
    title: customTitle || CALLOUT_TITLES[type],
    rest: "",
  };
}

function visit(node: MarkdownNode, visitor: (node: MarkdownNode) => void) {
  visitor(node);
  for (const child of node.children || []) {
    visit(child, visitor);
  }
}

function readFirstParagraphText(node: MarkdownNode): string | null {
  const firstChild = node.children?.[0];
  if (firstChild?.type !== "paragraph") return null;
  const firstInline = firstChild.children?.[0];
  if (firstInline?.type !== "text") return null;
  return firstInline.value ?? "";
}

export function remarkSiyuanCallouts() {
  return (tree: MarkdownNode) => {
    visit(tree, (node) => {
      if (node.type !== "blockquote") return;

      const firstText = readFirstParagraphText(node);
      if (firstText === null) return;

      const marker = parseSiyuanCalloutMarker(firstText);
      if (!marker) return;

      node.data = {
        ...node.data,
        hProperties: {
          ...node.data?.hProperties,
          "data-callout-type": marker.type,
          "data-callout-title": marker.title,
        },
      };
      node.children = node.children?.slice(1) || [];
    });
  };
}
