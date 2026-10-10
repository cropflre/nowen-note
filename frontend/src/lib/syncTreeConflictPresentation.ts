import type { ConflictDetail } from "./syncLocalApi";

export const TREE_CONFLICT_TYPE = "knowledge_tree_node";

export function isTreeConflict(entityType: string): boolean {
  return entityType === TREE_CONFLICT_TYPE;
}

export function treeConflictAvailability(detail: Pick<ConflictDetail, "local" | "remote">):
  "local-only" | "remote-only" | "both" | "neither" {
  if (detail.local && detail.remote) return "both";
  if (detail.local) return "local-only";
  if (detail.remote) return "remote-only";
  return "neither";
}

/**
 * Structural baselines are distinct from note contents. A one-sided tree node
 * is not an "identical payload": it represents an unsynchronized dependency.
 */
export function treeConflictExplanation(detail: Pick<ConflictDetail, "local" | "remote">): string {
  switch (treeConflictAvailability(detail)) {
    case "local-only":
      return "仅本机有此知识树节点，云端结构尚未出现。可能是对应笔记本、笔记或思维导图尚未同步完成。暂勿覆盖，先检查同步状态。";
    case "remote-only":
      return "仅云端有此知识树节点，本机结构尚未出现。可能是本机业务资源或知识树快照尚未下载完成。暂勿覆盖，先检查同步状态。";
    case "neither":
      return "本机与云端均缺少完整知识树结构数据，暂时无法安全处理。请保留冲突记录并检查同步诊断。";
    case "both":
      return "双方都有知识树节点，差异通常涉及所在目录、排序或删除状态，不代表笔记正文冲突。";
  }
}

export const TREE_CONFLICT_FIELDS = [
  ["resourceType", "资源类型"],
  ["resourceId", "业务资源 ID"],
  ["nodeType", "节点类型"],
  ["parentId", "父目录"],
  ["sortOrder", "排序位置"],
  ["isDeleted", "是否删除"],
  ["deletedAt", "删除时间"],
] as const;

export function canSafelyChooseTreeSide(
  detail: Pick<ConflictDetail, "local" | "remote"> | null | undefined,
): boolean {
  if (!detail) return false;
  // Knowledge-tree apply needs the existing cloud baseline for a local CAS
  // and an already replicated business resource. Never offer one-click
  // replacement while either structural side is missing.
  return treeConflictAvailability(detail) === "both";
}
