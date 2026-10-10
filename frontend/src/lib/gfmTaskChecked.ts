/**
 * Read a GFM checkbox from the item's immediate paragraph only.
 * Do not inspect nested sub-lists: a checked child must not check its parent.
 */
import React from "react";

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

/**
 * GFM tight lists render checkbox/text directly inside li; loose lists render p.
 * Wrap only inline siblings after the checkbox, never nested ul/ol content.
 */
export function wrapGfmTaskInlineContent(children: React.ReactNode): React.ReactNode {
  const output: React.ReactNode[] = [];
  let text: React.ReactNode[] = [];
  const flush = () => {
    if (text.length === 0) return;
    // GFM can emit a whitespace-only text node after a nested <ul>.
    // That is layout whitespace, not another task text fragment.
    if (text.every((part) => typeof part === "string" && !part.trim())) {
      text = [];
      return;
    }
    output.push(React.createElement("span", {
      key: "task-text-" + output.length,
      className: "nowen-task-item-text",
    }, ...text));
    text = [];
  };

  for (const child of React.Children.toArray(children)) {
    const element = React.isValidElement(child) ? child : null;
    const props = element?.props as { node?: { tagName?: string }; type?: string } | undefined;
    const tag = props?.node?.tagName
      || (typeof element?.type === "string" ? element.type : "")
      || (props?.type === "checkbox" ? "input" : "");
    // A task can contain other block nodes, especially independent nested tasks.
    if (["input", "p", "ul", "ol", "div", "blockquote", "table", "pre"].includes(tag)) {
      flush();
      output.push(child);
    } else {
      text.push(child);
    }
  }
  flush();
  return output;
}
