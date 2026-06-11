import { useState, useMemo, useCallback } from "react";
import type { Task, TaskFilter } from "@/types";
import { buildTaskTree, type TaskTreeNode } from "./taskProgress";

/**
 * 展平后的渲染项：包含树节点及其深度信息，
 * 用于 TaskTreeRow 做缩进渲染。
 */
export interface FlatTaskItem {
  node: TaskTreeNode;
  depth: number;
  /** 是否为最后一个子节点（用于可选的树线绘制） */
  isLastChild: boolean;
}

/**
 * 将树展平为渲染顺序列表，仅包含展开的节点。
 */
function flattenTree(
  nodes: TaskTreeNode[],
  expandedIds: Set<string>,
  depth = 0,
): FlatTaskItem[] {
  const result: FlatTaskItem[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const isLastChild = i === nodes.length - 1;
    result.push({ node, depth, isLastChild });
    if (node.children.length > 0 && expandedIds.has(node.id)) {
      result.push(...flattenTree(node.children, expandedIds, depth + 1));
    }
  }
  return result;
}

/**
 * 自定义 hook：管理树形任务的展开/折叠状态。
 *
 * - filter === "all" 时返回树形结构（flatOrderedTasks 带缩进）
 * - 其他 filter 返回平铺列表（flatOrderedTasks depth=0）
 */
export function useTaskTree(tasks: Task[], filter: TaskFilter) {
  const [expandedTaskIds, setExpandedTaskIds] = useState<Set<string>>(new Set());

  const toggleExpand = useCallback((id: string) => {
    setExpandedTaskIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const expandAll = useCallback(() => {
    setExpandedTaskIds(new Set(tasks.map((t) => t.id)));
  }, [tasks]);

  const collapseAll = useCallback(() => {
    setExpandedTaskIds(new Set());
  }, []);

  const isTreeMode = filter === "all";

  // 仅 "all" filter 构建树，其他保持平铺
  const tree = useMemo(() => {
    if (!isTreeMode) return [];
    return buildTaskTree(tasks);
  }, [tasks, isTreeMode]);

  // 展平为渲染列表
  const flatOrderedTasks = useMemo<FlatTaskItem[]>(() => {
    if (isTreeMode) {
      return flattenTree(tree, expandedTaskIds);
    }
    // 平铺模式：每个 task 作为 depth=0 的节点
    return tasks.map((t) => ({
      node: { ...t, children: [] },
      depth: 0,
      isLastChild: true,
    }));
  }, [tree, tasks, isTreeMode, expandedTaskIds]);

  return {
    flatOrderedTasks,
    expandedTaskIds,
    toggleExpand,
    expandAll,
    collapseAll,
    isTreeMode,
  };
}
