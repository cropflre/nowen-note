export const SIDEBAR_TREE_INDENT = 28;
export const SIDEBAR_TREE_ROW_BASE_WIDTH = 220;

export function sidebarTreeRowMinWidth(depth: number): number {
  return SIDEBAR_TREE_ROW_BASE_WIDTH + Math.max(0, depth) * SIDEBAR_TREE_INDENT;
}

export function sidebarTreeContentMinWidth(maxDepth: number): number {
  return sidebarTreeRowMinWidth(maxDepth);
}
