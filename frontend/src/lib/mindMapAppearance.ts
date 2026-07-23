export type MindMapNodeStyle = "card" | "minimal";

export interface MindMapAppearance {
  nodeStyle?: MindMapNodeStyle;
  [key: string]: unknown;
}

export interface MindMapDocument extends Record<string, unknown> {
  root?: {
    id?: string;
    text?: string;
    [key: string]: unknown;
  };
  appearance?: MindMapAppearance;
}

export function parseMindMapDocument(value: unknown): MindMapDocument | null {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as MindMapDocument
        : null;
    } catch {
      return null;
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as MindMapDocument
    : null;
}

export function getMindMapNodeStyle(document: MindMapDocument | null | undefined): MindMapNodeStyle {
  return document?.appearance?.nodeStyle === "minimal" ? "minimal" : "card";
}

export function withMindMapNodeStyle(
  document: MindMapDocument,
  nodeStyle: MindMapNodeStyle,
): MindMapDocument {
  return {
    ...document,
    appearance: {
      ...(document.appearance || {}),
      nodeStyle,
    },
  };
}

/**
 * The current editor does not know about the optional appearance field yet. Merge the active
 * style into every autosave payload so an ordinary node edit cannot accidentally remove it.
 */
export function preserveMindMapNodeStyleInSerializedData(
  serializedData: string,
  fallbackStyle: MindMapNodeStyle,
): string {
  const document = parseMindMapDocument(serializedData);
  if (!document) return serializedData;
  if (document.appearance?.nodeStyle === "card" || document.appearance?.nodeStyle === "minimal") {
    return serializedData;
  }
  return JSON.stringify(withMindMapNodeStyle(document, fallbackStyle));
}

function replaceAttribute(tag: string, attribute: string, value: string): string {
  const pattern = new RegExp(`\\s${attribute}="[^"]*"`);
  if (pattern.test(tag)) return tag.replace(pattern, ` ${attribute}="${value}"`);
  return tag.replace(/\s*\/>$/, ` ${attribute}="${value}"/>`);
}

/**
 * MindMapEditor builds SVG and PNG exports from the same generated SVG string. Keep the root card
 * intact, then remove fill/border from all descendant node rectangles in minimal mode.
 */
export function transformMindMapExportSvg(
  svg: string,
  nodeStyle: MindMapNodeStyle,
): string {
  if (nodeStyle !== "minimal") return svg;
  if (!svg.includes('dominant-baseline="central"') || !svg.includes("<rect")) return svg;

  let nodeRectIndex = 0;
  const withoutCards = svg.replace(/<rect\b[^>]*\/>/g, (tag) => {
    nodeRectIndex += 1;
    if (nodeRectIndex === 1) return tag;
    return replaceAttribute(
      replaceAttribute(
        replaceAttribute(tag, "fill", "transparent"),
        "stroke",
        "none",
      ),
      "stroke-width",
      "0",
    );
  });

  let nodeTextIndex = 0;
  return withoutCards.replace(/<text\b[^>]*>/g, (tag) => {
    nodeTextIndex += 1;
    if (nodeTextIndex === 1) return tag;
    return replaceAttribute(tag, "fill", "#374151");
  });
}

export function getMindMapRootText(document: MindMapDocument | null | undefined): string {
  return typeof document?.root?.text === "string" ? document.root.text : "";
}

export function escapeMindMapXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
