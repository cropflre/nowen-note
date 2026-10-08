/**
 * Read a GFM checkbox from the item's immediate paragraph only.
 * Do not inspect nested sub-lists: a checked child must not check its parent.
 */
interface HastTaskNode {
  type?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastTaskNode[];
}

export function getGfmTaskChecked(node: HastTaskNode | null | undefined): boolean | null {
  const children = node?.children || [];
  const paragraph = node?.tagName === "li"
    ? children.find((child) => child.type === "element" && child.tagName === "p")
    : null;
  const directChildren = paragraph?.children || children;
  const input = directChildren.find((child) => child.type === "element"
    && child.tagName === "input"
    && child.properties?.type === "checkbox");
  if (!input) return null;
  const checked = input.properties?.checked;
  return checked === true || checked === "" || checked === "checked" || checked === "true";
}
