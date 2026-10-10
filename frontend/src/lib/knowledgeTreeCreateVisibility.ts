export const KNOWLEDGE_TREE_CLEAR_SEARCH_EVENT = "nowen:knowledge-tree-clear-search";

export type KnowledgeTreeClearSearchDetail = {
  parentId?: string | null;
  nodeId?: string;
};

/** 文档创建成功后展开目标目录；传入新节点 ID 时，在刷新后定位并选中。 */
export function revealCreatedKnowledgeTreeNote(parentId?: string | null, nodeId?: string): void {
  window.dispatchEvent(new CustomEvent<KnowledgeTreeClearSearchDetail>(
    KNOWLEDGE_TREE_CLEAR_SEARCH_EVENT,
    { detail: { parentId, nodeId } },
  ));
}
