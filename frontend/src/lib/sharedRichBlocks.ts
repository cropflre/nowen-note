import { CALLOUT_TYPE_ORDER, type CalloutType } from "@/components/extensions/calloutTypes";
import { normalizeTextBoxFloat, normalizeTextBoxWidth, textBoxMargin } from "@/components/extensions/textBoxLayout";

interface SharedNode {
  type?: string;
  attrs?: Record<string, unknown> | null;
  content?: SharedNode[];
}

type RenderChildren = (node: SharedNode) => string;

/**
 * 分享页只读渲染的高亮块（含文本框）、分栏和折叠块。结构与编辑器的静态 HTML 一致，
 * 样式见 components/sharedRichBlocks.css。写进属性的值都先归一化成白名单里的值。
 * 其他节点返回 null，交给分享页原有的渲染。
 */
export function renderSharedRichBlock(node: SharedNode, renderChildren: RenderChildren): string | null {
  const attrs = node.attrs ?? {};
  switch (node.type) {
    case "callout": {
      const type: CalloutType = CALLOUT_TYPE_ORDER.includes(attrs.type as CalloutType) ? attrs.type as CalloutType : "blue";
      const float = normalizeTextBoxFloat(attrs.float);
      const width = normalizeTextBoxWidth(attrs.width);
      const layout = float
        ? ` data-float="${float}" data-width="${width}" style="float:${float};width:${width}%;margin:${textBoxMargin(float)};box-sizing:border-box"`
        : "";
      return `<div data-type="callout" data-callout-type="${type}"${layout}><div class="prosemirror-callout-content">${renderChildren(node)}</div></div>`;
    }
    case "column_container":
      return `<div class="prosemirror-column-container">${renderChildren(node)}</div>`;
    case "column": {
      const width = Math.max(50, Math.round(Number(attrs.colWidth)) || 200);
      const resized = attrs.resized === true ? ` data-resized="true" style="width:${width}px;flex:0 0 auto;min-width:0"` : "";
      return `<div class="prosemirror-column"${resized}>${renderChildren(node)}</div>`;
    }
    case "details": {
      const children = node.content ?? [];
      const summary = children.find((child) => child.type === "detailsSummary");
      const body = children.find((child) => child.type === "detailsContent");
      return `<details data-type="details"${attrs.open === true ? " open" : ""}><summary>${summary ? renderChildren(summary) : ""}</summary><div data-type="detailsContent">${body ? renderChildren(body) : ""}</div></details>`;
    }
    default:
      return null;
  }
}
