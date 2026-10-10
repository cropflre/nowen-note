/**
 * 「文件夹排布」视图的数据整理。
 *
 * 为什么单独一个文件：笔记流有两种排布（扁平 / 文件夹），
 * 两者的**数据来源完全相同**（同一份 notes + notebooks + 隐藏名单 + 关键词），
 * 差别只在怎么组织。把组织逻辑抽成纯函数，屏幕组件只负责画。
 *
 * ⚠️ 三个对着真实数据踩过的点：
 *
 * 1. **`noteCount` 是递归的，不能用它当"本层笔记数"**。
 *    服务端用 `WITH RECURSIVE nb_tree` 汇总，父笔记本的 noteCount 已经把子孙算进去了
 *    （见 notebookTree.ts 的注释）。所以这里**全部按手里的 notes 现算**，
 *    服务端那个字段一个都不信 —— 否则 1291 篇的「小米云笔记」和它上面的「归档」
 *    会各显示 1291，加起来像有 2582 篇。
 *
 * 2. **笔记本可能没有笔记，笔记也可能没有笔记本**。
 *    - 空笔记本：实测你的库有 32 个全空（导入产生的中转壳）。
 *      文件夹视图里必须**剪掉**，否则 33 行里有 6 行点不开、纯噪音。
 *    - 孤儿笔记：`notebookId` 指向一个不存在的笔记本（父本被删、数据异常）。
 *      扁平视图会把它们显示出来，文件夹视图也**不能丢** —— 兜到一个「未归类」分组。
 *
 * 3. **父笔记本被隐藏 ≠ 子孙被隐藏**。扁平视图的过滤条件是
 *    `hidden.includes(note.notebookId)`，只认自己那一层。
 *    文件夹视图必须用**同一套语义**，不然两个视图看到的条数对不上。
 */
import type { NoteSummary } from "../../sdk/types";
import type { FlatNotebook } from "./notebookTree";

/** 未归类笔记的分组 id（不会和真实笔记本 uuid 冲突） */
export const UNCLASSIFIED_ID = "__unclassified__";

export interface FolderNode {
  id: string;
  name: string;
  icon: string;
  /** 层级：顶层 0，用来算缩进 */
  depth: number;
  /** 直接挂在本笔记本下的（已过滤的）笔记 */
  notes: NoteSummary[];
  /** 含子孙在内的（已过滤的）笔记数 —— 折叠时显示这个 */
  total: number;
  children: FolderNode[];
}

export interface NotebookFolders {
  tree: FolderNode[];
  /** 没有对应笔记本的笔记 */
  unclassified: NoteSummary[];
  /** 两个视图共用的总条数（= 扁平视图列表长度） */
  totalVisible: number;
}

/**
 * 把笔记按笔记本层级组织成树。
 *
 * @param flat    展平后的笔记本（notebookTree.flattenNotebooks 的输出）
 * @param notes   已经过「隐藏 + 关键词」过滤的笔记
 * @returns       树 + 未归类 + 总数
 */
export function buildNotebookFolders(
  flat: FlatNotebook[],
  notes: NoteSummary[],
): NotebookFolders {
  const known = new Set(flat.map((nb) => nb.id));

  // 1) 按笔记本分组；认不出笔记本的进「未归类」
  const grouped = new Map<string, NoteSummary[]>();
  const unclassified: NoteSummary[] = [];
  for (const note of notes) {
    if (!known.has(note.notebookId)) {
      unclassified.push(note);
      continue;
    }
    const bucket = grouped.get(note.notebookId);
    if (bucket) bucket.push(note);
    else grouped.set(note.notebookId, [note]);
  }

  // 2) 建节点（先全部建出来，再算计数、再剪枝）
  const nodes = new Map<string, FolderNode>();
  for (const nb of flat) {
    nodes.set(nb.id, {
      id: nb.id,
      name: nb.name,
      icon: nb.icon || "📁",
      depth: nb.depth,
      notes: grouped.get(nb.id) ?? [],
      total: 0,
      children: [],
    });
  }

  // 3) 连父子。父不在列表里（父本被删/被隐藏）→ 当顶层，避免整支消失
  const roots: FolderNode[] = [];
  for (const nb of flat) {
    const node = nodes.get(nb.id)!;
    const parent = nb.parentId ? nodes.get(nb.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  // 4) 递归计数（因为 notebookCount 不可信，全部现算）
  const countUp = (node: FolderNode): number => {
    node.total = node.notes.length + node.children.reduce((sum, c) => sum + countUp(c), 0);
    return node.total;
  };
  for (const node of roots) countUp(node);

  // 5) 剪枝：一个可见笔记都没有的分支整支去掉（实测 32 个空笔记本全靠这一步消失）
  const prune = (list: FolderNode[]): FolderNode[] =>
    list
      .filter((node) => node.total > 0)
      .map((node) => ({ ...node, children: prune(node.children) }));

  const tree = prune(roots);

  // 6) 剪枝后 depth 可能与实际渲染层级不符（父被剪掉、自己顶上来）——
  //    重算一次，否则缩进会跳。
  const fixDepth = (list: FolderNode[], depth: number): void => {
    for (const node of list) {
      node.depth = depth;
      fixDepth(node.children, depth + 1);
    }
  };
  fixDepth(tree, 0);

  return { tree, unclassified, totalVisible: notes.length };
}
