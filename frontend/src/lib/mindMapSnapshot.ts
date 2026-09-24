import type { MindMapData, MindMapNode } from "@/types";
import { computeLayoutBounds } from "@/lib/mindmapViewport";

const NODE_H = 38;
const NODE_MIN_W = 88;
const NODE_MAX_W = 520;
const NODE_CHAR_W = 13;
const H_GAP = 52;
const V_GAP = 14;
const DEFAULT_MAX_NODES = 240;

const DEPTH_COLORS = [
  { bg: "#6366f1", text: "#ffffff", border: "#4f46e5" },
  { bg: "#eef2ff", text: "#374151", border: "#c7d2fe" },
  { bg: "#f8fafc", text: "#374151", border: "#e2e8f0" },
  { bg: "#fafafa", text: "#374151", border: "#e5e7eb" },
];

export interface MindMapSnapshotNode {
  id: string;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  depth: number;
  parentId: string | null;
  style?: MindMapNode["style"];
}

export interface MindMapSnapshotEdge {
  fromId: string;
  toId: string;
}

export interface MindMapSnapshot {
  nodes: MindMapSnapshotNode[];
  edges: MindMapSnapshotEdge[];
  relations: Array<{ id: string; fromId: string; toId: string; label?: string }>;
  boundaries: Array<{ id: string; nodeIds: string[]; color?: string; label?: string }>;
  viewBox: string;
  bounds: { minX: number; minY: number; width: number; height: number };
  truncated: boolean;
}

type MutableLayoutNode = MindMapSnapshotNode & {
  children: MutableLayoutNode[];
};

function clampNodeWidth(width: number): number {
  return Math.max(NODE_MIN_W, Math.min(Math.round(width), NODE_MAX_W));
}

function measureNode(node: Pick<MindMapNode, "text" | "width">) {
  const text = String(node.text || "未命名主题");
  const autoWidth = Math.max(NODE_MIN_W, Math.min(text.length * NODE_CHAR_W + 34, 280));
  const width = typeof node.width === "number" && Number.isFinite(node.width)
    ? clampNodeWidth(node.width)
    : autoWidth;
  return { width, height: NODE_H };
}

function subtreeHeight(node: MutableLayoutNode): number {
  if (node.children.length === 0) return node.height;
  const total = node.children.reduce(
    (sum, child, index) => sum + subtreeHeight(child) + (index > 0 ? V_GAP : 0),
    0,
  );
  return Math.max(node.height, total);
}

function layoutRight(node: MutableLayoutNode, x: number, centerY: number): void {
  node.x = x;
  node.y = centerY - node.height / 2;
  if (node.children.length === 0) return;
  const childX = x + node.width + H_GAP;
  const total = node.children.reduce(
    (sum, child, index) => sum + subtreeHeight(child) + (index > 0 ? V_GAP : 0),
    0,
  );
  let cursor = centerY - total / 2;
  for (const child of node.children) {
    const height = subtreeHeight(child);
    layoutRight(child, childX, cursor + height / 2);
    cursor += height + V_GAP;
  }
}

function layoutLeft(node: MutableLayoutNode, rightEdge: number, centerY: number): void {
  node.x = rightEdge - node.width;
  node.y = centerY - node.height / 2;
  if (node.children.length === 0) return;
  const childRightEdge = node.x - H_GAP;
  const total = node.children.reduce(
    (sum, child, index) => sum + subtreeHeight(child) + (index > 0 ? V_GAP : 0),
    0,
  );
  let cursor = centerY - total / 2;
  for (const child of node.children) {
    const height = subtreeHeight(child);
    layoutLeft(child, childRightEdge, cursor + height / 2);
    cursor += height + V_GAP;
  }
}

function flatten(root: MutableLayoutNode): MutableLayoutNode[] {
  const result = [root];
  for (const child of root.children) result.push(...flatten(child));
  return result;
}

function buildTree(
  node: MindMapNode,
  depth: number,
  parentId: string | null,
  budget: { remaining: number; truncated: boolean },
): MutableLayoutNode | null {
  if (budget.remaining <= 0) {
    budget.truncated = true;
    return null;
  }
  budget.remaining -= 1;
  const measured = measureNode(node);
  const current: MutableLayoutNode = {
    id: String(node.id || `snapshot-${depth}-${budget.remaining}`),
    text: String(node.text || "未命名主题"),
    x: 0,
    y: 0,
    width: measured.width,
    height: measured.height,
    depth,
    parentId,
    style: node.style,
    children: [],
  };
  if (!node.collapsed && Array.isArray(node.children)) {
    for (const child of node.children) {
      const built = buildTree(child, depth + 1, current.id, budget);
      if (built) current.children.push(built);
      if (budget.remaining <= 0) {
        if (node.children.indexOf(child) < node.children.length - 1) budget.truncated = true;
        break;
      }
    }
  }
  return current;
}

function totalHeight(nodes: MutableLayoutNode[]): number {
  if (nodes.length === 0) return NODE_H;
  return nodes.reduce(
    (sum, node, index) => sum + subtreeHeight(node) + (index > 0 ? V_GAP : 0),
    0,
  );
}

function layoutSide(
  children: MutableLayoutNode[],
  direction: "left" | "right",
  root: MutableLayoutNode,
  centerY: number,
): void {
  if (children.length === 0) return;
  const total = totalHeight(children);
  let cursor = centerY - total / 2;
  for (const child of children) {
    const height = subtreeHeight(child);
    if (direction === "right") {
      layoutRight(child, root.x + root.width + H_GAP, cursor + height / 2);
    } else {
      layoutLeft(child, root.x - H_GAP, cursor + height / 2);
    }
    cursor += height + V_GAP;
  }
}

export function buildMindMapSnapshot(
  data: MindMapData,
  options: { maxNodes?: number; padding?: number } = {},
): MindMapSnapshot {
  if (!data?.root) throw new Error("Invalid mind map data");
  const budget = {
    remaining: Math.max(1, Math.min(options.maxNodes ?? DEFAULT_MAX_NODES, 1000)),
    truncated: false,
  };
  const root = buildTree(data.root, 0, null, budget);
  if (!root) throw new Error("Mind map root is missing");

  root.x = 0;
  const originalChildren = [...root.children];
  root.children = [];

  const left: MutableLayoutNode[] = [];
  const right: MutableLayoutNode[] = [];
  if (data.layout === "left-right" && originalChildren.length > 1) {
    originalChildren.forEach((child, index) => (index % 2 === 0 ? right : left).push(child));
  } else {
    right.push(...originalChildren);
  }

  const canvasHeight = Math.max(totalHeight(left), totalHeight(right), NODE_H);
  const centerY = canvasHeight / 2;
  root.y = centerY - root.height / 2;
  layoutSide(right, "right", root, centerY);
  layoutSide(left, "left", root, centerY);

  const nodes = [
    root,
    ...right.flatMap(flatten),
    ...left.flatMap(flatten),
  ];
  const visibleIds = new Set(nodes.map((node) => node.id));
  const edges: MindMapSnapshotEdge[] = [];
  for (const node of nodes) {
    if (node.parentId && visibleIds.has(node.parentId)) {
      edges.push({ fromId: node.parentId, toId: node.id });
    }
  }

  const padding = Math.max(16, options.padding ?? 42);
  const rawBounds = computeLayoutBounds(nodes, padding);
  const viewBox = `${rawBounds.minX} ${rawBounds.minY} ${rawBounds.width} ${rawBounds.height}`;

  return {
    nodes: nodes.map(({ children: _children, ...node }) => node),
    edges,
    relations: (data.relations || []).filter(
      (relation) => visibleIds.has(relation.fromId) && visibleIds.has(relation.toId),
    ),
    boundaries: (data.boundaries || [])
      .map((boundary) => ({
        ...boundary,
        nodeIds: boundary.nodeIds.filter((id) => visibleIds.has(id)),
      }))
      .filter((boundary) => boundary.nodeIds.length >= 2),
    viewBox,
    bounds: {
      minX: rawBounds.minX,
      minY: rawBounds.minY,
      width: rawBounds.width,
      height: rawBounds.height,
    },
    truncated: budget.truncated,
  };
}

function escapeXml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function safeColor(value: unknown, fallback: string): string {
  const color = String(value || "").trim();
  if (
    /^#[0-9a-f]{3,8}$/i.test(color) ||
    /^rgba?\(\s*[\d.]+%?\s*,\s*[\d.]+%?\s*,\s*[\d.]+%?(?:\s*,\s*[\d.]+%?)?\s*\)$/i.test(color) ||
    /^hsla?\(\s*[\d.]+(?:deg)?\s*,\s*[\d.]+%\s*,\s*[\d.]+%(?:\s*,\s*[\d.]+%?)?\s*\)$/i.test(color)
  ) {
    return color;
  }
  return fallback;
}

function colorForNode(node: MindMapSnapshotNode) {
  const fallback = DEPTH_COLORS[Math.min(node.depth, DEPTH_COLORS.length - 1)];
  return {
    bg: safeColor(node.style?.bg, fallback.bg),
    text: safeColor(node.style?.color, fallback.text),
    border: safeColor(node.style?.border, fallback.border),
  };
}

function edgePath(from: MindMapSnapshotNode, to: MindMapSnapshotNode): string {
  const toIsLeft = to.x + to.width < from.x;
  const x1 = toIsLeft ? from.x : from.x + from.width;
  const y1 = from.y + from.height / 2;
  const x2 = toIsLeft ? to.x + to.width : to.x;
  const y2 = to.y + to.height / 2;
  const mx = (x1 + x2) / 2;
  return `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`;
}

function displayText(node: MindMapSnapshotNode): string {
  const approxChars = Math.max(4, Math.floor((node.width - 26) / 7.2));
  return node.text.length > approxChars ? `${node.text.slice(0, Math.max(1, approxChars - 1))}…` : node.text;
}

export function mindMapSnapshotToSvg(
  snapshot: MindMapSnapshot,
  options: { title?: string; background?: string; className?: string } = {},
): string {
  const byId = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const background = options.background ? safeColor(options.background, "#ffffff") : "";
  const className = escapeXml(options.className || "nowen-mindmap-snapshot");
  const title = escapeXml(options.title || "思维导图");

  const boundaries = snapshot.boundaries.map((boundary) => {
    const nodes = boundary.nodeIds.map((id) => byId.get(id)).filter(Boolean) as MindMapSnapshotNode[];
    if (nodes.length < 2) return "";
    const pad = 14;
    const minX = Math.min(...nodes.map((node) => node.x)) - pad;
    const minY = Math.min(...nodes.map((node) => node.y)) - pad;
    const maxX = Math.max(...nodes.map((node) => node.x + node.width)) + pad;
    const maxY = Math.max(...nodes.map((node) => node.y + node.height)) + pad;
    const color = safeColor(boundary.color, "#6366f1");
    return `<g><rect x="${minX}" y="${minY}" width="${maxX - minX}" height="${maxY - minY}" rx="10" fill="none" stroke="${color}" stroke-width="1.5" stroke-dasharray="7 4"/>${boundary.label ? `<text x="${minX + 8}" y="${minY - 5}" font-size="11" fill="${color}">${escapeXml(boundary.label)}</text>` : ""}</g>`;
  }).join("");

  const edges = snapshot.edges.map((edge) => {
    const from = byId.get(edge.fromId);
    const to = byId.get(edge.toId);
    return from && to
      ? `<path d="${edgePath(from, to)}" fill="none" stroke="#94a3b8" stroke-opacity="0.58" stroke-width="1.6" vector-effect="non-scaling-stroke"/>`
      : "";
  }).join("");

  const relations = snapshot.relations.map((relation) => {
    const from = byId.get(relation.fromId);
    const to = byId.get(relation.toId);
    if (!from || !to) return "";
    const fx = from.x + from.width / 2;
    const fy = from.y + from.height / 2;
    const tx = to.x + to.width / 2;
    const ty = to.y + to.height / 2;
    const mx = (fx + tx) / 2;
    const my = (fy + ty) / 2 - 36;
    return `<g><path d="M${fx},${fy} Q${mx},${my} ${tx},${ty}" fill="none" stroke="#f59e0b" stroke-width="1.8" stroke-dasharray="6 3" vector-effect="non-scaling-stroke"/>${relation.label ? `<text x="${mx}" y="${my - 6}" text-anchor="middle" font-size="11" fill="#b45309">${escapeXml(relation.label)}</text>` : ""}</g>`;
  }).join("");

  const nodes = snapshot.nodes.map((node) => {
    const color = colorForNode(node);
    const fontSize = node.depth === 0 ? 14 : 13;
    const fontWeight = node.depth === 0 ? 700 : 500;
    const textX = node.x + 13;
    const textY = node.y + node.height / 2 + 4.5;
    return `<g data-mindmap-node-id="${escapeXml(node.id)}"><title>${escapeXml(node.text)}</title><rect x="${node.x}" y="${node.y}" width="${node.width}" height="${node.height}" rx="11" fill="${color.bg}" stroke="${color.border}" stroke-width="1"/><text x="${textX}" y="${textY}" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" font-size="${fontSize}" font-weight="${fontWeight}" fill="${color.text}">${escapeXml(displayText(node))}</text></g>`;
  }).join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" class="${className}" data-nowen-mindmap-snapshot="1" role="img" aria-label="${title}" viewBox="${snapshot.viewBox}" preserveAspectRatio="xMidYMid meet" width="100%" height="100%">${background ? `<rect x="${snapshot.bounds.minX}" y="${snapshot.bounds.minY}" width="${snapshot.bounds.width}" height="${snapshot.bounds.height}" fill="${background}"/>` : ""}<title>${title}</title>${boundaries}${edges}${relations}${nodes}</svg>`;
}

export function parseMindMapSnapshotData(raw: string): MindMapData | null {
  try {
    const parsed = JSON.parse(raw) as MindMapData;
    if (!parsed?.root || !Array.isArray(parsed.root.children)) return null;
    return parsed;
  } catch {
    return null;
  }
}
