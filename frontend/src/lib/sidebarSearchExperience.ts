export const LEGACY_GLOBAL_SEARCH_SELECTOR = "[data-sidebar-search]";
export const KNOWLEDGE_TREE_FILTER_SELECTOR = "[data-knowledge-tree-search]";
export const SIDEBAR_SEARCH_SURFACE_SELECTOR =
  `${LEGACY_GLOBAL_SEARCH_SELECTOR},${KNOWLEDGE_TREE_FILTER_SELECTOR}`;

const RETIRED_MARKER = "sidebarSearchRetired";

function setNativeInputValue(input: HTMLInputElement, value: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
  if (descriptor?.set) {
    descriptor.set.call(input, value);
    return;
  }
  input.value = value;
}

function findInputs(root: ParentNode, selector: string): HTMLInputElement[] {
  const inputs = Array.from(root.querySelectorAll<HTMLInputElement>(selector));
  if (root instanceof HTMLInputElement && root.matches(selector)) {
    inputs.unshift(root);
  }
  return inputs;
}

/**
 * 收敛侧栏搜索入口：
 *
 * - 旧的“搜索笔记”输入框会切换全文搜索视图，与统一内容树筛选框紧邻后语义冲突；
 * - 全文搜索继续由 Cmd/Ctrl+K 命令面板和桌面端原生菜单承载；
 * - 内容树输入框只负责当前树节点过滤，并显式标注作用范围。
 *
 * 这里暂时保留旧输入节点供旧版 Sidebar 代码兼容，但从可见 UI 和键盘导航中退休。
 * Sidebar 后续拆除旧目录代码时，可以连同该兼容层一起删除。
 */
export function applySidebarSearchExperience(root: ParentNode = document): boolean {
  let changed = false;

  for (const legacyInput of findInputs(root, LEGACY_GLOBAL_SEARCH_SELECTOR)) {
    const row = legacyInput.parentElement?.parentElement;
    if (row instanceof HTMLElement && row.dataset.retiredSidebarSearchRow !== "true") {
      row.dataset.retiredSidebarSearchRow = "true";
      row.setAttribute("aria-hidden", "true");
      changed = true;
    }

    legacyInput.tabIndex = -1;
    legacyInput.setAttribute("aria-hidden", "true");

    if (legacyInput.dataset[RETIRED_MARKER] !== "true") {
      // 若升级发生在旧搜索仍有关键词的会话中，触发原有 React onChange，
      // 让 viewMode/searchQuery 一并回到默认状态，避免隐藏输入后无法退出搜索。
      if (legacyInput.value) {
        setNativeInputValue(legacyInput, "");
        legacyInput.dispatchEvent(new Event("input", { bubbles: true }));
      }
      legacyInput.dataset[RETIRED_MARKER] = "true";
      changed = true;
    }
  }

  for (const treeFilter of findInputs(root, KNOWLEDGE_TREE_FILTER_SELECTOR)) {
    const filterSurface = treeFilter.parentElement;
    if (
      filterSurface instanceof HTMLElement
      && filterSurface.dataset.treeFilterSurface !== "true"
    ) {
      filterSurface.dataset.treeFilterSurface = "true";
      changed = true;
    }
    if (treeFilter.placeholder !== "筛选目录与文档…") {
      treeFilter.placeholder = "筛选目录与文档…";
      changed = true;
    }
    if (treeFilter.getAttribute("aria-label") !== "筛选当前目录中的文件夹与文档") {
      treeFilter.setAttribute("aria-label", "筛选当前目录中的文件夹与文档");
      changed = true;
    }
    if (treeFilter.title !== "仅筛选当前内容树，不搜索笔记正文") {
      treeFilter.title = "仅筛选当前内容树，不搜索笔记正文";
      changed = true;
    }
    if (treeFilter.dataset.searchScope !== "tree") {
      treeFilter.dataset.searchScope = "tree";
      changed = true;
    }
  }

  return changed;
}
