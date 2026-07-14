export const SIDEBAR_TREE_INDENT = 10;
export const SIDEBAR_TREE_ROOT_PADDING = 8;
export const SIDEBAR_TREE_CHILD_BASE_PADDING = 12;
export const MOBILE_SIDEBAR_TREE_INDENT = 4;
export const MOBILE_SIDEBAR_TREE_CHILD_BASE_PADDING = 4;
export const SIDEBAR_TREE_LABEL_RESERVE_WIDTH = 120;
export const SIDEBAR_TREE_ROW_CHROME_WIDTH = 78;
export const SIDEBAR_TREE_COUNT_RESERVE_WIDTH = 30;
export const SIDEBAR_TREE_ROW_BASE_WIDTH = SIDEBAR_TREE_LABEL_RESERVE_WIDTH + SIDEBAR_TREE_ROW_CHROME_WIDTH + SIDEBAR_TREE_COUNT_RESERVE_WIDTH;

export function sidebarTreeRowMinWidth(depth: number): number {
  return SIDEBAR_TREE_ROW_BASE_WIDTH + depth * SIDEBAR_TREE_INDENT;
}

export function sidebarTreeContentMinWidth(maxDepth: number): number {
  return sidebarTreeRowMinWidth(maxDepth);
}

export function sidebarNotebookPaddingLeft(depth: number, compact = false): number {
  if (compact) {
    return MOBILE_SIDEBAR_TREE_CHILD_BASE_PADDING + depth * MOBILE_SIDEBAR_TREE_INDENT;
  }
  return depth === 0
    ? SIDEBAR_TREE_ROOT_PADDING
    : SIDEBAR_TREE_CHILD_BASE_PADDING + depth * SIDEBAR_TREE_INDENT;
}

export function sidebarNotebookRowPaddingY(compact = false): number {
  return compact ? 2 : 6;
}

export function sidebarNotebookShowsDragHandle(compact = false): boolean {
  return !compact;
}

export function sidebarNotebookDisclosureChrome(compact = false): { size: number; gap: number } {
  return compact ? { size: 14, gap: 0 } : { size: 18, gap: 4 };
}
