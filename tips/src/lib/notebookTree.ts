/**
 * 笔记本列表的整理工具。
 *
 * ⚠️ 两个易踩的点（都对着真实服务端核实过）：
 *
 * 1. **API 返回的是平铺数组 + parentId，不是嵌套树。**
 *    `backend/src/routes/notebooks.ts` 直接 `return c.json(rows)`，
 *    每行带 `parentId`。层级要自己按 parentId 算。
 *    （这里同时兼容带 children 的嵌套形状，免得以后接口变了就崩。）
 *
 * 2. **`noteCount` 是递归的** —— 父笔记本的计数**包含子孙笔记本**的笔记
 *    （服务端用 `WITH RECURSIVE nb_tree` 汇总）。
 *    所以「把所有可见笔记本的 noteCount 相加」会**重复计算**：
 *    父笔记本算了 1297，下面每个子笔记本又把其中的笔记再算一遍。
 *    要算「总共能看到的笔记数」，只能加**可见子树里最顶层**那些笔记本的计数。
 */
import type { Notebook } from "../../sdk/types";

export interface FlatNotebook {
  id: string;
  name: string;
  icon: string;
  /** 递归计数：含子孙笔记本的笔记（服务端口径） */
  noteCount: number;
  parentId: string | null;
  depth: number;
  sortOrder: number;
}

/** 展平并按层级计算 depth；同时兼容「平铺 + parentId」与「嵌套 children」两种形状 */
export function flattenNotebooks(list: Notebook[]): FlatNotebook[] {
  const byId = new Map<string, FlatNotebook>();

  const push = (nb: Notebook, depth: number, parentId: string | null) => {
    if (byId.has(nb.id)) return; // 防御：数据异常时别死循环
    byId.set(nb.id, {
      id: nb.id,
      name: nb.name || "未命名笔记本",
      icon: nb.icon || "📁",
      noteCount: nb.noteCount ?? 0,
      parentId: (nb.parentId ?? parentId ?? null) as string | null,
      depth,
      sortOrder: nb.sortOrder ?? 0,
    });
    for (const child of nb.children ?? []) push(child, depth + 1, nb.id);
  };

  for (const nb of list) push(nb, 0, null);

  // 有嵌套时 depth 已经算好；平铺形状要按 parentId 补算
  const flat = [...byId.values()];
  const depthOf = (nb: FlatNotebook, seen = new Set<string>()): number => {
    if (!nb.parentId || seen.has(nb.id)) return 0;
    const parent = byId.get(nb.parentId);
    if (!parent) return 0;
    seen.add(nb.id);
    return depthOf(parent, seen) + 1;
  };
  const hasNested = list.some((nb) => (nb.children?.length ?? 0) > 0);
  if (!hasNested) {
    for (const nb of flat) nb.depth = depthOf(nb);
  }

  return flat.sort((a, b) => {
    if (a.depth !== b.depth) return a.depth - b.depth;
    return a.sortOrder - b.sortOrder;
  });
}

/**
 * 「总共能看到的笔记数」。
 *
 * 因为 noteCount 是递归的，只有**可见子树的最顶层**笔记本才能计入 ——
 * 否则父笔记本与子笔记本会把同一批笔记算两遍。
 */
export function countVisibleNotes(flat: FlatNotebook[], hidden: Set<string>): number {
  const byId = new Map(flat.map((nb) => [nb.id, nb]));
  return flat.reduce((sum, nb) => {
    if (hidden.has(nb.id)) return sum;
    let parentId = nb.parentId;
    const seen = new Set<string>();
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId);
      if (hidden.has(parentId)) return sum; // 祖先被隐藏 → 这一支整体不计
      if (byId.has(parentId)) {
        parentId = byId.get(parentId)!.parentId;
      } else {
        break;
      }
    }
    // 祖先里有【可见】的，说明它已经被祖先算过 → 不重复加
    let pid = nb.parentId;
    const seen2 = new Set<string>();
    while (pid && !seen2.has(pid)) {
      seen2.add(pid);
      const parent = byId.get(pid);
      if (!parent) break;
      if (!hidden.has(pid)) return sum;
      pid = parent.parentId;
    }
    return sum + nb.noteCount;
  }, 0);
}
