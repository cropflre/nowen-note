import type { Task } from "@/types";

/**
 * 树形任务节点：在 Task 基础上扩展 children 数组。
 * children 为空数组时表示叶子节点。
 */
export type TaskTreeNode = Task & { children: TaskTreeNode[] };

/**
 * 将平铺的 Task[] 构建为树形结构。
 *
 * 规则：
 *   - parentId 为空的作为根节点
 *   - 子节点按 parentId 挂载到对应父节点
 *   - 找不到父节点的孤儿任务归入根节点列表（防御性处理）
 *   - 循环 parentId 防护：通过 ancestor chain 检测，防止 A→B→C→A 类深层循环
 *   - 同层节点保持原数组顺序（后端已排好序）
 */
export function buildTaskTree(tasks: Task[]): TaskTreeNode[] {
  const map = new Map<string, TaskTreeNode>();
  for (const t of tasks) {
    map.set(t.id, { ...t, children: [] });
  }

  // 已被挂载为某个父节点 child 的 id 集合
  const attached = new Set<string>();

  // 检测将 child 挂载到 parent 时是否形成循环：
  // 沿 parent 向上遍历 ancestor chain，如果遇到 child.id 则说明会形成环
  const wouldCreateCycle = (childId: string, parentId: string): boolean => {
    let current: string | null = parentId;
    const visited = new Set<string>();
    while (current && map.has(current)) {
      if (current === childId) return true;
      if (visited.has(current)) break; // 已有其他循环，终止
      visited.add(current);
      const node = map.get(current)!;
      current = node.parentId;
    }
    return false;
  };

  const roots: TaskTreeNode[] = [];

  for (const t of tasks) {
    const node = map.get(t.id)!;
    if (t.parentId && map.has(t.parentId) && t.parentId !== t.id && !attached.has(t.id)) {
      // 循环防护：检查挂载后是否形成环
      if (!wouldCreateCycle(t.id, t.parentId)) {
        map.get(t.parentId)!.children.push(node);
        attached.add(t.id);
      }
      // 形成循环则作为根节点处理（fall through）
    }
    if (!attached.has(t.id)) {
      roots.push(node);
    }
  }

  return roots;
}

/**
 * 计算单个任务节点的进度。
 *
 * 规则：
 *   - 无子任务：isCompleted=1 → 100，否则 → 0
 *   - 有子任务：递归计算所有子任务进度的平均值
 *   - 返回百分比整数（0-100）
 *   - 基于完整子树计算，不受展开/折叠状态影响
 */
export function calculateTaskProgress(node: TaskTreeNode): {
  progress: number;
  completedChildren: number;
  totalChildren: number;
} {
  if (node.children.length === 0) {
    return {
      progress: node.isCompleted === 1 ? 100 : 0,
      completedChildren: 0,
      totalChildren: 0,
    };
  }

  let sum = 0;
  let completed = 0;
  for (const child of node.children) {
    sum += calculateTaskProgress(child).progress;
    if (child.isCompleted === 1) completed++;
  }

  return {
    progress: Math.round(sum / node.children.length),
    completedChildren: completed,
    totalChildren: node.children.length,
  };
}
